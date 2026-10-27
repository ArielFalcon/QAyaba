/* A turn's prompt and output bodies in Loki: the exporter and the facade decorator over a fake log sink, plus one pass through the real turn-span decorator to prove no body reaches a span. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LogRecord } from "@opentelemetry/api-logs";
import { trace } from "@opentelemetry/api";
import type { AgentDeps } from "../integrations/opencode-client";
import type { CaptureMode } from "@kernel/telemetry/capture-mode";
import { sha256Hex } from "../../qa-engine/src/shared-kernel/content-hash";
import { MAX_BODY_CHARS, MAX_LINE_BYTES, PromptBodyExporter, chunkBody, splitSections, type TurnBodyIdentity } from "./prompt-body-logs";
import { registerPromptBodyHost, withPromptBodies } from "./with-prompt-bodies";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const who = (over: Partial<TurnBodyIdentity> = {}, spanId = "b7ad6b7169203331"): TurnBodyIdentity => ({
  turn: { traceId: TRACE, spanId },
  sessionId: "ses_1",
  agent: "qa-author",
  role: "qa-author",
  round: 0,
  repair: false,
  staticHash: "sha256:static",
  ...over,
});

const hashSection = (content: string): string => sha256Hex(content);

/* An assembled prompt the way the assembler builds it: sections joined by a newline, each with the size and hash it recorded. */
function assembled(sections: Record<string, string>, tail?: string) {
  const sectionSizes = Object.fromEntries(Object.entries(sections).map(([id, text]) => [id, Buffer.byteLength(text, "utf8")]));
  const sectionHashes = Object.fromEntries(Object.entries(sections).map(([id, text]) => [id, hashSection(text)]));
  const text = [...Object.values(sections), ...(tail ? [tail] : [])].join("\n");
  return { text, sectionSizes, sectionHashes, hashSection };
}

function sink(redact: (text: string) => string | undefined = (text) => text) {
  const records: LogRecord[] = [];
  const exporter = new PromptBodyExporter({ logger: { emit: (record) => records.push(record) }, redact });
  const bodies = (kind: string): Array<Record<string, unknown>> => records.filter((r) => r.attributes?.["qayaba.body.kind"] === kind).map((r) => JSON.parse(String(r.body)) as Record<string, unknown>);
  return { exporter, records, bodies };
}

const prompt = (mode: CaptureMode, sections: Record<string, string>, identity = who()) => ({ who: identity, mode, ...assembled(sections) });

test("only full capture exports bodies: off and metadata export nothing", () => {
  for (const mode of ["off", "metadata"] as const) {
    const s = sink();
    s.exporter.exportPrompt(prompt(mode, { task: "do it" }));
    s.exporter.exportOutput({ who: who(), mode, text: "answer" });
    assert.equal(s.records.length, 0, mode);
  }
  const full = sink();
  full.exporter.exportPrompt(prompt("full", { task: "do it" }));
  full.exporter.exportOutput({ who: who(), mode: "full", text: "answer" });
  assert.equal(full.bodies("prompt_turn").length, 1);
  assert.equal(full.bodies("turn_output")[0]!.text, "answer");
});

test("every record is linked to the turn's trace and span", () => {
  const s = sink();
  s.exporter.exportPrompt(prompt("full", { task: "do it" }));
  s.exporter.exportOutput({ who: who(), mode: "full", text: "answer" });
  assert.ok(s.records.length >= 3);
  for (const record of s.records) {
    const span = trace.getSpanContext(record.context!);
    assert.deepEqual([span?.traceId, span?.spanId], [TRACE, "b7ad6b7169203331"]);
  }
});

test("every turn exports its own sections; the turn record lists them in order", () => {
  const s = sink();
  const shared = "GROUNDING ".repeat(50);
  s.exporter.exportPrompt(prompt("full", { grounding: shared, task: "first task" }));
  s.exporter.exportPrompt(prompt("full", { grounding: shared, task: "second task" }, who({}, "c7ad6b7169203332")));
  assert.deepEqual(s.bodies("prompt_section").map((b) => b.id), ["grounding", "task", "grounding", "task"]);
  const ids = (turn: Record<string, unknown>) => (turn.sections as Array<{ id: string }>).map((x) => x.id);
  assert.deepEqual(s.bodies("prompt_turn").map(ids), [["grounding", "task"], ["grounding", "task"]]);
});

test("static layers are referenced by their digest and never carried as text", () => {
  const s = sink();
  s.exporter.exportPrompt(prompt("full", { task: "do it" }));
  const [turn] = s.bodies("prompt_turn");
  assert.equal(turn!.static_hash, "sha256:static");
  assert.ok(!JSON.stringify(turn).includes("do it"), "the turn record holds ids, hashes and sizes, not section text");
});

test("a body whose redaction fails is dropped and the turn record says so", () => {
  let fail = true;
  const s = sink((text) => (fail ? undefined : text));
  s.exporter.exportPrompt(prompt("full", { task: "secret-bearing" }));
  s.exporter.exportOutput({ who: who(), mode: "full", text: "secret-bearing output" });
  assert.equal(s.bodies("prompt_section").length, 0);
  assert.equal(s.bodies("turn_output").length, 0);
  assert.ok(!s.records.some((r) => String(r.body).includes("secret-bearing")));
  assert.equal((s.bodies("prompt_turn")[0]!.sections as Array<{ dropped?: boolean }>)[0]!.dropped, true);
  fail = false;
  s.exporter.exportPrompt(prompt("full", { task: "secret-bearing" }));
  assert.equal(s.bodies("prompt_section").length, 1, "a later turn stores it once redaction works");
});

test("bodies are redacted before they leave", () => {
  const s = sink((text) => text.replaceAll("hunter2", "[REDACTED]"));
  s.exporter.exportPrompt(prompt("full", { task: "password hunter2" }));
  s.exporter.exportOutput({ who: who(), mode: "full", text: "I typed hunter2" });
  assert.ok(!s.records.some((r) => String(r.body).includes("hunter2")));
  assert.match(String(s.bodies("turn_output")[0]!.text), /\[REDACTED\]/);
});

test("a long body is cut into numbered chunks, each line under the cap, and reassembles exactly", () => {
  const body = ("line with \"quotes\" and \\ backslashes and unicode é 😀\n").repeat(2_000);
  const s = sink();
  s.exporter.exportOutput({ who: who(), mode: "full", text: body });
  const chunks = s.bodies("turn_output");
  assert.ok(chunks.length > 1);
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.chunk, index);
    assert.equal(chunk.chunks, chunks.length);
  });
  for (const record of s.records) assert.ok(Buffer.byteLength(String(record.body), "utf8") <= MAX_LINE_BYTES);
  assert.equal(chunks.map((c) => c.text).join(""), body);
});

test("chunking escape-heavy text still respects the line cap", () => {
  const body = "\u0001".repeat(40_000);
  const pieces = chunkBody(body, (chunk, index, count) => ({ chunk: index, chunks: count, text: chunk }));
  for (const piece of pieces) assert.ok(Buffer.byteLength(JSON.stringify({ chunk: 9999, chunks: 9999, text: piece }), "utf8") <= MAX_LINE_BYTES);
  assert.equal(pieces.join(""), body);
});

test("a body past the body cap is cut and marked", () => {
  const s = sink();
  s.exporter.exportOutput({ who: who(), mode: "full", text: "x".repeat(MAX_BODY_CHARS + 10) });
  const chunks = s.bodies("turn_output");
  assert.equal(chunks.map((c) => String(c.text).length).reduce((a, b) => a + b, 0), MAX_BODY_CHARS);
  assert.ok(chunks.every((c) => c.truncated === true));
});

test("sections are cut from the assembled text only when their hashes verify", () => {
  const input = assembled({ a: "alpha é", b: "beta" }, "⚠ notice");
  assert.deepEqual(splitSections(input).map((p) => [p.id, p.text]), [["a", "alpha é"], ["b", "beta"], ["tail", "⚠ notice"]]);
  const off = { ...input, text: `X${input.text}` };
  assert.deepEqual(splitSections(off).map((p) => p.id), ["prompt"], "a prompt that is not the assembled text is kept whole");
  assert.deepEqual(splitSections({ ...input, sectionSizes: null }).map((p) => p.id), ["prompt"]);
});

test("through the facade: a full-capture turn's bodies reach the log sink linked to the turn, lower modes export nothing", async () => {
  const marker = "UNIQUE-PROMPT-BODY-MARKER";
  const output = "UNIQUE-OUTPUT-BODY-MARKER";
  for (const mode of ["off", "metadata", "full"] as const) {
    const s = sink();
    registerPromptBodyHost({ exporter: s.exporter, activeMode: () => mode });
    const turn = { traceId: TRACE, spanId: "b7ad6b7169203331" };
    const base: AgentDeps = { open: async () => ({ id: "ses_f", prompt: async () => output, dispose: async () => {} }) };
    const deps = withPromptBodies(base, { staticHash: () => "sha256:static", traces: { turnContext: () => turn } });
    try {
      const session = await deps.open("qa-author", "/cwd", { descriptor: { runId: "r", role: "qa-author" } });
      const sections = assembled({ task: marker });
      assert.equal(await session.prompt(sections.text, { sectionSizes: sections.sectionSizes, sectionHashes: sections.sectionHashes }), output, "the caller still gets the transport's answer");
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      registerPromptBodyHost(undefined);
    }
    if (mode !== "full") {
      assert.equal(s.records.length, 0, mode);
      continue;
    }
    for (const record of s.records) assert.equal(trace.getSpanContext(record.context!)?.spanId, turn.spanId);
    assert.ok(s.records.some((r) => String(r.body).includes(marker)));
    assert.ok(s.records.some((r) => String(r.body).includes(output)));
  }
});

