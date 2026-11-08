"use strict";
// Perch backend calls: model-call (chat), embeddings, usage meter, default model.
// Concurrency: per-account semaphore, keep-alive connections, retry on
// transient 5xx / 429-like statuses, one retry after session refresh on 401.

const { randomUUID } = require("node:crypto");
const { rawRequest, upstreamJson, readResBody } = require("./session");
const { Semaphore } = require("./limiter");
const { log, randomId } = require("./util");

const RETRYABLE = new Set([408, 425, 502, 503]);

function makePerchBody(openAIRequest, runId) {
  const request = {
    messages: Array.isArray(openAIRequest.messages) ? openAIRequest.messages : [],
    tools: openAIRequest.tools ?? undefined,
    toolChoice: openAIRequest.tool_choice ?? undefined,
    maxOutputTokens: openAIRequest.max_tokens ?? openAIRequest.max_completion_tokens ?? undefined,
    temperature: openAIRequest.temperature ?? undefined,
    topP: openAIRequest.top_p ?? undefined,
    stop: openAIRequest.stop ?? undefined,
    responseFormat: openAIRequest.response_format ?? undefined,
  };
  const effort = openAIRequest.reasoning_effort ?? openAIRequest.reasoning?.effort ?? undefined;
  if (effort) request.reasoning = { thinking: { type: "enabled", effort } };
  else if (openAIRequest.reasoning) request.reasoning = openAIRequest.reasoning;
  for (const k of Object.keys(request)) if (request[k] === undefined) delete request[k];

  return {
    request,
    runId,
    lane: openAIRequest.lane ?? "chat",
    strictManual: false,
    preferredModelId: openAIRequest.model ?? undefined,
    avoidModelIds: [],
    clientSurface: "cli",
  };
}

// Single model-call attempt; returns the raw upstream response (stream).
async function attemptModelCall(account, perchBody, { stream, signal, cfg }) {
  if (!(await account.ensureSession())) return { auth: false };
  const ticketHeaders = await account.turnTicketHeaders({ timeoutMs: cfg.ticketTimeoutMs });
  perchBody.runId = account.ticketRunId || perchBody.runId;
  const headers = {
    "Content-Type": "application/json",
    ...account.authHeaders(),
    ...ticketHeaders,
    "x-perch-locale": "en",
    ...(stream ? { Accept: "text/event-stream" } : {}),
  };
  const res = await rawRequest(`${account.appUrl}/api/perch-terminal/model-call`, {
    method: "POST",
    headers,
    body: JSON.stringify(perchBody),
    signal,
    connectTimeoutMs: cfg.connectTimeoutMs,
    totalTimeoutMs: cfg.totalTimeoutMs,
  });
  return { auth: true, res };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// Full model call with semaphore, session-refresh retry and transient retry.
// Returns { auth, res, release } — the caller MUST call release() once the
// response body has been fully consumed (streaming) or buffered (JSON), so the
// per-account concurrency slot tracks live upstream connections.
async function modelCall(account, openAIRequest, { stream = false, signal = null, cfg } = {}) {
  if (!account.semaphore) account.semaphore = new Semaphore(cfg.maxConcurrency);
  const release = await account.semaphore.acquire(signal);
  const runId = account.ticketRunId || randomUUID();
  const body = makePerchBody(openAIRequest, runId);
  let attempt;
  try {
    attempt = await attemptModelCall(account, body, { stream, signal, cfg });
    if (!attempt.auth) {
      release();
      return { auth: false };
    }

    // 401 -> refresh session once and retry
    if (attempt.res.statusCode === 401) {
      if (await account.ensureSession(true)) {
        attempt.res.destroy();
        attempt = await attemptModelCall(account, body, { stream, signal, cfg });
      }
    }

    // transient 5xx -> short backoff retry (only before body starts)
    if (!attempt.auth) { release(); return { auth: false }; }
    if (RETRYABLE.has(attempt.res.statusCode)) {
      attempt.res.destroy();
      await sleep(700, signal);
      attempt = await attemptModelCall(account, body, { stream, signal, cfg });
    }
    if (!attempt.auth) { release(); return { auth: false }; }
    return { ...attempt, release };
  } catch (e) {
    attempt?.res?.destroy();
    release();
    throw e;
  }
}

async function embeddings(account, input, { dimensions = null, signal = null, cfg } = {}) {
  if (!(await account.ensureSession())) throw Object.assign(new Error("No Perch session; log in first"), { status: 401 });
  const payload = { input, ...(dimensions ? { dimensions } : {}) };
  let { res, json } = await upstreamJson(`${account.appUrl}/api/perch-terminal/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...account.authHeaders(), "x-perch-locale": "en" },
    body: JSON.stringify(payload),
    signal,
    connectTimeoutMs: cfg.connectTimeoutMs,
    totalTimeoutMs: cfg.totalTimeoutMs,
  });
  if (res.statusCode === 401 && (await account.ensureSession(true))) {
    ({ res, json } = await upstreamJson(`${account.appUrl}/api/perch-terminal/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...account.authHeaders(), "x-perch-locale": "en" },
      body: JSON.stringify(payload),
      signal,
      connectTimeoutMs: cfg.connectTimeoutMs,
      totalTimeoutMs: cfg.totalTimeoutMs,
    }));
  }
  return { res, json };
}

async function usageMeter(account, { signal = null, cfg } = {}) {
  if (!(await account.ensureSession())) throw Object.assign(new Error("No Perch session; log in first"), { status: 401 });
  const dayStart = new Date().toISOString().slice(0, 10);
  const weekStart = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const { res, json } = await upstreamJson(
    `${account.appUrl}/api/perch-terminal/usage-meter?dayStart=${dayStart}&weekStart=${weekStart}`,
    {
      method: "GET",
      headers: { Accept: "application/json", ...account.authHeaders(), "x-perch-locale": "en" },
      signal,
      connectTimeoutMs: cfg.connectTimeoutMs,
      totalTimeoutMs: 20_000,
    },
  );
  return { res, json };
}

async function defaultModel(account, { signal = null, cfg } = {}) {
  if (!(await account.ensureSession())) return null;
  const { res, json } = await upstreamJson(`${account.appUrl}/api/perch-terminal/public-model-default`, {
    method: "GET",
    headers: { Accept: "application/json", ...account.authHeaders() },
    signal,
    connectTimeoutMs: cfg.connectTimeoutMs,
    totalTimeoutMs: 5000,
  });
  if (res.statusCode !== 200 || !json || json.ok !== true) return null;
  const sel = json.selection;
  if (typeof sel === "string") return sel;
  return sel?.modelId || sel?.id || null;
}

module.exports = { modelCall, embeddings, usageMeter, defaultModel, makePerchBody, randomId };
