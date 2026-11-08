"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { buildApp } = require("../src/server");
const { Account } = require("../src/session");
const { readEnv } = require("../src/config");
const { prepareCliRequest, runCliChat } = require("../src/cli");

async function fixture(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-adapter-test-"));
  const sessionPath = path.join(dir, "cli-auth-session.json");
  await fs.writeFile(sessionPath, JSON.stringify({ version: 1, appUrl: "http://127.0.0.1:1", accessToken: "fake-token" }), { mode: 0o600 });
  const cfg = { ...readEnv(), backend: "cli", appUrl: "http://127.0.0.1:1", accounts: [], defaultToken: null, defaultSessionPath: sessionPath, clientKey: "key", cliEntry: path.join(__dirname, "fixtures", "fake-cli.cjs"), cliTimeoutMs: 3000, cliMaxConcurrency: 1, logLevel: 0, ...extra };
  const app = buildApp(cfg);
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(async () => { app.closeAllConnections(); await new Promise((r) => app.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  const account = new Account({ appUrl: cfg.appUrl, sessionPath });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (body, options = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000), ...options });
  return { cfg, account, base, request, dir };
}

test("CLI text completion maps the actual model and total/cached token usage", async (t) => {
  const { request } = await fixture(t);
  const res = await request({ model: "standard", messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "你好" }] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.model, "mock-cli-model");
  assert.deepEqual(data.usage, { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33, prompt_tokens_details: { cached_tokens: 20 } });
  const reply = JSON.parse(data.choices[0].message.content);
  assert.match(reply.prompt, /你好/);
  assert.equal(reply.inheritedClientKey, false);
  await assert.rejects(fs.access(reply.cwd));
});

test("CLI requests get separate workspaces and pass prompts as data", async (t) => {
  const { request, dir } = await fixture(t);
  const marker = path.join(dir, "must-not-exist");
  const text = `--app-url http://evil.invalid $(touch ${marker}) ; touch ${marker}`;
  const responses = [];
  for (let i = 0; i < 2; i++) {
    const res = await request({ messages: [{ role: "user", content: text }] });
    assert.equal(res.status, 200);
    responses.push(JSON.parse((await res.json()).choices[0].message.content));
  }
  assert.notEqual(responses[0].cwd, responses[1].cwd);
  assert.ok(responses[0].prompt.includes(text));
  await assert.rejects(fs.access(marker));
});

test("CLI SSE is marked buffered and terminates with a separate usage chunk", async (t) => {
  const { request } = await fixture(t);
  const res = await request({ messages: [{ role: "user", content: "hello" }], stream: true, stream_options: { include_usage: true } });
  assert.equal(res.headers.get("x-perch-stream-mode"), "buffered");
  const text = await res.text();
  assert.ok(text.endsWith("data: [DONE]\n\n"));
  const chunks = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks[1].choices[0].finish_reason, "stop");
  assert.deepEqual(chunks[2].choices, []);
  assert.equal(chunks[2].usage.total_tokens, 33);
});

test("CLI unsupported features are rejected before spawning a process", async (t) => {
  const { request, base } = await fixture(t, { cliEntry: "/does/not/exist" });
  for (const extra of [{ tools: [] }, { max_tokens: 10 }, { temperature: 0 }, { response_format: { type: "json_object" } }]) {
    const res = await request({ messages: [{ role: "user", content: "hi" }], ...extra });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "unsupported_parameter");
  }
  const embedding = await fetch(base + "/v1/embeddings", { method: "POST", headers: { Authorization: "Bearer key" } });
  assert.equal(embedding.status, 501);
  await embedding.arrayBuffer();
  const usage = await fetch(base + "/v1/usage", { headers: { Authorization: "Bearer key" } });
  assert.equal(usage.status, 501);
  await usage.arrayBuffer();
});

test("CLI models report tiers without requiring the internal model endpoint", async (t) => {
  const { base } = await fixture(t);
  const res = await fetch(base + "/v1/models", { headers: { Authorization: "Bearer key" } });
  assert.deepEqual((await res.json()).data.map((m) => m.id), ["auto", "standard", "standard max", "pro", "pro max"]);
});

test("CLI timeout kills the process, cleans its directory and frees concurrency", { timeout: 5000 }, async (t) => {
  const { cfg, account, dir } = await fixture(t, { cliTimeoutMs: 300 });
  const marker = path.join(dir, "process.json");
  await assert.rejects(runCliChat(account, prepareCliRequest({ messages: [{ role: "user", content: `__slow__ marker=${marker}` }] }), { cfg }), { code: "cli_timeout", status: 504 });
  const state = JSON.parse(await fs.readFile(marker, "utf8"));
  assert.throws(() => process.kill(state.pid, 0), { code: "ESRCH" });
  await assert.rejects(fs.access(state.cwd));
  assert.equal(account.cliSemaphore.active, 0);
});

test("CLI cancellation kills active work and removes queued work", { timeout: 5000 }, async (t) => {
  const { cfg, account, dir } = await fixture(t);
  const marker = path.join(dir, "process.json");
  const firstAbort = new AbortController();
  const first = runCliChat(account, prepareCliRequest({ messages: [{ role: "user", content: `__slow__ marker=${marker}` }] }), { cfg, signal: firstAbort.signal });
  first.catch(() => {});
  for (let i = 0; i < 100; i++) { if (await fs.access(marker).then(() => true, () => false)) break; await delay(10); }
  const state = JSON.parse(await fs.readFile(marker, "utf8"));
  const queuedAbort = new AbortController();
  const queued = runCliChat(account, prepareCliRequest({ messages: [{ role: "user", content: "queued" }] }), { cfg, signal: queuedAbort.signal });
  queued.catch(() => {});
  queuedAbort.abort();
  await assert.rejects(queued, { name: "AbortError" });
  firstAbort.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.throws(() => process.kill(state.pid, 0), { code: "ESRCH" });
  assert.equal(account.cliSemaphore.active, 0);
  assert.equal(account.cliSemaphore.depth, 0);
});

test("CLI errors do not expose raw diagnostics", async (t) => {
  const { request } = await fixture(t);
  for (const content of ["__bad_json__", "__failure__"]) {
    const res = await request({ messages: [{ role: "user", content }] });
    assert.equal(res.status, 502);
    assert.doesNotMatch(await res.text(), /sensitive account diagnostics/);
  }
});
