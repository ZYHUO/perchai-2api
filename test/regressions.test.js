"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { buildApp } = require("../src/server");
const { readEnv } = require("../src/config");
const { rawRequest, readResBody, agents } = require("../src/session");
const { login, startCallbackServer } = require("../src/login");
const { Semaphore } = require("../src/limiter");

after(() => Object.values(agents).forEach((agent) => agent.destroy()));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function stop(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

async function fixture(t, handler, overrides = {}) {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/api/perch-terminal/turn-ticket") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ticket: "ticket", ticketId: "tid", runId: "rid", expiresAt: new Date(Date.now() + 600000).toISOString() }));
        return;
      }
      Promise.resolve(handler(req, res)).catch((e) => res.destroy(e));
    });
  });
  const appUrl = await listen(upstream);
  const proxy = buildApp({ ...readEnv(), backend: "http", appUrl, defaultToken: "test-token", clientKey: "test-key", accounts: [], logLevel: 0, connectTimeoutMs: 1000, totalTimeoutMs: 2000, idleTimeoutMs: 1000, ...overrides });
  const url = await listen(proxy);
  t.after(async () => { await stop(proxy); await stop(upstream); });
  return { appUrl, url, proxy, upstream };
}

const headers = { Authorization: "Bearer test-key", "Content-Type": "application/json" };
const chat = (url, extra = {}, options = {}) => fetch(`${url}/v1/chat/completions`, {
  method: "POST", headers, body: JSON.stringify({ messages: [{ role: "user", content: "test" }], ...extra }),
  signal: AbortSignal.timeout(2500), ...options,
});
const events = (text) => text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
const event = (data) => `data: ${JSON.stringify(data)}\n\n`;

test("models reject absent and invalid client keys", { timeout: 3000 }, async (t) => {
  const { url } = await fixture(t, (_, res) => res.end('{"ok":true}'));
  for (const auth of [undefined, "Bearer wrong"]) {
    const r = await fetch(`${url}/v1/models`, { headers: auth ? { Authorization: auth } : {} });
    assert.equal(r.status, 401);
    await r.arrayBuffer();
  }
});

test("fresh file sessions authenticate usage and embeddings on the first request", { timeout: 3000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perch-regression-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionPath = path.join(dir, "session.json");
  const { url, appUrl } = await fixture(t, (req, res) => {
    if (req.headers.authorization !== "Bearer file-token") { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify({ ok: true, embeddings: [[1, 2]], meter: { dailyPt: 1 } }));
  }, { defaultToken: null, defaultSessionPath: sessionPath });
  fs.writeFileSync(sessionPath, JSON.stringify({ version: 1, appUrl, accessToken: "file-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
  const usage = await fetch(`${url}/v1/usage`, { headers });
  assert.equal(usage.status, 200);
  await usage.arrayBuffer();
  const embedding = await fetch(`${url}/v1/embeddings`, { method: "POST", headers, body: '{"input":"hello"}' });
  assert.equal(embedding.status, 200);
  await embedding.arrayBuffer();
});

test("upstream connection failure returns 502 without hanging", { timeout: 3500 }, async (t) => {
  const { url } = await fixture(t, (_, res) => res.destroy());
  const r = await chat(url);
  assert.equal(r.status, 502);
  await r.arrayBuffer();
});

test("upstream 401 with an unrefreshable token returns its error body", { timeout: 3500 }, async (t) => {
  const { url } = await fixture(t, (_, res) => { res.writeHead(401); res.end('{"error":"expired","errorCode":"not_authenticated"}'); });
  const r = await chat(url);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.message, "expired");
});

test("total timeout remains active while the response body arrives", { timeout: 3000 }, async (t) => {
  const { appUrl } = await fixture(t, (_, res) => {
    res.writeHead(200);
    res.write('"');
    const timer = setInterval(() => res.write("a"), 20);
    res.on("close", () => clearInterval(timer));
  });
  const res = await rawRequest(`${appUrl}/trickle`, { totalTimeoutMs: 100, connectTimeoutMs: 500 });
  await assert.rejects(readResBody(res), /timeout|aborted/);
});

test("an already aborted request never reaches the upstream", { timeout: 3000 }, async (t) => {
  let requests = 0;
  const { appUrl } = await fixture(t, (_, res) => { requests++; res.end('{}'); });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(rawRequest(appUrl, { signal: ac.signal }), { name: "AbortError" });
  assert.equal(requests, 0);
});

test("abort remains attached after upstream response headers", { timeout: 3000 }, async (t) => {
  const { appUrl } = await fixture(t, (_, res) => { res.writeHead(200); res.write('{'); });
  const ac = new AbortController();
  const res = await rawRequest(appUrl, { signal: ac.signal, connectTimeoutMs: 1000 });
  const body = readResBody(res);
  const started = Date.now();
  ac.abort();
  await assert.rejects(body, /abort/i);
  assert.ok(Date.now() - started < 500, "abort must not wait for a socket timeout");
});

test("stream preserves UTF-8 characters split between network chunks", { timeout: 3000 }, async (t) => {
  const { url } = await fixture(t, async (_, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const bytes = Buffer.from(event({ type: "answer_delta", text: "你好🙂" }));
    const cut = bytes.indexOf(Buffer.from("你")) + 1;
    res.write(bytes.subarray(0, cut));
    await delay(25);
    res.write(bytes.subarray(cut));
    res.end(event({ type: "done", ok: true }));
  });
  const r = await chat(url, { stream: true });
  const chunks = events(await r.text());
  assert.equal(chunks.map((c) => c.choices?.[0]?.delta?.content || "").join(""), "你好🙂");
});

test("cancellation before a body reader is attached does not crash or hang", { timeout: 3000 }, async (t) => {
  const { appUrl } = await fixture(t, (_, res) => { res.writeHead(200); res.write('{'); });
  const ac = new AbortController();
  const res = await rawRequest(appUrl, { signal: ac.signal, totalTimeoutMs: 2000 });
  ac.abort();
  await delay(20);
  await assert.rejects(readResBody(res), /abort/i);
});

test("repeated tool snapshots produce one complete tool call", { timeout: 3000 }, async (t) => {
  const { url } = await fixture(t, (_, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(event({ type: "tool_call_delta", toolCalls: [{ id: "call_1", name: "weather", arguments: { city: "pa" } }] }));
    res.write(event({ type: "tool_use_end", toolCalls: [{ id: "call_1", name: "weather", arguments: { city: "paris" }, sealed: true }] }));
    res.end(event({ type: "done", ok: true, toolCalls: [{ id: "call_1", name: "weather", arguments: { city: "paris" } }] }));
  });
  const r = await chat(url, { stream: true });
  const chunks = events(await r.text());
  const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(new Set(calls.map((c) => c.index)).size, 1);
  assert.deepEqual(JSON.parse(calls.map((c) => c.function.arguments || "").join("")), { city: "paris" });
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("SSE without a done event reports an interrupted response", { timeout: 3000 }, async (t) => {
  const { url } = await fixture(t, (_, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(event({ type: "answer_delta", text: "partial" }));
  });
  const r = await chat(url, { stream: true });
  assert.ok(events(await r.text()).some((c) => c.error?.code === "upstream_error"));
});

test("disconnecting a streaming client closes upstream and frees its slot", { timeout: 3000 }, async (t) => {
  let closed;
  const upstreamClosed = new Promise((resolve) => { closed = resolve; });
  const { url } = await fixture(t, (_, res) => {
    res.on("close", closed);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(event({ type: "answer_delta", text: "hello" }));
  }, { maxConcurrency: 1 });
  const ac = new AbortController();
  const r = await chat(url, { stream: true }, { signal: ac.signal });
  await r.body.getReader().read();
  ac.abort();
  await Promise.race([upstreamClosed, delay(500).then(() => { throw new Error("upstream stayed open"); })]);
  const health = await fetch(`${url}/healthz`, { headers }).then((r) => r.json());
  assert.equal(health.accounts[0].activeRequests, 0);
  assert.equal(health.accounts[0].concurrencyDepth, 0);
});

test("anonymous health checks do not reveal account paths", { timeout: 3000 }, async (t) => {
  const { url } = await fixture(t, (_, res) => res.end('{}'));
  const health = await fetch(`${url}/healthz`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.accounts, undefined);
});

test("model request runId matches the acquired turn ticket", { timeout: 3000 }, async (t) => {
  let sentBody;
  const { url, upstream } = await fixture(t, (_, res) => res.end('{"ok":true,"text":"ok"}'));
  upstream.on("request", (req) => {
    if (req.url.endsWith("model-call")) {
      let text = "";
      req.on("data", (c) => { text += c; });
      req.on("end", () => { sentBody = JSON.parse(text); });
    }
  });
  await (await chat(url)).arrayBuffer();
  assert.equal(sentBody.runId, "rid");
});

test("retryable responses free their socket before retrying", { timeout: 3000 }, async (t) => {
  let attempts = 0;
  let oldClosed = false;
  const { url } = await fixture(t, (_, res) => {
    attempts++;
    if (attempts === 1) {
      res.on("close", () => { oldClosed = true; });
      res.writeHead(503);
      res.write('{');
    } else res.end('{"ok":true,"text":"retried"}');
  }, { upstreamSockets: 1 });
  const r = await chat(url);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, "retried");
  assert.equal(attempts, 2);
  assert.equal(oldClosed, true);
});

test("the selected default model is placed first even if already listed", { timeout: 3000 }, async (t) => {
  const { url } = await fixture(t, (_, res) => res.end('{"ok":true,"selection":"gpt-6-astra"}'));
  const r = await fetch(`${url}/v1/models`, { headers });
  const data = (await r.json()).data;
  assert.equal(data[0].id, "gpt-6-astra");
  assert.equal(data[0].default, true);
  assert.equal(data.filter((m) => m.id === "gpt-6-astra").length, 1);
});

test("semaphore transfers slots to queued work without oversubscription", { timeout: 3000 }, async () => {
  const sem = new Semaphore(1);
  const release1 = await sem.acquire();
  const queued = sem.acquire();
  release1();
  const newcomer = sem.acquire();
  const release2 = await queued;
  assert.equal(sem.active, 1);
  assert.equal(sem.depth, 1);
  release2();
  const release3 = await newcomer;
  release3();
  assert.equal(sem.active, 0);
});

test("OAuth login accepts a flat Supabase token response", { timeout: 3000 }, async (t) => {
  let appUrl;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.url.includes("cli-auth/config")
        ? { ok: true, supabaseUrl: appUrl, supabaseAnonKey: "anon", providers: ["github"], redirectHost: "127.0.0.1" }
        : { access_token: "access", refresh_token: "refresh", expires_in: 3600, user: { id: "u1" } }));
    });
  });
  appUrl = await listen(server);
  t.after(() => stop(server));
  const { session } = await login({ appUrl, openBrowserExternal: async (url) => {
    const redirect = new URL(url).searchParams.get("redirect_to");
    const r = await fetch(`${redirect}?code=test-code`);
    await r.arrayBuffer();
    return true;
  } });
  assert.equal(session.accessToken, "access");
  assert.ok(session.expiresAt > Date.now() / 1000 + 3500);
});

test("OAuth callback ignores unrelated browser requests", { timeout: 3000 }, async (t) => {
  const { server, port, codePromise } = await startCallbackServer({ timeoutMs: 1000 });
  codePromise.catch(() => {});
  t.after(() => stop(server));
  const r = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
  assert.equal(r.status, 404);
  const cb = await fetch(`http://127.0.0.1:${port}/callback?code=valid-code`);
  await cb.arrayBuffer();
  assert.equal(await codePromise, "valid-code");
});
