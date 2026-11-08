"use strict";
// OpenAI <-> Perch protocol translation: response shaping, SSE parsing, errors.

const { randomId, now } = require("./util");

function openAIError(status, message, code = "api_error", extra = {}) {
  return { error: { message, type: "perch_proxy_error", code, ...extra } };
}

function normalizeUsage(u) {
  if (!u || typeof u !== "object") return null;
  const prompt = u.prompt_tokens ?? u.input_tokens ?? u.inputTokens ?? null;
  const completion = u.completion_tokens ?? u.output_tokens ?? u.outputTokens ?? null;
  const total = u.total_tokens ?? (prompt != null && completion != null ? prompt + completion : null);
  const out = { ...u };
  if (prompt != null) out.prompt_tokens = prompt;
  if (completion != null) out.completion_tokens = completion;
  if (total != null) out.total_tokens = total;
  return out;
}

function finishReasonOf(perch) {
  return perch?.finishReason || (perch?.toolCalls?.length ? "tool_calls" : "stop");
}

function toolCallsToOpenAI(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((t) => t && typeof t.id === "string" && typeof t.name === "string")
    .map((t) => ({
      id: t.id,
      type: "function",
      function: {
        name: t.name,
        arguments: typeof t.arguments === "string" ? t.arguments : JSON.stringify(t.arguments ?? {}),
      },
    }));
}

// Non-streaming upstream JSON -> OpenAI chat.completion
function toChatCompletion(data, modelName, id) {
  const usage = normalizeUsage(data.usage);
  const message = {
    role: "assistant",
    content: data.text ?? "",
    ...(data.reasoningContent || data.reasoning_content
      ? { reasoning_content: data.reasoningContent ?? data.reasoning_content }
      : {}),
  };
  const toolCalls = toolCallsToOpenAI(data.toolCalls);
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: id || randomId("chatcmpl"),
    object: "chat.completion",
    created: now(),
    model: data.model || modelName,
    choices: [{ index: 0, message, finish_reason: finishReasonOf(data), logprobs: null }],
    ...(usage ? { usage } : {}),
  };
}

// Feed each upstream SSE line through the perch event state machine.
// handlers: onContent, onReasoning, onToolCall, onDone, onError, onRestart
async function parsePerchLine(line, handlers) {
  if (!line.startsWith("data:")) return;
  let ev;
  try {
    ev = JSON.parse(line.slice(5).trim());
  } catch {
    return;
  }
  if (!ev || typeof ev !== "object") return;
  switch (ev.type) {
    case "answer_delta":
      if (typeof ev.text === "string") await handlers.onContent?.(ev.text);
      break;
    case "reasoning_delta":
      if (typeof ev.text === "string") await handlers.onReasoning?.(ev.text);
      break;
    case "tool_call_delta":
    case "tool_use_end":
      if (Array.isArray(ev.toolCalls)) {
        for (const tc of ev.toolCalls) {
          if (tc && typeof tc.id === "string" && typeof tc.name === "string") await handlers.onToolCall?.(tc);
        }
      }
      break;
    case "stream_restart":
      await handlers.onRestart?.();
      break;
    case "done":
      await handlers.onDone?.(ev);
      break;
    case "error":
      await handlers.onError?.(String(ev.message ?? "Stream error"));
      break;
    case "model_call_failed":
      await handlers.onError?.(String(ev.error ?? `Model call failed${ev.modelId ? ` (${ev.modelId})` : ""}`));
      break;
  }
}

// Map a perch error payload/status to an OpenAI error response.
function upstreamError(status, text) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  const msg = parsed?.error || text || `Upstream error: HTTP ${status}`;
  const code = parsed?.errorCode || (status === 429 ? "rate_limit_exceeded" : "upstream_error");
  let outStatus = status;
  if (status === 429) outStatus = 429;
  else if (parsed?.errorCode === "not_authenticated") outStatus = 401;
  else if (status >= 500) outStatus = 502;
  return { status: outStatus, body: openAIError(outStatus, msg, code) };
}

module.exports = {
  openAIError,
  normalizeUsage,
  finishReasonOf,
  toolCallsToOpenAI,
  toChatCompletion,
  parsePerchLine,
  upstreamError,
  randomId,
};
