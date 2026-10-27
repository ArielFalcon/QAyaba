import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { engineLog, installProcessLogger, resetProcessLoggerForTests } from "@kernel/ports/process-logger.ts";
import { memoryLogger } from "@kernel/ports/logger.port.ts";

describe("process logger", () => {
  afterEach(() => resetProcessLoggerForTests());

  test("a line logged before any logger is installed reaches the console at the matching level, with the field values after the message", () => {
    const spies = { log: mock.method(console, "log", () => {}), warn: mock.method(console, "warn", () => {}), error: mock.method(console, "error", () => {}) };
    try {
      const failure = new Error("boom");
      engineLog.info("a");
      engineLog.warn("b");
      engineLog.error("c", { error: failure });
      assert.deepEqual(spies.log.mock.calls.map((c) => c.arguments), [["a"]]);
      assert.deepEqual(spies.warn.mock.calls.map((c) => c.arguments), [["b"]]);
      assert.deepEqual(spies.error.mock.calls.map((c) => c.arguments), [["c", failure]]);
    } finally {
      for (const spy of Object.values(spies)) spy.mock.restore();
    }
  });

  test("an installed logger receives the lines, including those of a logger bound before it was installed", () => {
    const bound = engineLog.child({ context: "x" });
    const memory = memoryLogger();
    installProcessLogger(memory);
    engineLog.warn("w", { n: 1 });
    bound.error("e");
    assert.deepEqual(
      memory.entries.map((entry) => [entry.level, entry.message, entry.fields]),
      [
        ["warn", "w", { n: 1 }],
        ["error", "e", { context: "x" }],
      ],
    );
  });
});
