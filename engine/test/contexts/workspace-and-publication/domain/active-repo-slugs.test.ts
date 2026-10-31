/* computeActiveRepoSlugs: the repos a pruning pass must not touch. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeActiveRepoSlugs, repoSlug } from "@contexts/workspace-and-publication/domain/active-repo-slugs.ts";

test("computeActiveRepoSlugs covers the running record's repo and triggerRepo", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => ({ id: "r1", status: "running", app: "front", triggerRepo: "team/service" }),
    queueCurrentRunId: () => "r1",
    getRecord: () => undefined,
    repoForApp: (app) => (app === "front" ? "team/front" : undefined),
  });
  assert.deepEqual([...slugs].sort(), ["team__front", "team__service"]);
});

test("computeActiveRepoSlugs ignores a record that is not running", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => ({ id: "r1", status: "enqueued", app: "front" }),
    queueCurrentRunId: () => null,
    getRecord: () => undefined,
    repoForApp: () => "team/front",
  });
  assert.equal(slugs.size, 0);
});

test("computeActiveRepoSlugs falls back to the queue's run id when DB and queue disagree", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => undefined,
    queueCurrentRunId: () => "q1",
    getRecord: (id) => (id === "q1" ? { app: "other", triggerRepo: "svc/repo" } : undefined),
    repoForApp: (app) => (app === "other" ? "team/other" : undefined),
  });
  assert.deepEqual([...slugs].sort(), ["svc__repo", "team__other"]);
});

test("computeActiveRepoSlugs tolerates a missing app config (repoForApp undefined)", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => ({ id: "r1", status: "running", app: "deleted-app", triggerRepo: "svc/repo" }),
    queueCurrentRunId: () => "r1",
    getRecord: () => undefined,
    repoForApp: () => undefined,
  });
  assert.deepEqual([...slugs], ["svc__repo"]);
});

test("repoSlug mirrors repo-mirror.ts directory naming", () => {
  assert.equal(repoSlug("owner/repo"), "owner__repo");
});

