/*
 * The learning context the run assistant answers from (buildLearningContext) over the real history
 * store. A corrupt stored curriculum is simulated by overwriting its row in this test process's own
 * database (test-setup.mjs gives each test file a temporary one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildLearningContext } from "./chat";
import { saveCurriculum } from "./history";
import { initCurriculum } from "../qa/learning/curriculum";

function storeCorruptCurriculum(app: string): void {
  saveCurriculum(initCurriculum(app));
  const raw = new Database(process.env.HISTORY_DB_PATH!);
  try {
    raw.prepare("UPDATE curriculum SET data = ? WHERE app = ?").run('{"app":', app);
  } finally {
    raw.close();
  }
}

test("the assistant is told an app's stored curriculum is corrupt, not that it has none", () => {
  const app = `chat-corrupt-${Math.random().toString(36).slice(2)}`;
  storeCorruptCurriculum(app);

  const context = buildLearningContext(app);

  assert.ok(context, "a corrupt curriculum is learning state worth reporting");
  assert.match(context, /corrupt/i);
});

test("an app with no learning state at all gives the assistant no learning context", () => {
  assert.equal(buildLearningContext(`chat-empty-${Math.random().toString(36).slice(2)}`), null);
});
