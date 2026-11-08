"use strict";
// End-to-end tests: real HTTP against the proxy, backed by the mock Perch upstream.
// Run: node --test test/

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMockServer } = require("./mock-upstream");
const { buildApp } = require("../src/server");

let mock;
let proxyA; // single account via env token + PERCH_2API_KEY, maxConcurrency=2
let proxyB; // multi-account via PERCH_ACCOUNTS

function listen(app) {
  return new Promise((resolve) => {
    app.listen(0, "127.0.0.1", () => resolve(app.address().port));
  });
}

function close(app) {
  return new Promise((resolve) => app.close(resolve));
}

const baseCfg = (mockUrl, extra = {}) => ({
  appUrl: mockUrl,
  port: 0,
  host: "127.0.0.1",
  defaultToken: null,
  defaultSessionPath: null,
  accounts: [],
  clientKey: null,
  allowAny: false,
  maxConcurrency: 4,
  rpm: 0,
  connectTimeoutMs: 5000,
  idleTimeoutMs: 5000,
  totalTimeoutMs: 30000,
  ticketTimeoutMs: 3000,
  maxBodyBytes: 32 * 1024 * 1024,
  upstreamSockets: 8,
  userAgent: "perchai-cli/2.4.125 (test)",
  logLevel: 0,
  ...extra,
});

before(async () => {
  mock = await createMockServer();

  const cfgA = baseCfg(mock.url, {
    defaultToken: "test-token",
    clientKey: "sk-a",
    maxConcurrency: 2,
  });
  proxyA = buildApp(cfgA);
  await listen(proxyA);

  const sessPath = path.join(os.tmpdir(), `perch-sess-${Date.now()}.json`);
  fs.writeFileSync(
    sessPath,
    JSON.stringify({
      version: 1,
      appUrl: mock.url,
      accessToken: "acct2-token",
      refreshToken: null,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      userId: "u2",
      email: "acct2@example.com",
      updatedAt: new Date().toISOString(),
    }),
  );
  const cfgB = baseCfg(mock.url, {
    accounts: [{ key: "sk-b1", sessionPath: sessPath }],
  });
  proxyB = buildApp(cfgB);
  await listen(proxyB);
});

after(async () => {
  await close(proxyA);
  await close(proxyB);
  await mock.close();
});

const post = async (port, p, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return r;
};

// ---------------------------------------------------------------- basics

test("healthz reports configured session", async () => {
  const r = await fetch(`http://127.0.0.1:${proxyA.address().port}/healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.service, "perchai-2api");
});

test("wrong API key is rejected (single-account with PERCH_2API_KEY)", async () => {
  const r = await post(proxyA.address().port, "/v1/chat/completions", {
    model: "gpt-6.1-sol",
    messages: [{ role: "user", content: "hi" }],
  }, { Authorization: "Bearer wrong" });
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.error.code, "invalid_api_key");
});

test("GET /v1/models lists models with account default first", async () => {
  const r = await fetch(`http://127.0.0.1:${proxyA.address().port}/v1/models`, {
    headers: { Authorization: "Bearer sk-a" },
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.data.length > 40);
  assert.equal(j.data[0].id, "gpt-6.1-sol");
  assert.equal(j.data[0].default, true);
});

// ---------------------------------------------------------------- chat

test("non-streaming chat completion translates correctly", async () => {
  const r = await post(proxyA.address().port, "/v1/chat/completions", {
    model: "gpt-6.1-sol",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 100,
  }, { Authorization: "Bearer sk-a" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, "chat.completion");
  assert.equal(j.choices[0].message.role, "assistant");
  assert.ok(j.choices[0].message.content.includes("hello"));
  assert.equal(j.usage.total_tokens, 13);
  assert.equal(j.model, "gpt-6.1-sol");
});

test("streaming chat completion emits OpenAI SSE chunks with usage", async () => {
  const r = await post(proxyA.address().port, "/v1/chat/completions", {
    model: "gpt-6.1-sol",
    messages: [{ role: "user", content: "hello stream" }],
    stream: true,
    stream_options: { include_usage: true },
  }, { Authorization: "Bearer sk-a" });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/event-stream/);
  const text = await r.text();
  const chunks = text
    .split("\n")
    .filter((l) => l.startsWith("data:") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(5)));
  const content = chunks.flatMap((c) => c.choices?.[0]?.delta?.content || []);
  assert.ok(content.join("").includes("hello stream"));
  const reasoning = chunks.flatMap((c) => c.choices?.[0]?.delta?.reasoning_content || []);
  assert.ok(reasoning.join("").includes("thinking"));
  const last = chunks[chunks.length - 1];
  assert.equal(last.choices[0].finish_reason, "stop");
  assert.equal(last.usage.total_tokens, 13);
  assert.ok(text.includes("data: [DONE]"));
});

test("streaming tool calls translate to OpenAI tool_calls deltas", async () => {
  const r = await post(proxyA.address().port, "/v1/chat/completions", {
    model: "gpt-6.1-sol",
    messages: [{ role: "user", content: "weather" }],
    stream: true,
    tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
  }, { Authorization: "Bearer sk-a" });
  const text = await r.text();
  const chunks = text
    .split("\n")
    .filter((l) => l.startsWith("data:") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(5)));
  const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
  assert.ok(toolChunks.length >= 1);
  const tc = toolChunks[0].choices[0].delta.tool_calls[0];
  assert.equal(tc.function.name, "get_weather");
  assert.ok(JSON.parse(tc.function.arguments).city === "paris");
});

test("messages is required", async () => {
  const r = await post(proxyA.address().port, "/v1/chat/completions", { model: "x" }, { Authorization: "Bearer sk-a" });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error.message, "messages is required");
});

test("upstream error maps to OpenAI error format", async () => {
  const r = await post(proxyA.address().port, "/v1/chat/completions", {
    model: "gpt-6.1-sol",
    messages: [{ role: "user", content: "__error__" }],
  }, { Authorization: "Bearer sk-a" });
  assert.equal(r.status, 429);
  const j = await r.json();
  assert.equal(j.error.code, "usage_limit_reached");
  assert.ok(j.error.message.includes("Monthly allowance"));
});

// ---------------------------------------------------------------- concurrency

test("upstream concurrency is capped (PERCH_MAX_CONCURRENCY=2)", async () => {
  mock.state.maxConcurrent = 0; // reset
  mock.state.totalModelCalls = 0; // reset
  const jobs = [];
  for (let i = 0; i < 8; i++) {
    jobs.push(
      post(proxyA.address().port, "/v1/chat/completions", {
        model: "gpt-6.1-sol",
        messages: [{ role: "user", content: `__slow__ job ${i}` }],
      }, { Authorization: "Bearer sk-a" }),
    );
  }
  const results = await Promise.all(jobs);
  for (const r of results) assert.equal(r.status, 200);
  assert.ok(mock.state.maxConcurrent <= 2, `max concurrent upstream calls was ${mock.state.maxConcurrent}`);
  assert.equal(mock.state.totalModelCalls, 8);
});

test("turn ticket header is sent on model calls", async () => {
  mock.state.lastModelHeaders = null;
  await post(proxyA.address().port, "/v1/chat/completions", {
    messages: [{ role: "user", content: "ticket check" }],
  }, { Authorization: "Bearer sk-a" });
  assert.equal(mock.state.lastModelHeaders["x-perch-turn-ticket"], "ticket-abc");
});

// ---------------------------------------------------------------- multi-account

test("multi-account: valid key routes to its account", async () => {
  const r = await post(proxyB.address().port, "/v1/chat/completions", {
    messages: [{ role: "user", content: "acct2 says hi" }],
  }, { Authorization: "Bearer sk-b1" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.choices[0].message.content.includes("acct2 says hi"));
  assert.equal(mock.state.lastModelBody.request.messages[0].content, "acct2 says hi");
});

test("multi-account: unknown key is rejected", async () => {
  const r = await post(proxyB.address().port, "/v1/chat/completions", {
    messages: [{ role: "user", content: "hi" }],
  }, { Authorization: "Bearer sk-nope" });
  assert.equal(r.status, 401);
});

test("multi-account: missing key is rejected", async () => {
  const r = await post(proxyB.address().port, "/v1/chat/completions", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.status, 401);
});

// ---------------------------------------------------------------- embeddings & usage

test("embeddings translate to OpenAI format", async () => {
  const r = await post(proxyA.address().port, "/v1/embeddings", {
    input: "hello world",
    dimensions: 3,
  }, { Authorization: "Bearer sk-a" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, "list");
  assert.deepEqual(j.data[0].embedding, [0.1, 0.2, 0.3]);
});

test("usage meter is proxied", async () => {
  const r = await fetch(`http://127.0.0.1:${proxyA.address().port}/v1/usage`, {
    headers: { Authorization: "Bearer sk-a" },
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.meter.dailyPt, 42);
});

// ---------------------------------------------------------------- rate limit

test("per-key rate limit returns 429 with Retry-After", async () => {
  const cfgC = baseCfg(mock.url, { defaultToken: "test-token", clientKey: "sk-c", rpm: 3 });
  const proxyC = buildApp(cfgC);
  const port = await listen(proxyC);
  try {
    const payload = { messages: [{ role: "user", content: "rl" }] };
    for (let i = 0; i < 3; i++) {
      const r = await post(port, "/v1/chat/completions", payload, { Authorization: "Bearer sk-c" });
      assert.equal(r.status, 200);
    }
    const r4 = await post(port, "/v1/chat/completions", payload, { Authorization: "Bearer sk-c" });
    assert.equal(r4.status, 429);
    assert.ok(r4.headers.get("retry-after"));
    const j = await r4.json();
    assert.equal(j.error.code, "rate_limit_exceeded");
  } finally {
    await close(proxyC);
  }
});
