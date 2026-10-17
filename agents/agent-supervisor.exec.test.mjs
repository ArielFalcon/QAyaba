// `codex exec` as the supervisor runs it, against a stand-in binary that prints the JSONL events the pinned build prints. CODEX_BIN is
// read when the module loads, so it is set before the module is imported.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "codex-exec-"));
const bin = join(dir, "fake-codex");
const eventsFile = join(dir, "events.jsonl");
let supervisor;
let previous;

before(async () => {
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => { process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(eventsFile)}, "utf8")); });\n`);
  chmodSync(bin, 0o755);
  previous = { bin: process.env.CODEX_BIN, key: process.env.CODEX_API_KEY };
  process.env.CODEX_BIN = bin;
  process.env.CODEX_API_KEY = "test-key-not-a-secret";
  supervisor = await import("./agent-supervisor.mjs");
});

after(() => {
  for (const [name, value] of [["CODEX_BIN", previous.bin], ["CODEX_API_KEY", previous.key]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const lines = (...events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const message = (text) => ({ type: "item.completed", item: { type: "agent_message", text } });
const completed = (usage) => ({ type: "turn.completed", usage });
const run = (events, extra = {}) => {
  writeFileSync(eventsFile, lines(...events));
  return supervisor.runCodexExec({ cwd: dir, prompt: "go", sandbox: "read-only", ...extra });
};

test("a turn answers with its final message and the usage Codex reported for it", async () => {
  const out = await run([message("done"), completed({ input_tokens: 12_000, cached_input_tokens: 9_000, output_tokens: 40, reasoning_output_tokens: 15 })]);
  assert.equal(out.message, "done");
  assert.deepEqual(out.usage, { input_tokens: 12_000, cached_input_tokens: 9_000, output_tokens: 40, reasoning_output_tokens: 15 });
});

test("a turn that reported no usage answers with the message alone", async () => {
  const out = await run([message("done")]);
  assert.equal(out.message, "done");
  assert.equal("usage" in out, false);
});

test("several completed turns of one exec are added up", async () => {
  const out = await run([message("a"), completed({ input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 }), message("b"), completed({ input_tokens: 20, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 0 })]);
  assert.equal(out.message, "b");
  assert.deepEqual(out.usage, { input_tokens: 30, cached_input_tokens: 9, output_tokens: 5, reasoning_output_tokens: 1 });
});

test("a field that is missing counts as none and one that is not a plain count is ignored", async () => {
  const out = await run([message("done"), completed({ input_tokens: 7, output_tokens: -3, cached_input_tokens: "lots", reasoning_output_tokens: 1.5 })]);
  assert.deepEqual(out.usage, { input_tokens: 7, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
});

test("an event that is not a completed turn, or carries no usage object, adds nothing", async () => {
  const out = await run([message("done"), { type: "turn.started" }, { type: "turn.completed" }, { type: "turn.completed", usage: "none" }]);
  assert.equal("usage" in out, false);
});

test("the HTTP handler answers with the message and the usage, and keeps answering a failure as an error", async () => {
  writeFileSync(eventsFile, lines(message("done"), completed({ input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 })));
  const ok = await supervisor.handleCodexExec({ cwd: dir, prompt: "go", sandbox: "read-only" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.message, "done");
  assert.equal(ok.body.usage.input_tokens, 5);
  const bad = await supervisor.handleCodexExec({ cwd: "relative", prompt: "go" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /absolute path/);
});
