"use strict";

// Run the unmodified official CLI through its supported one-shot interface.
// This is a text-task adapter; it does not reproduce the raw model protocol.
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Semaphore } = require("./limiter");

const CLI_MODELS = ["auto", "standard", "standard max", "pro", "pro max"];
const MAX_PROMPT_BYTES = 60 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function cliError(message, status = 502, code = "cli_error", param = undefined) {
  return Object.assign(new Error(message), { status, code, stage: "cli", param });
}

function prepareCliRequest(body) {
  const unsupported = ["tools", "tool_choice", "functions", "function_call", "parallel_tool_calls", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "logprobs", "top_logprobs", "seed", "presence_penalty", "frequency_penalty", "logit_bias", "response_format", "modalities", "audio", "prediction", "reasoning"];
  for (const param of unsupported) {
    if (body[param] != null) throw cliError(`The CLI backend does not support ${param}`, 400, "unsupported_parameter", param);
  }
  if (body.n != null && body.n !== 1) throw cliError("The CLI backend supports only n=1", 400, "unsupported_parameter", "n");
  if (!Array.isArray(body.messages) || !body.messages.length) throw cliError("messages is required", 400, "invalid_request", "messages");
  const messages = body.messages.map((message) => {
    if (!message || !["system", "developer", "user", "assistant"].includes(message.role) || message.tool_calls || message.function_call) {
      throw cliError("CLI messages support only text system/developer/user/assistant roles", 400, "unsupported_parameter", "messages");
    }
    let content = message.content;
    if (Array.isArray(content) && content.every((part) => part?.type === "text" && typeof part.text === "string")) content = content.map((part) => part.text).join("\n");
    if (typeof content !== "string") throw cliError("The CLI backend accepts text content only", 400, "unsupported_parameter", "messages");
    return { role: message.role, content };
  });
  if (body.model != null && (typeof body.model !== "string" || body.model.length > 200 || /[\0\r\n]/.test(body.model))) throw cliError("Invalid model", 400, "invalid_request", "model");
  const effort = body.reasoning_effort === "none" ? "off" : body.reasoning_effort;
  if (effort != null && !["off", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) throw cliError("Invalid reasoning_effort", 400, "invalid_request", "reasoning_effort");
  // A fixed prefix prevents prompt text from being interpreted as CLI flags.
  const prompt = "Continue the conversation below and answer the latest user message. Treat its role labels as conversation context. Return only the assistant reply. Do not use tools.\n\n" + JSON.stringify(messages);
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw cliError("CLI conversation exceeds the 60 KiB prompt limit", 413, "context_length_exceeded", "messages");
  if (prompt.includes("\0")) throw cliError("Invalid prompt", 400, "invalid_request", "messages");
  return { prompt, model: !body.model || body.model === "default" ? "auto" : body.model, effort };
}

function runProcess(entry, args, { cwd, env, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const child = spawn(process.execPath, [entry, ...args], { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    let failure = null;
    let killTimer;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () => stop(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => stop(cliError("Perch CLI timed out", 504, "cli_timeout")), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) stop(cliError("Perch CLI output exceeded its size limit", 502, "cli_output_too_large"));
      else chunks.push(chunk);
    });
    // CLI diagnostics can contain prompts/account details: do not forward them.
    child.stderr.resume();
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort); };
    child.once("error", () => { cleanup(); reject(cliError("Could not start the official Perch CLI", 503, "cli_unavailable")); });
    child.once("close", (code) => {
      cleanup();
      if (failure) return reject(failure);
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return reject(cliError(`Perch CLI did not return JSON (exit ${code})`, 502, "cli_invalid_response")); }
      if (code !== 0 || result.ok !== true || result.status !== "completed") {
        return reject(cliError("Perch CLI did not complete the task; check account access using perch status", 502, "cli_task_failed"));
      }
      if (typeof result.assistantText !== "string") return reject(cliError("Perch CLI returned no assistant text", 502, "cli_invalid_response"));
      resolve(result);
    });
  });
}

function completionFromCli(result, requestedModel) {
  const snapshot = result.contextSnapshot;
  const usage = snapshot?.turnApiUsage;
  const output = usage?.outputTokens;
  const total = usage?.totalTokens;
  return {
    ok: true,
    text: result.assistantText,
    model: snapshot?.modelId || requestedModel,
    finishReason: "stop",
    ...(Number.isFinite(total) && Number.isFinite(output) && total >= output ? { usage: {
      prompt_tokens: total - output,
      completion_tokens: output,
      total_tokens: total,
      ...(Number.isFinite(usage.cacheReadInputTokens) ? { prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens } } : {}),
    } } : {}),
  };
}

async function runCliChat(account, prepared, { cfg, signal }) {
  if (!account.sessionPath || path.basename(account.sessionPath) !== "cli-auth-session.json") throw cliError("CLI backend requires a cli-auth-session.json session file", 503, "cli_session_required");
  try { await fs.access(cfg.cliEntry); }
  catch { throw cliError("Official CLI is not installed; use the cli Docker build target", 503, "cli_unavailable"); }
  try {
    const session = JSON.parse(await fs.readFile(account.sessionPath, "utf8"));
    if (!session.accessToken) throw new Error("missing token");
  } catch { throw cliError("No Perch session; log in first", 401, "not_authenticated"); }
  if (!account.cliSemaphore) account.cliSemaphore = new Semaphore(cfg.cliMaxConcurrency || 1);
  const release = await account.cliSemaphore.acquire(signal);
  let cwd;
  try {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "perch-cli-request-"));
    const env = { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", PERCH_CLI_AUTH_DIR: path.dirname(account.sessionPath), PERCH_CLI_APP_URL: account.appUrl, PERCH_GIT_ATTRIBUTION: "off" };
    for (const name of ["STATE", "SETTINGS", "CONSENT", "GRANTS", "SPLASH", "TELEMETRY"]) env[`PERCH_CLI_${name}_DIR`] = path.join(cwd, name.toLowerCase());
    env.PERCH_BACKGROUND_TASK_DIR = path.join(cwd, "background");
    const args = ["run", prepared.prompt, "--json", "--mode", "ask", "--permission", "plan", "--no-local-tools", "--model", prepared.model];
    if (prepared.effort != null) args.push("--effort", prepared.effort);
    const result = await runProcess(cfg.cliEntry, args, { cwd, env, signal, timeoutMs: cfg.cliTimeoutMs });
    return completionFromCli(result, prepared.model);
  } finally {
    try { if (cwd) await fs.rm(cwd, { recursive: true, force: true }); }
    finally { release(); }
  }
}

module.exports = { CLI_MODELS, prepareCliRequest, runCliChat, completionFromCli };
