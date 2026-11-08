"use strict";
// Perch account: session load/refresh (Supabase), auth config, turn tickets,
// and a keep-alive HTTP client for upstream calls.

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const { log, now } = require("./util");

// ---------------------------------------------------------------- upstream client

const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 1000 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 1000 }),
};

function setMaxSockets(n) {
  agents.http.maxSockets = n;
  agents.https.maxSockets = n;
}

// Low-level request; resolves with the IncomingMessage (stream), not a buffered body.
// Supports: keep-alive, connect timeout, overall timeout, external abort signal.
function rawRequest(url, { method = "GET", headers = {}, body = null, signal = null, connectTimeoutMs = 10_000, totalTimeoutMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      cleanup();
      fn(arg);
    };
    const req = lib.request(
      u,
      {
        method,
        headers: { ...headers },
        agent: u.protocol === "https:" ? agents.https : agents.http,
      },
      (res) => finish(resolve, res),
    );
    const onAbort = () => {
      req.destroy(new DOMException("Aborted", "AbortError"));
      finish(reject, new DOMException("Aborted", "AbortError"));
    };
    let totalTimer = null;
    const cleanup = () => {
      clearTimeout(totalTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    req.on("error", (e) => finish(reject, e));
    req.setTimeout(connectTimeoutMs, () => {
      req.destroy(new Error(`connect timeout after ${connectTimeoutMs}ms`));
    });
    if (totalTimeoutMs) {
      totalTimer = setTimeout(() => {
        req.destroy(new Error(`total timeout after ${totalTimeoutMs}ms`));
      }, totalTimeoutMs);
      totalTimer.unref?.();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (body != null) req.write(body);
    req.end();
  });
}

// JSON request helper.
async function upstreamJson(url, opts = {}) {
  const res = await rawRequest(url, opts);
  return { res, json: await readResBody(res) };
}

function readResBody(res, { limit = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("response too large"));
        res.destroy();
        return;
      }
      chunks.push(c);
    });
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(text);
      }
    });
    res.on("error", reject);
  });
}

// ---------------------------------------------------------------- account

class Account {
  constructor({ appUrl, sessionPath = null, token = null, key = null }) {
    this.appUrl = appUrl;
    this.sessionPath = sessionPath;
    this.key = key; // client API key this account is bound to (multi-account mode)
    this.session = null;
    this.authConfig = null;
    this.ticket = null;
    this.ticketPromise = null;
    this.refreshing = null;
    this.label = token ? "env-token" : sessionPath;
    if (token) {
      this.session = {
        appUrl,
        accessToken: token,
        refreshToken: null,
        expiresAt: null,
        userId: null,
        email: null,
      };
    }
  }

  get configured() {
    return !!(this.session?.accessToken || this.sessionPath);
  }

  // Load the session file (once).
  loadSessionFile() {
    if (this.session || !this.sessionPath) return;
    try {
      const s = JSON.parse(fs.readFileSync(this.sessionPath, "utf8"));
      if (!s || s.version !== 1 || !s.accessToken || !s.appUrl) return;
      this.session = s;
    } catch {
      this.session = null;
    }
  }

  async getAuthConfig() {
    if (this.authConfig) return this.authConfig;
    const { res, json } = await upstreamJson(`${this.appUrl}/api/perch-terminal/cli-auth/config`, {
      method: "GET",
      headers: { Accept: "application/json" },
      connectTimeoutMs: 10_000,
      totalTimeoutMs: 10_000,
    });
    if (res.statusCode !== 200) throw new Error(`cli-auth/config failed: HTTP ${res.statusCode}`);
    const c = json;
    if (!c || c.ok !== true || !c.supabaseUrl || !c.supabaseAnonKey) throw new Error("cli-auth/config returned no supabase credentials");
    this.authConfig = c;
    return c;
  }

  // Ensure a valid access token; refresh when near expiry. Dedupes concurrent refreshes.
  async ensureSession(force = false) {
    if (!this.session) this.loadSessionFile();
    if (!this.session?.accessToken) return false;
    const exp = this.session.expiresAt;
    if (!force && exp && exp > now() + 90) return true;
    if (force || (exp && exp <= now() + 90)) {
      if (this.refreshing) return this.refreshing;
      this.refreshing = this.refresh().finally(() => (this.refreshing = null));
      return this.refreshing;
    }
    return true;
  }

  async refresh() {
    if (!this.session?.refreshToken) return false;
    const cfg = await this.getAuthConfig().catch(() => null);
    if (!cfg) return false;
    try {
      const { res, json } = await upstreamJson(`${cfg.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: cfg.supabaseAnonKey,
          Authorization: `Bearer ${cfg.supabaseAnonKey}`,
        },
        body: JSON.stringify({ refresh_token: this.session.refreshToken }),
      });
      if (res.statusCode !== 200) return false;
      const d = json;
      if (!d?.access_token) return false;
      this.session = {
        ...this.session,
        accessToken: d.access_token,
        refreshToken: d.refresh_token ?? this.session.refreshToken,
        expiresAt: d.expires_at ?? this.session.expiresAt,
        userId: d.user?.id ?? this.session.userId,
        email: d.user?.email ?? this.session.email,
      };
      this.persist();
      return true;
    } catch {
      return false;
    }
  }

  persist() {
    if (!this.sessionPath || !this.session) return;
    try {
      fs.writeFileSync(
        this.sessionPath,
        JSON.stringify({ ...this.session, version: 1, updatedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
    } catch {}
  }

  authHeaders() {
    return this.session?.accessToken
      ? { Authorization: `Bearer ${this.session.accessToken}`, "User-Agent": this.userAgent ?? "perchai-cli/2.4.125" }
      : {};
  }

  // Turn ticket: best-effort, cached, auto-renewed. Returns headers or {}.
  async turnTicketHeaders() {
    try {
      if (this.ticket && this.ticket.expiresAt > Date.now() + 30_000) {
        return { "x-perch-turn-ticket": this.ticket.token };
      }
      if (this.ticket && this.ticket.expiresAt > Date.now() && this.ticket.renewal && !this.ticketPromise) {
        this.ticketPromise = this.fetchTicket(this.ticket.renewal).then((t) => (this.ticket = t)).finally(() => (this.ticketPromise = null));
        return { "x-perch-turn-ticket": this.ticket.token };
      }
      if (!this.ticketPromise) {
        this.ticketPromise = this.fetchTicket().then((t) => (this.ticket = t)).finally(() => (this.ticketPromise = null));
      }
      await this.ticketPromise;
      if (!this.ticket || this.ticket.expiresAt <= Date.now() + 30_000) return {};
      return { "x-perch-turn-ticket": this.ticket.token };
    } catch {
      return {};
    }
  }

  async fetchTicket(renewal = null, { timeoutMs = 8000 } = {}) {
    const body = renewal ? { renew: true, ticketId: renewal.ticketId } : { surface: "cli", profile: "standard" };
    const res = await rawRequest(`${this.appUrl}/api/perch-terminal/turn-ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...this.authHeaders(),
        "x-perch-locale": "en",
      },
      body: JSON.stringify(body),
      connectTimeoutMs: timeoutMs,
      totalTimeoutMs: timeoutMs,
    });
    if (res.statusCode === 429 || res.statusCode >= 400) return null;
    const d = await readResBody(res);
    if (!d?.ok || !d.ticket || !d.ticketId || !d.runId) return null;
    const expiresAt = d.expiresAt ? Date.parse(d.expiresAt) : Date.now() + 300_000;
    return {
      token: d.ticket,
      ticketId: d.ticketId,
      runId: d.runId,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 300_000,
      renewal,
      enforced: d.enforced === true,
    };
  }

  get ticketRunId() {
    return this.ticket?.runId ?? null;
  }
}

module.exports = { Account, rawRequest, upstreamJson, readResBody, setMaxSockets, agents };
