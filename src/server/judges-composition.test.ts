import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeJudges } from "./judges-composition";
import { JUDGE_NAMES } from "@contexts/evaluation/application/index";
import { JobQueue } from "./queue";

function repo(opts: { judgeModel?: string | null; withPrompt?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "judges-comp-"));
  mkdirSync(join(root, "agents", "agent"), { recursive: true });
  if (opts.withPrompt !== false) writeFileSync(join(root, "agents", "agent", "qa-judge.md"), "<!-- judge-prompt-version: 4 -->\n# Judge\n");
  const agent: Record<string, unknown> = { "qa-author": { model: "prov/generator" }, "qa-lead": { model: "prov/lead" } };
  if (opts.judgeModel !== null) agent["qa-judge"] = { model: opts.judgeModel ?? "prov/judge" };
  writeFileSync(join(root, "agents", "opencode.json"), JSON.stringify({ agent }));
  return root;
}

const quiet = () => undefined;
const base = (root: string, env: Record<string, string>) => ({ env, root, queue: new JobQueue(), mirrorsRoot: join(root, ".mirrors"), log: quiet });

test("with the switch off the judges are inactive, queue nothing, and still appear in the catalog as experimental", () => {
  const root = repo();
  try {
    const judges = composeJudges(base(root, {}));
    judges.service.scheduleForRun("any");
    assert.match(judges.service.unavailable() ?? "", /QA_JUDGES_ENABLED/);
    const catalog = judges.service.catalog();
    assert.deepEqual(catalog.map((e) => e.name).sort(), [...JUDGE_NAMES].sort());
    assert.ok(catalog.every((e) => e.status === "experimental" && e.graderVersion.endsWith("@4")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("switched on but without the role in opencode.json the judges refuse, naming the missing role, and nothing runs", () => {
  const root = repo({ judgeModel: null });
  try {
    const judges = composeJudges(base(root, { QA_JUDGES_ENABLED: "true" }));
    assert.match(judges.service.unavailable() ?? "", /qa-judge/);
    assert.equal(judges.service.request("run", ["spec_relevance"]), "unavailable-run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("switched on with a distinct judge model the judges are available", () => {
  const root = repo();
  try {
    const judges = composeJudges(base(root, { QA_JUDGES_ENABLED: "true", QA_JUDGES_DAILY_TOKENS: "5000" }));
    assert.equal(judges.service.unavailable(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a prompt with no version lists no judge in the catalog: nothing could be versioned", () => {
  const root = repo({ withPrompt: false });
  try {
    assert.deepEqual(composeJudges(base(root, {})).service.catalog(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mistyped QA_JUDGES_ENABLED stops the composition", () => {
  const root = repo();
  try {
    assert.throws(() => composeJudges(base(root, { QA_JUDGES_ENABLED: "yes" })), /QA_JUDGES_ENABLED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
