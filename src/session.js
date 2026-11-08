"use strict";
// Perch account: session load/refresh (Supabase), auth config, turn tickets,
// and a keep-alive HTTP client for upstream calls.

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const { log, now } = require("./util");

class TurnTicketError extends Error {
  constructor(message, { status = 502, code = "turn_ticket_unavailable", upstreamStatus = null, retryAfter = null } = {}) {
    super(message);
    this.name = "TurnTicketError";
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.retryAfter = retryAfter;
    this.stage = "turn_ticket";
  }
}

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
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    let response = null;
    let totalTimer = null;
    let connectTimer = null;
    const cleanup = () => {
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error) => {
      cleanup();
      response?.destroy(error);
      req.destroy(error);
      reject(error);
    };
    const onAbort = () => fail(new DOMException("Aborted", "AbortError"));
    const req = lib.request(
      u,
      {
        method,
        headers: { ...headers },
        agent: u.protocol === "https:" ? agents.https : agents.http,
      },
      (res) => {
        response = res;
        clearTimeout(connectTimer);
        // The request promise settles at headers; cancellation and the deadline
        // must survive until the response body has finished.
        res.once("end", cleanup);
        res.once("close", cleanup);
        // A retry may be refreshing credentials before it attaches a body
        // reader. Keep a cancellation in that interval from crashing Node.
        res.on("error", () => {});
        resolve(res);
      },
    );
    req.on("error", (e) => { cleanup(); response?.destroy(e); reject(e); });
    connectTimer = setTimeout(() => fail(new Error(`connect timeout after ${connectTimeoutMs}ms`)), connectTimeoutMs);
    connectTimer.unref?.();
    req.once("socket", (socket) => {
      if (!socket.connecting) clearTimeout(connectTimer);
      else socket.once(u.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
    });
    if (totalTimeoutMs) {
      totalTimer = setTimeout(() => {
        fail(new Error(`total timeout after ${totalTimeoutMs}ms`));
      }, totalTimeoutMs);
      totalTimer.unref?.();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
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
    if (res.destroyed) return reject(res.errored || new Error("response aborted"));
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
    res.on("aborted", () => reject(new Error("response aborted")));
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
    this.ticketFailure = null;
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
        totalTimeoutMs: 15_000,
      });
      if (res.statusCode !== 200) return false;
      const d = json;
      if (!d?.access_token) return false;
      this.session = {
        ...this.session,
        accessToken: d.access_token,
        refreshToken: d.refresh_token ?? this.session.refreshToken,
        expiresAt: d.expires_at ?? (d.expires_in ? now() + d.expires_in : this.session.expiresAt),
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

  // A rejected or missing ticket must never fall through to a model call.
  async turnTicketHeaders({ timeoutMs = 8000 } = {}) {
    if (this.ticketFailure?.until > Date.now()) throw this.ticketFailure.error;
    if (this.ticket && this.ticket.expiresAt > Date.now() + 30_000) {
      return { "x-perch-turn-ticket": this.ticket.token };
    }
    if (!this.ticketPromise) {
      const renewal = this.ticket?.expiresAt > Date.now() ? this.ticket.renewal : null;
      this.ticketPromise = this.fetchTicket(renewal, { timeoutMs })
        .then((ticket) => { this.ticketFailure = null; return (this.ticket = ticket); })
        .catch((cause) => {
          this.ticket = null;
          const error = cause instanceof TurnTicketError ? cause : new TurnTicketError("Could not obtain a Perch turn ticket");
          if (error.status === 403 || error.status === 429) {
            const cooldown = error.retryAfter ? error.retryAfter * 1000 : error.status === 403 ? 30_000 : 1000;
            this.ticketFailure = { error, until: Date.now() + cooldown };
          }
          throw error;
        })
        .finally(() => { this.ticketPromise = null; });
    }
    const ticket = await this.ticketPromise;
    return { "x-perch-turn-ticket": ticket.token };
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
    const d = await readResBody(res, { limit: 1024 * 1024 });
    if (res.statusCode >= 400 || d?.ok !== true) {
      const seconds = Number(res.headers["retry-after"]);
      throw new TurnTicketError(typeof d?.error === "string" ? d.error.slice(0, 1000) : "Perch rejected the turn ticket request", {
        status: res.statusCode >= 400 && res.statusCode < 500 ? res.statusCode : 502,
        code: typeof d?.errorCode === "string" ? d.errorCode : "turn_ticket_unavailable",
        upstreamStatus: res.statusCode,
        retryAfter: Number.isFinite(seconds) && seconds > 0 ? Math.min(86400, Math.ceil(seconds)) : null,
      });
    }
    if (!d.ticket || !d.ticketId || !d.runId) throw new TurnTicketError("Perch returned an incomplete turn ticket");
    const expiresAt = d.expiresAt ? Date.parse(d.expiresAt) : Date.now() + 300_000;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new TurnTicketError("Perch returned an invalid or expired turn ticket");
    return {
      token: d.ticket,
      ticketId: d.ticketId,
      runId: d.runId,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 300_000,
      renewal: { ticketId: d.ticketId },
      enforced: d.enforced === true,
    };
  }

  get ticketRunId() {
    return this.ticket?.runId ?? null;
  }
}

module.exports = { Account, TurnTicketError, rawRequest, upstreamJson, readResBody, setMaxSockets, agents };
