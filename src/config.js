"use strict";
// Configuration: single-file env parsing and account resolution.
// Accounts: either the default Perch session, or several mapped to API keys.

const os = require("node:os");
const path = require("node:path");

const DEFAULT_APP_URL = "https://app.perchai.app";
const DEFAULT_SESSION_FILE = path.join(
  process.env.PERCH_CLI_AUTH_DIR || path.join(os.homedir(), ".perch"),
  "cli-auth-session.json",
);

function readEnv() {
  const appUrl = (process.env.PERCH_APP_URL || process.env.PERCH_CLI_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");

  // PERCH_ACCOUNTS="sk-aaa:/path/sess1.json,sk-bbb:/path/sess2.json"
  const multi = [];
  for (const part of (process.env.PERCH_ACCOUNTS || "").split(",").map((s) => s.trim())) {
    if (!part) continue;
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const sessPath = part.slice(idx + 1).trim().replace(/^~/, os.homedir());
    if (key && sessPath) multi.push({ key, sessionPath: sessPath });
  }

  const cfg = {
    backend: process.env.PERCH_BACKEND || "http",
    cliEntry: process.env.PERCH_CLI_ENTRY || "/opt/perchai-cli/node_modules/perchai-cli/dist/perch.mjs",
    cliTimeoutMs: Number(process.env.PERCH_CLI_TIMEOUT_MS || 120_000),
    cliMaxConcurrency: Number(process.env.PERCH_CLI_MAX_CONCURRENCY || 1),
    appUrl,
    port: Number(process.env.PORT || 8080),
    host: process.env.HOST || "0.0.0.0",
    // default account (used when no PERCH_ACCOUNTS, or as fallback with PERCH_2API_KEY)
    defaultToken: process.env.PERCH_MODEL_CALL_PROXY_TOKEN?.trim() || null,
    defaultSessionPath: process.env.PERCH_CLI_AUTH_DIR
      ? path.join(process.env.PERCH_CLI_AUTH_DIR, "cli-auth-session.json")
      : DEFAULT_SESSION_FILE,
    accounts: multi,
    clientKey: process.env.PERCH_2API_KEY?.trim() || null,
    allowAny: process.env.PERCH_2API_ALLOW_ANY === "1",
    maxConcurrency: Math.max(1, Number(process.env.PERCH_MAX_CONCURRENCY || 4)),
    rpm: Math.max(0, Number(process.env.PERCH_RPM || 0)), // per-key requests per minute, 0 = off
    connectTimeoutMs: Number(process.env.PERCH_CONNECT_TIMEOUT_MS || 10_000),
    idleTimeoutMs: Number(process.env.PERCH_IDLE_TIMEOUT_MS || 120_000), // gap between SSE events
    totalTimeoutMs: Number(process.env.PERCH_TOTAL_TIMEOUT_MS || 30 * 60_000), // whole model call
    ticketTimeoutMs: Number(process.env.PERCH_TICKET_TIMEOUT_MS || 8_000),
    maxBodyBytes: Number(process.env.PERCH_MAX_BODY_BYTES || 32 * 1024 * 1024),
    upstreamSockets: Math.max(2, Number(process.env.PERCH_UPSTREAM_SOCKETS || 16)),
    userAgent: `perchai-cli/${process.env.PERCH_CLI_VERSION || "2.4.125"} (perchai-2api)`,
    logLevel: Number(process.env.PERCH_LOG_LEVEL || 1), // 0=quiet 1=info 2=debug
  };
  if (!["http", "cli"].includes(cfg.backend)) throw new Error("PERCH_BACKEND must be http or cli");
  if (!Number.isSafeInteger(cfg.cliTimeoutMs) || cfg.cliTimeoutMs < 1) throw new Error("PERCH_CLI_TIMEOUT_MS must be a positive integer");
  if (!Number.isSafeInteger(cfg.cliMaxConcurrency) || cfg.cliMaxConcurrency < 1) throw new Error("PERCH_CLI_MAX_CONCURRENCY must be a positive integer");
  return cfg;
}

module.exports = { readEnv, DEFAULT_APP_URL, DEFAULT_SESSION_FILE };
