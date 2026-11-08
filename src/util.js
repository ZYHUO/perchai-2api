"use strict";
// Small shared utilities: logging, hashing, id generation, body readers.

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

function base64url(buf) {
  return Buffer.from(buf).toString("base64url").replace(/=+$/, "");
}

function sha256hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function randomId(prefix) {
  return prefix + "-" + crypto.randomBytes(16).toString("hex");
}

function now() {
  return Math.floor(Date.now() / 1000);
}

// Minimal structured logger. Level: 0=quiet,1=requests,2=debug.
const level = Number(process.env.PERCH_LOG_LEVEL || 1);
function log(levelName, ...args) {
  const map = { error: 0, warn: 1, info: 1, debug: 2 };
  if (level >= (map[levelName] ?? 1)) {
    const ts = new Date().toISOString();
    process.stdout.write(`[${ts}] [${levelName}] ${args.map(String).join(" ")}\n`);
  }
}

function openBrowser(url) {
  const plat = process.platform;
  let cmd = null;
  let args = [];
  if (plat === "darwin") { cmd = "open"; args = [url]; }
  else if (plat === "win32") { cmd = "cmd"; args = ["/c", "start", "", url.replace(/&/g, "^&")]; }
  else { cmd = "xdg-open"; args = [url]; }
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

// Read a JSON request body with a size cap.
function readJsonBody(req, { limit = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Collect a full body from an IncomingMessage.
function readStream(stream, { limit = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) return reject(stream.errored || new Error("response aborted"));
    const chunks = [];
    let size = 0;
    stream.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("response too large"));
        stream.destroy();
        return;
      }
      chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    stream.on("aborted", () => reject(new Error("response aborted")));
  });
}

module.exports = { base64url, sha256hex, randomId, now, log, openBrowser, readJsonBody, readStream };
