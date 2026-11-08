"use strict";
// Mock of the Perch backend wire protocol (reversed from perchai-cli) for
// end-to-end testing. Usable as a module (createMockServer) or standalone CLI.
// Behaviors are driven by special tokens in the user message content:
//   __slow__    delay 250ms before answering (concurrency tests)
//   __error__   respond 429 {ok:false,error,errorCode} (error mapping tests)

const http = require("node:http");

function createMockServer() {
  const state = {
    concurrentCalls: 0,
    maxConcurrent: 0,
    totalModelCalls: 0,
    ticketRequests: 0,
    lastModelHeaders: null,
    lastModelBody: null,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {}
      const auth = req.headers["authorization"] || "";
      const send = (status, obj) => {
        const data = JSON.stringify(obj);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(data);
      };

      if (url.pathname === "/api/perch-terminal/cli-auth/config") {
        return send(200, {
          ok: true,
          appUrl: `http://127.0.0.1:${server.address().port}`,
          supabaseUrl: "http://127.0.0.1:9999",
          supabaseAnonKey: "anon-test",
          providers: ["google", "github"],
          redirectHost: "127.0.0.1",
        });
      }
      if (url.pathname === "/api/perch-terminal/turn-ticket") {
        state.ticketRequests += 1;
        return send(200, {
          ok: true,
          ticket: "ticket-abc",
          ticketId: "ticket-id-1",
          runId: "run-1234",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          profile: "standard",
          enforced: false,
        });
      }
      if (url.pathname === "/api/perch-terminal/public-model-default") {
        return send(200, { ok: true, selection: "gpt-6.1-sol" });
      }
      if (url.pathname === "/api/perch-terminal/model-call") {
        if (!auth) return send(401, { ok: false, error: "Unauthorized", errorCode: "not_authenticated" });
        state.concurrentCalls += 1;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrentCalls);
        state.totalModelCalls += 1;
        state.lastModelHeaders = req.headers;
        state.lastModelBody = parsed;
        const request = parsed?.request || {};
        const model = parsed?.preferredModelId || "mock-model";
        const text = (request.messages || [])
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join(" | ");
        const reply = `Echo: ${text}`;
        const wantStream = (req.headers["accept"] || "").includes("text/event-stream");

        const finish = () => {
          state.concurrentCalls = Math.max(0, state.concurrentCalls - 1);
        };
        const respondJson = () => {
          send(200, {
            ok: true,
            text: reply,
            content: [{ type: "text", text: reply }],
            toolCalls: [],
            provider: "mock",
            model,
            durationMs: 1,
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          });
          finish();
        };
        const respondStream = () => {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          if (request.tools?.length) {
            ev({ type: "tool_call_delta", toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "paris" }, sealed: false }] });
            ev({ type: "tool_use_end", toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "paris" }, sealed: true }] });
          }
          ev({ type: "answer_delta", text: reply.slice(0, 5) });
          ev({ type: "reasoning_delta", text: "thinking..." });
          ev({ type: "answer_delta", text: reply.slice(5) });
          ev({
            type: "done",
            ok: true,
            text: reply,
            toolCalls: [],
            provider: "mock",
            model,
            durationMs: 1,
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          });
          res.end();
          finish();
        };

        if (text.includes("__error__")) {
          finish();
          return send(429, { ok: false, error: "Monthly allowance reached", errorCode: "usage_limit_reached", limit: { kind: "monthly" } });
        }
        const slow = text.includes("__slow__");
        const fire = slow ? ((fn) => setTimeout(fn, 250)) : ((fn) => fn());
        fire(() => (wantStream ? respondStream() : respondJson()));
        return;
      }
      if (url.pathname === "/api/perch-terminal/embeddings") {
        if (!auth) return send(401, { ok: false, error: "Unauthorized", errorCode: "not_authenticated" });
        return send(200, { ok: true, model: "mock-embed", embeddings: [[0.1, 0.2, 0.3]], usage: { prompt_tokens: 2, total_tokens: 2 } });
      }
      if (url.pathname === "/api/perch-terminal/usage-meter") {
        if (!auth) return send(401, { ok: false, error: "Unauthorized", errorCode: "not_authenticated" });
        return send(200, { ok: true, meter: { dailyPt: 42, weeklyPt: 1337 } });
      }
      return send(404, { ok: false, error: "not found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        state,
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

if (require.main === module) {
  createMockServer().then((m) => {
    console.log(`mock perch backend on :${m.port}`);
    const shutdown = () => m.close().then(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

module.exports = { createMockServer };
