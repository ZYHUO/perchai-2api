"use strict";
// A subprocess fixture: exercise argument/environment handling and lifecycle
// without making paid calls or requiring a Perch account in tests.
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[1];
if (!args.includes("--no-local-tools") || !args.includes("plan")) process.exit(2);
if (prompt.includes("__slow__")) {
  const messages = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
  const marker = messages[0].content.match(/marker=(\S+)/)?.[1];
  if (marker) fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
  setInterval(() => {}, 1000);
} else if (prompt.includes("__bad_json__")) {
  process.stdout.write("not json");
} else if (prompt.includes("__failure__")) {
  process.stderr.write("sensitive account diagnostics should not be exposed");
  console.log(JSON.stringify({ ok: false, status: "failed" }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, status: "completed", assistantText: JSON.stringify({
    prompt, cwd: process.cwd(), args, inheritedClientKey: !!process.env.PERCH_2API_KEY,
  }), contextSnapshot: { modelId: "mock-cli-model", turnApiUsage: { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 20, totalTokens: 33 } } }));
}
