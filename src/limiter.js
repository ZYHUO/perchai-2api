"use strict";
// Concurrency primitives: a FIFO semaphore (upstream call limiter) and a
// fixed-window rate limiter (per client key).

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Number(max) || 1);
    this.active = 0;
    this.queue = [];
  }

  async acquire(signal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (this.active < this.max) {
      this.active += 1;
      return this._releaseFn();
    }
    // FIFO wait
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.queue.push(entry);
      const onAbort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };
      entry.abort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.active += 1;
    return this._releaseFn();
  }

  _releaseFn() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.queue.shift();
      if (next) next.resolve();
    };
  }

  get depth() {
    return this.queue.length;
  }
}

// Fixed-window rate limit; returns ms to wait until the window resets,
// or 0 when the request may proceed.
class FixedWindowRateLimit {
  constructor(limit, windowMs = 60_000) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.windowMs = windowMs;
    this.count = 0;
    this.windowStart = Date.now();
  }

  take() {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.limit) {
      return this.windowStart + this.windowMs - now;
    }
    this.count += 1;
    return 0;
  }
}

module.exports = { Semaphore, FixedWindowRateLimit };
