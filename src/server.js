"use strict";
// HTTP server: OpenAI-compatible API surface backed by Perch's model-call gateway.

const http = require("node:http");
const { readEnv } = require("./config");
const { Account, setMaxSockets } = require("./session");
const { modelCall, embeddings, usageMeter, defaultModel } = require("./perch");
const { CLI_MODELS, prepareCliRequest, runCliChat } = require("./cli");
const { FixedWindowRateLimit } = require("./limiter");
const { log, readJsonBody, readStream, now, randomId } = require("./util");
const { openAIError, toChatCompletion, parsePerchLine, upstreamError, normalizeUsage, finishReasonOf } = require("./translate");

const HOSTED_MODELS = [
  "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
  "gpt-5-6-luna", "gpt-5-6-sol", "gpt-5-6-terra", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini",
  "deepseek-v4-flash-0731", "deepseek-v4-pro", "deepseek-v4-flash",
  "fw-kimi-k3", "fw-glm-5-3", "grok-4.7",
  "anthropic/claude-sonnet-4.6", "anthropic/claude-haiku-4.5", "anthropic/claude-fable-5.1",
  "anthropic/claude-opus-4-8", "anthropic/claude-3-haiku",
  "xai/grok-4.5", "xai/grok-4.6",
  "z-ai/glm-5.3", "z-ai/glm-5.3-flash", "glm-4.5-flash", "glm-4.7-flash",
  "poolside/laguna-s-2.1",
  "moonshotai/kimi-k3", "moonshotai/kimi-k3.1-pro",
  "openai/gpt-4o", "openai/gpt-4o-mini", "openai/gpt-oss-120b:free",
  "deepseek/deepseek-r1:free", "deepseek/deepseek-r1-0528:free", "deepseek/deepseek-v4.1-flash",
  "mistralai/mistral-large-4-0", "mistralai/mistral-small-3.2-24b-instruct:free",
  "meta-llama/llama-4-maverick:free", "meta-llama/llama-4-scout:free",
  "qwen/qwen3.8-27b", "qwen/qwen3-coder:free", "tencent/hy4",
];

function buildApp(cfg) {
  setMaxSockets(cfg.upstreamSockets);

  // ---- accounts ---------------------------------------------------------
  const accounts = new Map(); // api key -> Account
  let defaultAccount = null;
  const accountBySessionPath = new Map();

  const makeAccount = (a) => {
    a.userAgent = cfg.userAgent;
    a.loadSessionFile();
    return a;
  };

  if (cfg.accounts.length) {
    for (const { key, sessionPath } of cfg.accounts) {
      const acc = accountBySessionPath.get(sessionPath) || makeAccount(new Account({ appUrl: cfg.appUrl, sessionPath, key }));
      accounts.set(key, acc);
      accountBySessionPath.set(sessionPath, acc);
    }
  }
  if (!accounts.size) {
    defaultAccount = makeAccount(
      cfg.defaultToken
        ? new Account({ appUrl: cfg.appUrl, token: cfg.defaultToken, key: cfg.clientKey })
        : new Account({ appUrl: cfg.appUrl, sessionPath: cfg.defaultSessionPath, key: cfg.clientKey }),
    );
    if (cfg.clientKey) accounts.set(cfg.clientKey, defaultAccount);
  }

  // ---- rate limiters per client key ------------------------------------
  const rateLimiters = new Map();
  const limiterFor = (key) => {
    if (!cfg.rpm) return null;
    let l = rateLimiters.get(key);
    if (!l) {
      l = new FixedWindowRateLimit(cfg.rpm);
      rateLimiters.set(key, l);
    }
    return l;
  };

  // ---- client auth -> account -------------------------------------------
  function clientKeyOf(req) {
    const h = req.headers["authorization"] || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m) return m[1].trim();
    const q = req.headers["x-api-key"]?.trim();
    if (q) return q;
    return null;
  }

  function resolveAccount(req) {
    const key = clientKeyOf(req);
    if (!key) return { key: null, account: null };
    if (accounts.size) {
      const acc = accounts.get(key);
      if (acc) return { key, account: acc };
      return { key, account: null };
    }
    // single default account: any non-empty key is accepted
    return { key, account: defaultAccount };
  }

  // ---- helpers ------------------------------------------------------------
  function sendJSON(res, status, obj) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  }

  function requestLog(req, res, { account, model, tokens, durationMs, status }) {
    if (cfg.logLevel === 0) return;
    log(
      "info",
      `${req.method} ${req.url} -> ${status ?? res.statusCode} ${durationMs ?? ""}ms model=${model ?? "-"} tokens=${tokens ?? "-"} acct=${account?.label ?? "-"} ip=${req.socket.remoteAddress}`,
    );
  }

  // ---- /v1/chat/completions ------------------------------------------------
  async function handleChatCompletions(req, res, { key, account }, startMs) {
    let body;
    try {
      body = await readJsonBody(req, { limit: cfg.maxBodyBytes });
    } catch (e) {
      return sendJSON(res, 400, openAIError(400, e.message === "invalid JSON body" ? "Invalid JSON body" : "Request body too large"));
    }
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return sendJSON(res, 400, openAIError(400, "messages is required"));
    }
    const stream = body.stream === true || body.stream === "true";
    const modelName = body.model || "default";

    if (!account) {
      return sendJSON(res, 401, openAIError(401, "Invalid API key", "invalid_api_key"));
    }

    // optional per-key rate limit
    const limiter = limiterFor(key);
    if (limiter) {
      const wait = limiter.take();
      if (wait > 0) {
        res.setHeader("Retry-After", Math.ceil(wait / 1000));
        return sendJSON(res, 429, openAIError(429, "Rate limit exceeded", "rate_limit_exceeded"));
      }
    }

    // client disconnect -> abort upstream
    const ac = new AbortController();
    const onClientClose = () => ac.abort();
    res.once("close", onClientClose);

    let attempt;
    try {
      try {
        if (cfg.backend === "cli") {
          const prepared = prepareCliRequest(body);
          const data = await runCliChat(account, prepared, { cfg, signal: ac.signal });
          if (res.destroyed) return;
          const out = toChatCompletion(data, prepared.model);
          requestLog(req, res, { account, model: out.model, tokens: out.usage?.total_tokens, durationMs: Date.now() - startMs, status: 200 });
          if (stream) return sendCliStream(res, out, body.stream_options?.include_usage === true);
          return sendJSON(res, 200, out);
        }
        attempt = await modelCall(account, body, { stream, signal: ac.signal, cfg });
      } catch (e) {
        if (ac.signal.aborted || res.destroyed) {
          // client went away or timed out; nothing to write
          return;
        }
        const status = Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 502;
        if (e.retryAfter) res.setHeader("Retry-After", e.retryAfter);
        requestLog(req, res, { account, model: modelName, durationMs: Date.now() - startMs, status });
        return sendJSON(res, status, openAIError(status, e.message || "Upstream request failed", e.code || "upstream_error", {
          ...(e.stage ? { stage: e.stage } : {}),
          ...(e.param ? { param: e.param } : {}),
          ...(e.upstreamStatus ? { upstream_status: e.upstreamStatus } : {}),
        }));
      }
      if (!attempt.auth) {
        requestLog(req, res, { account, model: modelName, durationMs: Date.now() - startMs, status: 401 });
        return sendJSON(
          res,
          401,
          openAIError(
            401,
            `No Perch session for account (${account.label}). Log in with \`perchai-2api login\` or the official \`perch\` CLI.`,
            "not_authenticated",
          ),
        );
      }
      const { res: upstream, release } = attempt;
      if (upstream.statusCode >= 400) {
        const text = (await readStream(upstream).catch(() => Buffer.from(""))).toString("utf8");
        release();
        const mapped = upstreamError(upstream.statusCode, text);
        requestLog(req, res, { account, model: modelName, durationMs: Date.now() - startMs, status: mapped.status });
        return sendJSON(res, mapped.status, mapped.body);
      }
      if (stream) {
        return await pipeStream(req, res, upstream, body, { key, account, startMs, release });
      }
      return await pipeJSON(req, res, upstream, body, { key, account, startMs, release });
    } finally {
      attempt?.res?.destroy();
      attempt?.release?.();
      res.off("close", onClientClose);
    }
  }

  // The official CLI emits JSON when its task finishes. SSE here preserves the
  // client wire format, but the content is buffered, not incremental tokens.
  function sendCliStream(res, completion, includeUsage) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "X-Perch-Stream-Mode": "buffered" });
    const base = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model };
    const write = (data) => res.write(`data: ${JSON.stringify({ ...base, ...data })}\n\n`);
    write({ choices: [{ index: 0, delta: { role: "assistant", content: completion.choices[0].message.content }, finish_reason: null }] });
    write({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    if (includeUsage && completion.usage) write({ choices: [], usage: completion.usage });
    res.end("data: [DONE]\n\n");
  }

  // non-streaming
  async function pipeJSON(req, res, upstream, body, { key, account, startMs, release }) {
    const modelName = body.model || "default";
    try {
      const buf = await readStream(upstream, { limit: 64 * 1024 * 1024 });
      release();
      const data = JSON.parse(buf.toString("utf8"));
      if (data.ok === false || data.error) {
        const mapped = upstreamError(500, buf.toString("utf8"));
        requestLog(req, res, { account, model: modelName, durationMs: Date.now() - startMs, status: mapped.status });
        return sendJSON(res, mapped.status, mapped.body);
      }
      const out = toChatCompletion(data, modelName);
      requestLog(req, res, {
        account,
        model: out.model,
        tokens: out.usage ? out.usage.total_tokens : undefined,
        durationMs: Date.now() - startMs,
        status: 200,
      });
      return sendJSON(res, 200, out);
    } catch (e) {
      release();
      requestLog(req, res, { account, model: modelName, durationMs: Date.now() - startMs, status: 502 });
      return sendJSON(res, 502, openAIError(502, "Upstream returned an unreadable response", "upstream_error"));
    }
  }

  // streaming, with backpressure and upstream-abort on client disconnect
  async function pipeStream(req, res, upstream, body, { key, account, startMs, release }) {
    const includeUsage = body.stream_options?.include_usage === true;
    const modelName = body.model || "default";
    const id = randomId("chatcmpl");
    const created = now();

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });

    let finalModel = modelName;
    let toolIndex = 0;
    const tools = new Map();
    let done = null;
    let streamError = null;
    let tokens = null;

    const write = async (obj) => {
      if (res.writableEnded || res.destroyed) return false;
      const ok = res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (!ok) {
        await new Promise((r) => {
          const finish = () => { res.off("drain", finish); res.off("close", finish); r(); };
          res.once("drain", finish);
          res.once("close", finish);
        });
      }
      return !res.destroyed;
    };
    const chunk = async (delta, finish = null, extra = {}) => {
      return write({
        id,
        object: "chat.completion.chunk",
        created,
        model: finalModel,
        choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
        ...extra,
      });
    };

    upstream.setTimeout(cfg.idleTimeoutMs, () => upstream.destroy(new Error("upstream idle timeout")));
    upstream.setEncoding("utf8");

    let buf = "";
    const emitTool = async (state) => {
      if (state.emitted) return;
      state.emitted = true;
      const tc = state.call;
      await chunk({ tool_calls: [{ index: state.index, id: tc.id, type: "function", function: {
        name: tc.name,
        arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
      } }] });
    };
    const handlers = {
      onContent: async (text) => {
        if (await chunk({ content: text })) {
          // client still connected
        }
      },
      onReasoning: async (text) => chunk({ reasoning_content: text }),
      onToolCall: async (tc) => {
        let state = tools.get(tc.id);
        if (!state) { state = { index: toolIndex++, emitted: false }; tools.set(tc.id, state); }
        state.call = tc;
        // Perch sends complete snapshots, not append-only argument fragments.
        // Wait for a sealed snapshot to avoid corrupting or duplicating a call.
        if (tc.sealed) await emitTool(state);
      },
      onRestart: () => {
        throw new Error("Upstream restarted the stream; retry the request");
      },
      onDone: async (ev) => {
        done = ev;
        if (typeof ev.model === "string") finalModel = ev.model;
        if (ev.ok !== false) {
          for (const tc of ev.toolCalls || []) await handlers.onToolCall(tc);
          for (const state of tools.values()) await emitTool(state);
        }
      },
      onError: (msg) => {
        streamError = msg;
      },
    };

    try {
      for await (const lineChunk of upstream) {
        buf += lineChunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          await parsePerchLine(line, handlers);
          if (done) break;
        }
        if (res.destroyed || done) break;
      }
      if (!done && buf.trim()) await parsePerchLine(buf, handlers);
      if (!done) streamError ||= "Upstream stream ended without a done event";
    } catch (e) {
      if (res.destroyed) {
        upstream.destroy();
        release();
        return; // client is gone; nothing to deliver
      }
      streamError = streamError || e?.message || "Stream interrupted";
    } finally {
      upstream.destroy();
    }

    if (res.destroyed || res.writableEnded) {
      upstream.destroy();
      release();
      return;
    }

    if (streamError) {
      await chunk({}, "error");
      await write({ error: { message: streamError, type: "upstream_error", code: "upstream_error" } });
      tokens = null;
      requestLog(req, res, { account, model: finalModel, durationMs: Date.now() - startMs, status: 502 });
    } else if (done && done.ok === false) {
      await chunk({}, "error");
      await write({ error: { message: String(done.error ?? "Model call failed"), type: "upstream_error", code: "upstream_error" } });
      requestLog(req, res, { account, model: finalModel, durationMs: Date.now() - startMs, status: 502 });
    } else {
      const usage = includeUsage ? normalizeUsage(done?.usage) : null;
      tokens = usage?.total_tokens ?? null;
      await chunk({}, done?.finishReason || (tools.size ? "tool_calls" : finishReasonOf(done)), usage ? { usage } : {});
    }
    res.write("data: [DONE]\n\n");
    res.end();
    release();
    if (!streamError && done?.ok !== false) requestLog(req, res, { account, model: finalModel, tokens, durationMs: Date.now() - startMs, status: 200 });
  }

  // ---- /v1/embeddings -------------------------------------------------------
  async function handleEmbeddings(req, res, { key, account }, startMs) {
    if (!account) return sendJSON(res, 401, openAIError(401, "Invalid API key", "invalid_api_key"));
    if (cfg.backend === "cli") return sendJSON(res, 501, openAIError(501, "The CLI backend does not expose embeddings", "unsupported_endpoint"));
    let body;
    try {
      body = await readJsonBody(req, { limit: cfg.maxBodyBytes });
    } catch {
      return sendJSON(res, 400, openAIError(400, "Invalid JSON body"));
    }
    if (!body || body.input == null) return sendJSON(res, 400, openAIError(400, "input is required"));
    if (!account) return sendJSON(res, 401, openAIError(401, "Invalid API key", "invalid_api_key"));
    try {
      const { res: up, json } = await embeddings(account, body.input, { dimensions: body.dimensions ?? null, cfg });
      if (up.statusCode >= 400) {
        const text = typeof json === "string" ? json : JSON.stringify(json);
        const mapped = upstreamError(up.statusCode, text);
        requestLog(req, res, { account, model: "embed", durationMs: Date.now() - startMs, status: mapped.status });
        return sendJSON(res, mapped.status, mapped.body);
      }
      const vecs = Array.isArray(json) ? json : json?.embeddings ?? json?.data ?? null;
      let out;
      if (Array.isArray(vecs)) {
        out = {
          object: "list",
          data: vecs.map((v, i) => ({
            object: "embedding",
            index: typeof v?.index === "number" ? v.index : i,
            embedding: v?.embedding ?? v,
          })),
          model: json?.model ?? "perch-embedding",
          usage: normalizeUsage(json?.usage) ?? { prompt_tokens: 0, total_tokens: 0 },
        };
      } else if (Array.isArray(json?.embedding)) {
        out = {
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: json.embedding }],
          model: json.model ?? "perch-embedding",
          usage: normalizeUsage(json.usage) ?? { prompt_tokens: 0, total_tokens: 0 },
        };
      } else {
        return sendJSON(res, 502, openAIError(502, "Unrecognized embeddings response shape"));
      }
      requestLog(req, res, { account, model: "embed", durationMs: Date.now() - startMs, status: 200 });
      return sendJSON(res, 200, out);
    } catch (e) {
      requestLog(req, res, { account, durationMs: Date.now() - startMs, status: 502 });
      const status = e.status === 401 ? 401 : 502;
      return sendJSON(res, status, openAIError(status, e.message || "Embeddings request failed", status === 401 ? "not_authenticated" : "upstream_error"));
    }
  }

  // ---- /v1/models -------------------------------------------------------------
  async function handleModels(req, res, { key, account }, startMs) {
    if (cfg.backend === "cli") return sendJSON(res, 200, {
      object: "list",
      data: CLI_MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "perch-ai", ...(id === "auto" ? { default: true } : {}) })),
    });
    const acc = account || defaultAccount;
    const def = acc && acc.configured ? await defaultModel(acc, { cfg }).catch(() => null) : null;
    const models = [...HOSTED_MODELS];
    if (def) {
      const index = models.indexOf(def);
      if (index >= 0) models.splice(index, 1);
      models.unshift(def);
    }
    const data = models.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "perch-ai",
      ...(id === def ? { default: true } : {}),
    }));
    requestLog(req, res, { account: acc, model: "-", durationMs: Date.now() - startMs, status: 200 });
    return sendJSON(res, 200, { object: "list", data });
  }

  // ---- /v1/usage ---------------------------------------------------------------
  async function handleUsage(req, res, { key, account }, startMs) {
    if (!account) return sendJSON(res, 401, openAIError(401, "Invalid API key", "invalid_api_key"));
    if (cfg.backend === "cli") return sendJSON(res, 501, openAIError(501, "Use /usage in the official Perch CLI for account usage", "unsupported_endpoint"));
    try {
      const { res: up, json } = await usageMeter(account, { cfg });
      if (up.statusCode >= 400) {
        const text = typeof json === "string" ? json : JSON.stringify(json);
        const mapped = upstreamError(up.statusCode, text);
        return sendJSON(res, mapped.status, mapped.body);
      }
      requestLog(req, res, { account, model: "usage", durationMs: Date.now() - startMs, status: 200 });
      return sendJSON(res, 200, json);
    } catch (e) {
      const status = e.status === 401 ? 401 : 502;
      return sendJSON(res, status, openAIError(status, e.message || "Usage request failed", status === 401 ? "not_authenticated" : "upstream_error"));
    }
  }

  // ---- router -------------------------------------------------------------------
  const route = async (req, res) => {
    const startMs = Date.now();
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/healthz" || pathname === "/") {
      const { account } = resolveAccount(req);
      account?.loadSessionFile();
      return sendJSON(res, 200, {
        ok: true,
        service: "perchai-2api",
        backend: cfg.backend || "http",
        ...(cfg.backend === "cli" ? { capabilities: { textChat: true, stream: "buffered", tools: false, embeddings: false, accountUsage: false } } : {}),
        uptimeSec: Math.round(process.uptime()),
        ...(account ? { accounts: [{
          label: account.label,
          configured: !!account.session?.accessToken,
          activeRequests: (cfg.backend === "cli" ? account.cliSemaphore : account.semaphore)?.active ?? 0,
          concurrencyDepth: (cfg.backend === "cli" ? account.cliSemaphore : account.semaphore)?.depth ?? 0,
        }] } : {}),
      });
    }

    if (pathname === "/v1/models" || pathname === "/models") {
      const { key, account } = resolveAccount(req);
      if (!account) return sendJSON(res, 401, openAIError(401, "Invalid API key", "invalid_api_key"));
      return handleModels(req, res, { key, account }, startMs);
    }
    if (pathname === "/v1/usage" || pathname === "/usage") {
      const { key, account } = resolveAccount(req);
      if (!key) return sendJSON(res, 401, openAIError(401, "Missing API key", "invalid_api_key"));
      return handleUsage(req, res, { key, account }, startMs);
    }
    if (req.method !== "POST") return sendJSON(res, 405, openAIError(405, "Method not allowed"));
    if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") {
      const { key, account } = resolveAccount(req);
      if (!key) return sendJSON(res, 401, openAIError(401, "Missing API key", "invalid_api_key"));
      return handleChatCompletions(req, res, { key, account }, startMs);
    }
    if (pathname === "/v1/embeddings" || pathname === "/embeddings") {
      const { key, account } = resolveAccount(req);
      if (!key) return sendJSON(res, 401, openAIError(401, "Missing API key", "invalid_api_key"));
      return handleEmbeddings(req, res, { key, account }, startMs);
    }
    return sendJSON(res, 404, openAIError(404, "Not found"));
  };
  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      log("error", `Request failed: ${e.message}`);
      if (res.headersSent) res.destroy();
      else sendJSON(res, 500, openAIError(500, "Internal server error"));
    });
  });

  server.on("clientError", (err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return server;
}

function startServer(cfg = null) {
  const config = cfg || readEnv();
  const server = buildApp(config);
  server.listen(config.port, config.host, () => {
    log("info", `perchai-2api listening on http://${config.host}:${config.port}`);
    log("info", `backend: ${config.appUrl}`);
    log("info", `transport: ${config.backend || "http"}${config.backend === "cli" ? " (text tasks, buffered SSE)" : ""}`);
    if (config.accounts.length) {
      log("info", `multi-account mode: ${config.accounts.length} client keys configured`);
    } else {
      log("info", `default account: ${config.defaultToken ? "PERCH_MODEL_CALL_PROXY_TOKEN" : config.defaultSessionPath}`);
    }
    const concurrency = config.backend === "cli" ? config.cliMaxConcurrency : config.maxConcurrency;
    log("info", `concurrency: ${concurrency}${config.rpm ? `, rate limit: ${config.rpm} rpm/key` : ""}`);
  });
  server.on("error", (e) => {
    console.error(e);
    process.exit(1);
  });
  return server;
}

module.exports = { buildApp, startServer, HOSTED_MODELS };
