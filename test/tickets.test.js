"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { buildApp } = require("../src/server");
const { readEnv } = require("../src/config");
const { agents } = require("../src/session");

after(() => Object.values(agents).forEach((a) => a.destroy()));

async function fixture(t, ticketHandler) {
  const calls = { tickets: 0, models: 0 };
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("turn-ticket")) { calls.tickets++; ticketHandler(req, res, calls); }
      else if (req.url.endsWith("model-call")) { calls.models++; res.end('{"ok":true,"text":"ok"}'); }
      else { res.writeHead(404); res.end('{}'); }
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = buildApp({ ...readEnv(), backend: "http", accounts: [], appUrl: `http://127.0.0.1:${upstream.address().port}`, defaultToken: "token", clientKey: "key", logLevel: 0 });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const server of [proxy, upstream]) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  });
  const request = () => fetch(`http://127.0.0.1:${proxy.address().port}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }), signal: AbortSignal.timeout(2000),
  });
  return { request, calls };
}

test("surface denial preserves the ticket error and suppresses model calls and repeat attempts", async (t) => {
  const { request, calls } = await fixture(t, (_, res) => { res.writeHead(403); res.end('{"ok":false,"error":"CLI surface required","errorCode":"perch_surface_required"}'); });
  for (let i = 0; i < 2; i++) {
    const res = await request();
    assert.equal(res.status, 403);
    assert.deepEqual((await res.json()).error, { message: "CLI surface required", type: "perch_proxy_error", code: "perch_surface_required", stage: "turn_ticket", upstream_status: 403 });
  }
  assert.deepEqual(calls, { tickets: 1, models: 0 });
});

test("ticket rate limits preserve Retry-After and never start a model request", async (t) => {
  const { request, calls } = await fixture(t, (_, res) => { res.writeHead(429, { "Retry-After": "7" }); res.end('{"ok":false,"error":"wait","errorCode":"turn_rate_limited"}'); });
  const res = await request();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "7");
  assert.equal((await res.json()).error.code, "turn_rate_limited");
  assert.equal(calls.models, 0);
});

test("ticket authentication failure stays 401 when the token cannot refresh", async (t) => {
  const { request, calls } = await fixture(t, (_, res) => { res.writeHead(401); res.end('{"ok":false,"error":"expired","errorCode":"not_authenticated"}'); });
  const res = await request();
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.stage, "turn_ticket");
  assert.equal(calls.models, 0);
});

test("ticket server failures do not degrade to unauthenticated model calls", async (t) => {
  const { request, calls } = await fixture(t, (_, res) => { res.writeHead(503); res.end('{"ok":false,"error":"ticket service unavailable"}'); });
  const res = await request();
  assert.equal(res.status, 502);
  const error = (await res.json()).error;
  assert.equal(error.upstream_status, 503);
  assert.equal(error.code, "turn_ticket_unavailable");
  assert.equal(calls.models, 0);
});

for (const ticket of [{ ok: true }, { ok: true, ticket: "t", ticketId: "tid", runId: "rid", expiresAt: "2000-01-01T00:00:00Z" }]) {
  test(`incomplete or expired tickets block the model (${ticket.ticket ? "expired" : "missing"})`, async (t) => {
    const { request, calls } = await fixture(t, (_, res) => res.end(JSON.stringify(ticket)));
    const res = await request();
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "turn_ticket_unavailable");
    assert.equal(calls.models, 0);
  });
}

test("ticket renewal denial cannot reuse the previous ticket", async (t) => {
  const { request, calls } = await fixture(t, (_, res, calls) => {
    if (calls.tickets === 1) res.end(JSON.stringify({ ok: true, ticket: "t", ticketId: "tid", runId: "rid", expiresAt: new Date(Date.now() + 10000).toISOString() }));
    else { res.writeHead(403); res.end('{"ok":false,"error":"denied","errorCode":"perch_surface_required"}'); }
  });
  const first = await request();
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  const second = await request();
  assert.equal(second.status, 403);
  await second.arrayBuffer();
  assert.deepEqual(calls, { tickets: 2, models: 1 });
});
