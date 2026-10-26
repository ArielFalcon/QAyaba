import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonLogger } from "./logger";
import { createRedactingLogger } from "./redacting-logger";
import { REDACTED } from "../../qa-engine/src/shared-kernel/ports/redaction.port";
import { createRunSecretScope, withRunSecretScope } from "../../qa-engine/src/shared-kernel/run-secret-redaction";

const GITHUB_TOKEN = `ghp_${"a1B2c3D4".repeat(4)}abcd`;
const ACCOUNT_SECRET = "correct-horse-battery";

/* A real JSON logger over a temp directory, so the file sink and the console mirror both receive what the adapter writes. */
async function withSinks<T>(run: (write: ReturnType<typeof createJsonLogger>["logJson"]) => T): Promise<{ result: T; file: string; mirrored: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "redacting-logger-"));
  const mirrored: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((name) => mock.method(console, name, (line: string) => void mirrored.push(String(line))));
  try {
    const sink = createJsonLogger({ dir, maxFiles: 2 });
    const result = run(sink.logJson);
    await sink.close();
    const file = readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("");
    return { result, file, mirrored };
  } finally {
    for (const spy of spies) spy.mock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a message and a field holding a token pattern are written redacted to the file and the console mirror", async () => {
  const { file, mirrored } = await withSinks((logJson) => {
    createRedactingLogger({ sink: logJson }).warn(`token ${GITHUB_TOKEN} leaked`, { header: `Bearer ${GITHUB_TOKEN}`, attempt: 3 });
  });
  for (const written of [file, mirrored.join("\n")]) {
    assert.ok(!written.includes(GITHUB_TOKEN), "the raw token never reaches a sink");
    assert.ok(written.includes(REDACTED));
  }
  assert.equal(JSON.parse(file.trim()).attempt, 3, "a non-string field is kept as it is");
});

test("the run's own account secret is redacted by value from the message and a nested field", async () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([ACCOUNT_SECRET]);
  const { file, mirrored } = await withSinks((logJson) =>
    withRunSecretScope(scope, () => createRedactingLogger({ sink: logJson }).info(`login typed ${ACCOUNT_SECRET}`, { page: { title: `welcome ${ACCOUNT_SECRET}` }, list: [ACCOUNT_SECRET] })),
  );
  for (const written of [file, mirrored.join("\n")]) assert.ok(!written.includes(ACCOUNT_SECRET));
  assert.ok(file.includes(REDACTED));
});

test("an error field is rendered as a redacted message and never as the raw error", async () => {
  const { file } = await withSinks((logJson) => {
    createRedactingLogger({ sink: logJson }).error("step failed", { error: new Error("password=hunter2xyz rejected") });
  });
  const line = JSON.parse(file.trim());
  assert.ok(!file.includes("hunter2xyz"));
  assert.equal(typeof line.error, "string");
  assert.ok(line.error.includes(REDACTED));
});

test("an error field that is not an Error is rendered as redacted text", async () => {
  const { file } = await withSinks((logJson) => {
    createRedactingLogger({ sink: logJson }).error("step failed", { error: `token ${GITHUB_TOKEN}` });
  });
  assert.ok(!file.includes(GITHUB_TOKEN));
});

test("an error field that is a structure keeps its shape with every string redacted", () => {
  const metas: (Record<string, unknown> | undefined)[] = [];
  const logger = createRedactingLogger({ sink: (_level, _message, meta) => void metas.push(meta) });
  logger.warn("indexing failed", { error: { reason: `denied for ${GITHUB_TOKEN}`, attempts: 2 } });
  assert.deepEqual(metas[0]?.error, { reason: `denied for ${REDACTED}`, attempts: 2 });
});

test("the stack of an error field is written only at debug level, redacted", () => {
  const lines: { level: string; meta: Record<string, unknown> | undefined }[] = [];
  const logger = createRedactingLogger({ sink: (level, _message, meta) => void lines.push({ level, meta }) });
  const failure = new Error(`boom ${GITHUB_TOKEN}`);
  logger.error("failed", { error: failure });
  logger.debug("failed", { error: failure });
  assert.equal(lines[0]!.meta?.stack, undefined);
  const stack = String(lines[1]!.meta?.stack);
  assert.ok(stack.length > 0);
  assert.ok(!stack.includes(GITHUB_TOKEN));
});

test("a redaction that throws drops the line, writes one fallback line and never the raw text", () => {
  const written: { level: string; message: string; meta: Record<string, unknown> | undefined }[] = [];
  const logger = createRedactingLogger({
    sink: (level, message, meta) => void written.push({ level, message, meta }),
    redactor: () => ({
      redact: () => {
        throw new Error("redactor down");
      },
      detect: () => ({ redacted: false, patterns: [], count: 0 }),
      containsSecret: () => false,
    }),
  });
  logger.error(`secret ${GITHUB_TOKEN}`, { more: GITHUB_TOKEN });
  assert.equal(written.length, 1);
  assert.equal(written[0]!.level, "error");
  assert.ok(written[0]!.message.includes("redaction failed"));
  assert.ok(!JSON.stringify(written).includes(GITHUB_TOKEN));
});

test("child fields are added to every line and a call's own field wins", () => {
  const metas: (Record<string, unknown> | undefined)[] = [];
  const logger = createRedactingLogger({ sink: (_level, _message, meta) => void metas.push(meta) }).child({ runId: "run-1", step: "a" });
  logger.info("one");
  logger.warn("two", { step: "b" });
  assert.equal(metas[0]?.runId, "run-1");
  assert.equal(metas[1]?.runId, "run-1");
  assert.equal(metas[1]?.step, "b");
});

test("info, warn and error reach the same levels logJson has, and debug stays out of the console mirror", () => {
  const seen: { level: string; mirror: boolean | undefined }[] = [];
  const logger = createRedactingLogger({ sink: (level, _message, _meta, mirror) => void seen.push({ level, mirror }) });
  logger.info("a");
  logger.warn("b");
  logger.error("c");
  logger.debug("d");
  assert.deepEqual(seen.slice(0, 3).map((s) => s.level), ["info", "warn", "error"]);
  assert.ok(seen.slice(0, 3).every((s) => s.mirror !== false));
  assert.equal(seen[3]!.mirror, false);
});
