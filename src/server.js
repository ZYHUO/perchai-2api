"use strict";
// HTTP server: OpenAI-compatible API surface backed by Perch's model-call gateway.

const http = require("node:http");
const { readEnv } = require("./config");
const { Account, setMaxSockets } = require("./session");
const { modelCall, embeddings, usageMeter, defaultModel } = require("./perch");
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
    return a;
  };

  if (cfg.accounts.length) {
    for (const { key, sessionPath } of cfg.accounts) {
      const acc = makeAccount(new Account({ appUrl: cfg.appUrl, sessionPath, key }));
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
    req.on("close", onClientClose);

    let attempt;
    try {
      attempt = await modelCall(account, body, { stream, signal: ac.signal, cfg });
    } catch (e) {
      if (e?.name === "AbortError" || req.destroyed) {
        // client went away or timed out; nothing to write
        return;
      }
      requestLog(req, res, { account, model: modelName, durationMs: Date.now() - startMs, status: 502 });
      return sendJSON(res, 502, openAIError(502, e.message || "Upstream request failed", "upstream_error"));
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
      return pipeStream(req, res, upstream, body, { key, account, startMs, release });
    }
    return pipeJSON(req, res, upstream, body, { key, account, startMs, release });
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
    let done = null;
    let streamError = null;
    let tokens = null;
    let finished = false;

    const write = async (obj) => {
      if (res.writableEnded || res.destroyed) return false;
      const ok = res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (!ok) {
        await new Promise((r) => {
          res.once("drain", r);
          res.once("close", r);
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

    const cleanup = () => {
      if (finished) return;
      finished = true;
      req.off("close", onClientClose);
      upstream.destroy();
    };
    const onClientClose = () => {
      // client disconnected: stop reading upstream
      upstream.destroy();
    };

    upstream.setTimeout(cfg.idleTimeoutMs, () => upstream.destroy(new Error("upstream idle timeout")));

    let buf = "";
    const handlers = {
      onContent: async (text) => {
        if (await chunk({ content: text })) {
          // client still connected
        }
      },
      onReasoning: async (text) => chunk({ reasoning_content: text }),
      onToolCall: async (tc) => {
        await chunk({
          tool_calls: [
            {
              index: toolIndex++,
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
              },
            },
          ],
        });
      },
      onRestart: () => {
        toolIndex = 0;
      },
      onDone: (ev) => {
        done = ev;
        if (typeof ev.model === "string") finalModel = ev.model;
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
        }
        if (res.destroyed) break;
      }
      if (buf.trim()) await parsePerchLine(buf, handlers);
    } catch (e) {
      if (req.destroyed || res.destroyed) {
        cleanup();
        release();
        return; // client is gone; nothing to deliver
      }
      streamError = streamError || e?.message || "Stream interrupted";
    } finally {
      req.off("close", onClientClose);
    }

    if (res.destroyed || res.writableEnded) {
      upstream.destroy();
      release();
      return;
    }

    if (streamError && (!done || done.ok === false)) {
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
      await chunk({}, done ? finishReasonOf(done) : "stop", usage ? { usage } : {});
    }
    res.write("data: [DONE]\n\n");
    res.end();
    release();
    requestLog(req, res, { account, model: finalModel, tokens, durationMs: Date.now() - startMs, status: 200 });
  }

  // ---- /v1/embeddings -------------------------------------------------------
  async function handleEmbeddings(req, res, { key, account }, startMs) {
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
      return sendJSON(res, 502, openAIError(502, e.message || "Embeddings request failed", "upstream_error"));
    }
  }

  // ---- /v1/models -------------------------------------------------------------
  async function handleModels(req, res, { key, account }, startMs) {
    const acc = account || defaultAccount;
    const def = acc && acc.configured ? await defaultModel(acc, { cfg }).catch(() => null) : null;
    const models = [...HOSTED_MODELS];
    if (def && !models.includes(def)) models.unshift(def);
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
      return sendJSON(res, 502, openAIError(502, e.message || "Usage request failed", "upstream_error"));
    }
  }

  // ---- router -------------------------------------------------------------------
  const server = http.createServer((req, res) => {
    const startMs = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/healthz" || pathname === "/") {
      return sendJSON(res, 200, {
        ok: true,
        service: "perchai-2api",
        uptimeSec: Math.round(process.uptime()),
        accounts: accounts.size
          ? [...accounts.values()].map((a) => ({
              label: a.label,
              configured: !!a.session?.accessToken,
              concurrencyDepth: a.semaphore?.depth ?? 0,
            }))
          : [{ label: defaultAccount?.label, configured: !!defaultAccount?.session?.accessToken }],
        pendingStreams: 0,
      });
    }

    if (pathname === "/v1/models" || pathname === "/models") {
      const { key, account } = resolveAccount(req);
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
    if (config.accounts.length) {
      log("info", `multi-account mode: ${config.accounts.map((a) => `${a.key} -> ${a.sessionPath}`).join(", ")}`);
    } else {
      log("info", `default account: ${config.defaultToken ? "PERCH_MODEL_CALL_PROXY_TOKEN" : config.defaultSessionPath}`);
    }
    log("info", `concurrency: ${config.maxConcurrency}${config.rpm ? `, rate limit: ${config.rpm} rpm/key` : ""}`);
  });
  server.on("error", (e) => {
    console.error(e);
    process.exit(1);
  });
  return server;
}

module.exports = { buildApp, startServer, HOSTED_MODELS };
