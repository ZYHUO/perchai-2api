"use strict";
// Built-in PKCE OAuth login against Perch's Supabase (no official CLI needed).
// Flow (verified against the live endpoint):
//   1. GET {appUrl}/api/perch-terminal/cli-auth/config   -> supabaseUrl + anonKey + providers
//   2. GET {supabaseUrl}/auth/v1/authorize?provider=..&redirect_to=http://127.0.0.1:{port}/callback&code_challenge=..&code_challenge_method=S256
//   3. callback receives ?code=...   -> POST {supabaseUrl}/auth/v1/token?grant_type=pkce {auth_code, code_verifier}
//   4. persist session {version:1, appUrl, accessToken, refreshToken, expiresAt, userId, email, updatedAt}

const http = require("node:http");
const crypto = require("node:crypto");
const { base64url, openBrowser, log } = require("./util");
const { rawRequest, readResBody } = require("./session");

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function authorizeUrl({ supabaseUrl, provider, redirectTo, challenge }) {
  const params = new URLSearchParams({
    provider,
    redirect_to: redirectTo,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (provider === "google") params.set("prompt", "select_account");
  return `${supabaseUrl}/auth/v1/authorize?${params.toString()}`;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Start a local callback server; resolves with { server, codePromise }.
function startCallbackServer({ host = "127.0.0.1", timeoutMs = 180_000 } = {}) {
  let done = false;
  let resolveCode, rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error_description") || url.searchParams.get("error");
    if (done) {
      res.writeHead(404);
      res.end();
      return;
    }
    done = true;
    if (code) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body style='font-family:system-ui;padding:32px;background:#100d0b;color:#fff8f0'><h1>Signed in.</h1><p>You can close this tab.</p></body></html>");
      server.close();
      resolveCode(code);
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style='font-family:system-ui;padding:32px;background:#100d0b;color:#fff8f0'><h1>Sign-in failed</h1><p>${escapeHtml(err || "No code returned")}</p></body></html>`);
      server.close();
      rejectCode(new Error(err || "OAuth callback missing code"));
    }
  });
  server.on("error", (e) => {
    if (!done) {
      done = true;
      rejectCode(e);
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      server.off("error", reject);
      setTimeout(() => {
        if (!done) {
          done = true;
          server.close();
          rejectCode(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the OAuth callback`));
        }
      }, timeoutMs).unref?.();
      log("info", `OAuth callback server on http://${host}:${port}/callback`);
      resolve({ server, port, codePromise });
    });
  });
}

async function login({ appUrl, provider = null, outPath = null, host = "127.0.0.1", openBrowserExternal = openBrowser } = {}) {
  // 1. auth config
  const { res: cfgRes } = await rawRequest(`${appUrl}/api/perch-terminal/cli-auth/config`, {
    method: "GET",
    headers: { Accept: "application/json" },
    connectTimeoutMs: 10_000,
    totalTimeoutMs: 10_000,
  });
  const cfg = await readResBody(cfgRes);
  if (cfgRes.statusCode !== 200 || !cfg || cfg.ok !== true || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error("Failed to fetch CLI auth config from the Perch backend");
  }
  const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  const chosen = provider && providers.includes(provider) ? provider : providers.includes("google") ? "google" : providers[0];
  if (!chosen) throw new Error(`No OAuth provider available (server offers: ${providers.join(", ") || "none"})`);

  // 2. local callback server + PKCE
  const cbHost = cfg.redirectHost?.trim() || host;
  const { server, port, codePromise } = await startCallbackServer({ host: cbHost });
  const redirectTo = `http://${cbHost}:${port}/callback`;
  const { verifier, challenge } = pkcePair();
  const url = authorizeUrl({ supabaseUrl: cfg.supabaseUrl, provider: chosen, redirectTo, challenge });
  log("info", `Opening browser for ${chosen} sign-in...`);
  const opened = await openBrowserExternal(url);
  if (!opened) {
    log("info", "Could not open a browser automatically — visit this URL to sign in:");
    process.stdout.write(`${url}\n`);
  }

  // 3. exchange the code for a session
  const code = await codePromise;
  server.close();
  const { res: tokRes } = await rawRequest(`${cfg.supabaseUrl}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.supabaseAnonKey,
      Authorization: `Bearer ${cfg.supabaseAnonKey}`,
    },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    connectTimeoutMs: 10_000,
    totalTimeoutMs: 15_000,
  });
  const d = await readResBody(tokRes);
  if (tokRes.statusCode !== 200 || !d?.session?.access_token) {
    throw new Error(`Token exchange failed (HTTP ${tokRes.statusCode}): ${d?.msg || d?.error_description || JSON.stringify(d).slice(0, 300)}`);
  }
  const s = d.session;
  const session = {
    version: 1,
    appUrl,
    accessToken: s.access_token,
    refreshToken: s.refresh_token ?? null,
    expiresAt: s.expires_at ?? null,
    userId: s.user?.id ?? null,
    email: s.user?.email ?? null,
    updatedAt: new Date().toISOString(),
  };
  return { session, provider: chosen };
}

module.exports = { login, pkcePair, authorizeUrl, startCallbackServer };
