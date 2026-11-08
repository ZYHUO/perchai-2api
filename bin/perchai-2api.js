#!/usr/bin/env node
// perchai-2api — OpenAI-compatible 2api proxy for Perch AI.
// Commands: serve (default), login, status, help

"use strict";

const { startServer } = require("../src/server");
const { readEnv } = require("../src/config");
const { login } = require("../src/login");
const fs = require("node:fs");
const path = require("node:path");
const { log } = require("../src/util");

const HELP = `perchai-2api — OpenAI-compatible proxy for Perch AI (perchai-cli)

Usage:
  perchai-2api serve            Start the proxy (default when no command given)
  perchai-2api login            Sign in with your Perch account (browser OAuth)
  perchai-2api status           Show session/account status
  perchai-2api help             Show this help

Options (env):
  PORT                      Listen port (default 8080)
  HOST                      Listen host (default 0.0.0.0)
  PERCH_APP_URL             Perch backend (default https://app.perchai.app)
  PERCH_MODEL_CALL_PROXY_TOKEN  Use a raw access token instead of the session file
  PERCH_ACCOUNTS            Multi-account: "sk-key1:/path/sess1.json,sk-key2:/path/sess2.json"
  PERCH_2API_KEY            Require this client API key
  PERCH_2API_ALLOW_ANY=1    Accept any non-empty client key
  PERCH_MAX_CONCURRENCY     Max concurrent upstream model calls (default 4)
  PERCH_RPM                 Per-key rate limit (requests/minute, 0 = off)
  PERCH_LOG_LEVEL           0=quiet 1=info 2=debug
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || "serve";
  const rest = args.slice(1);
  const opts = {};
  for (const a of rest) {
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--out") opts.out = rest[rest.indexOf(a) + 1];
    else if (a === "--provider") opts.provider = rest[rest.indexOf(a) + 1];
    else opts[`--${a.replace(/^--/, "")}`] = true;
  }
  return { cmd, opts };
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv);

  if (opts.help || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }

  if (cmd === "login") {
    const cfg = readEnv();
    const outPath = opts.out
      ? opts.out.replace(/^~/, require("node:os").homedir())
      : cfg.defaultToken
        ? null
        : cfg.defaultSessionPath;
    if (!outPath) {
      console.error("PERCH_MODEL_CALL_PROXY_TOKEN is set — refusing to overwrite an env-token config. Unset it or pass --out.");
      process.exit(1);
    }
    try {
      const { session, provider } = await login({
        appUrl: cfg.appUrl,
        provider: opts.provider,
        outPath,
      });
      fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(outPath, JSON.stringify(session, null, 2), { mode: 0o600 });
      log("info", `Signed in with ${provider} as ${session.email || "unknown email"}`);
      log("info", `Session saved to ${outPath}`);
    } catch (e) {
      console.error(`Login failed: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "status") {
    const cfg = readEnv();
    const { Account } = require("../src/session");
    const acc = cfg.defaultToken
      ? new Account({ appUrl: cfg.appUrl, token: cfg.defaultToken })
      : new Account({ appUrl: cfg.appUrl, sessionPath: cfg.defaultSessionPath });
    await acc.ensureSession();
    if (!acc.session?.accessToken) {
      console.log(`No session. Login with: perchai-2api login`);
      console.log(`Session file: ${cfg.defaultSessionPath}`);
      return;
    }
    const exp = acc.session.expiresAt ? new Date(acc.session.expiresAt * 1000).toISOString() : "never (env token)";
    console.log(`app:      ${cfg.appUrl}`);
    console.log(`account:  ${acc.session.email || acc.session.userId || "unknown"}`);
    console.log(`token:    ${acc.session.accessToken.slice(0, 12)}...`);
    console.log(`expires:  ${exp}`);
    if (cfg.accounts.length) {
      console.log("multi-account keys:");
      for (const a of cfg.accounts) console.log(`  ${a.key}`);
    }
    return;
  }

  if (cmd === "serve") {
    startServer();
    return;
  }

  console.error(`Unknown command: ${cmd}\n`);
  process.stdout.write(HELP);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
