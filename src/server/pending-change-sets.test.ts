import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingChangeSets, isCoalescible, type DeclaredRepos } from "./pending-change-sets";
import type { RunRequest } from "./runner";

const APP: DeclaredRepos = { app: "demo", primary: "org/front", services: ["org/back", "org/billing"] };
const FRONT_REQ: RunRequest = { app: "demo", sha: "f111111", baseSha: "f000000", target: "e2e", mode: "diff", source: "webhook" };
const BACK_REQ: RunRequest = { app: "demo", sha: "b222222", baseSha: "b000000", target: "e2e", mode: "diff", source: "webhook", triggerRepo: "org/back" };
const alwaysQueued = () => true;

function registered(registry: PendingChangeSets, runId: string, req: RunRequest): void {
  registry.register(runId, req, APP);
}

test("an offer on an empty registry joins nothing", () => {
  assert.equal(new PendingChangeSets().offer(BACK_REQ, APP, alwaysQueued), undefined);
});

test("a run no push joined takes no set: it runs its own request", () => {
  const registry = new PendingChangeSets();
  registered(registry, "run-1", FRONT_REQ);
  assert.equal(registry.take("run-1"), undefined);
});

test("a second push of the app joins the queued run and adds its repo as an entry", () => {
  const registry = new PendingChangeSets();
  registered(registry, "run-1", FRONT_REQ);

  assert.equal(registry.offer(BACK_REQ, APP, alwaysQueued), "run-1");

  const set = registry.take("run-1");
  assert.deepEqual(set?.entries.map((e) => [e.repo, e.role, e.headSha.toString(), e.baseSha?.toString()]), [
    ["org/front", "primary", "f111111", "f000000"],
    ["org/back", "service", "b222222", "b000000"],
  ]);
});

test("a push after the run was taken starts a run of its own", () => {
  const registry = new PendingChangeSets();
  registered(registry, "run-1", FRONT_REQ);
  registry.take("run-1");

  assert.equal(registry.offer(BACK_REQ, APP, alwaysQueued), undefined);
  assert.equal(registry.take("run-1"), undefined, "a run is taken once");
});

test("a run that is no longer queued is not joined", () => {
  const registry = new PendingChangeSets();
  registered(registry, "run-1", FRONT_REQ);

  assert.equal(registry.offer(BACK_REQ, APP, () => false), undefined);
});

test("a push of the same repo extends the range: the earlier base and the later head", () => {
  const registry = new PendingChangeSets();
  registered(registry, "run-1", FRONT_REQ);

  assert.equal(registry.offer({ ...FRONT_REQ, sha: "f333333", baseSha: "f111111" }, APP, alwaysQueued), "run-1");

  const entry = registry.take("run-1")?.entries[0];
  assert.equal(entry?.baseSha?.toString(), "f000000");
  assert.equal(entry?.headSha.toString(), "f333333");
});

test("a push of the same repo with no base on either side is not merged, because the earlier diff would be lost", () => {
  const registry = new PendingChangeSets();
  const { baseSha: _b, ...noBase } = FRONT_REQ;
  registered(registry, "run-1", noBase);

  assert.equal(registry.offer({ ...noBase, sha: "f333333" }, APP, alwaysQueued), undefined);
});

test("a push joins the latest queued run of the app, so pushes keep their order", () => {
  const registry = new PendingChangeSets();
  registered(registry, "run-1", FRONT_REQ);
  registered(registry, "run-2", { ...FRONT_REQ, sha: "f444444", baseSha: "f333333" });

  assert.equal(registry.offer(BACK_REQ, APP, alwaysQueued), "run-2");
});

test("runs of another app or another shadow setting are not joined", () => {
  const registry = new PendingChangeSets();
  registered(registry, "run-1", { ...FRONT_REQ, shadow: true });

  assert.equal(registry.offer(BACK_REQ, APP, alwaysQueued), undefined, "different shadow");
  assert.equal(registry.offer({ ...BACK_REQ, shadow: true, app: "other" }, { ...APP, app: "other" }, alwaysQueued), undefined, "different app");
});

test("a repo the app does not declare is not joined", () => {
  const registry = new PendingChangeSets();
  registered(registry, "run-1", FRONT_REQ);

  assert.equal(registry.offer({ ...BACK_REQ, triggerRepo: "org/stranger" }, APP, alwaysQueued), undefined);
});

test("only an e2e webhook diff run without a continuation, purpose, guidance or per-run override coalesces", () => {
  assert.equal(isCoalescible(FRONT_REQ), true);
  assert.equal(isCoalescible({ ...FRONT_REQ, source: undefined }), true);
  for (const refused of [
    { source: "manual" as const },
    { mode: "manual" as const },
    { mode: "complete" as const },
    { target: "code" as const },
    { guidance: "test the form" },
    { parentRunId: "run-0" },
    { purpose: "login-bootstrap" as RunRequest["purpose"] },
    { commits: 3 },
    { closedLoop: true },
    { agentBrowser: false },
    { campaign: { id: "c", variant: { arm: "a" }, replicate: 1 } as RunRequest["campaign"] },
  ]) {
    assert.equal(isCoalescible({ ...FRONT_REQ, ...refused }), false, JSON.stringify(refused));
  }
});

test("an ineligible request is never registered and cannot be joined", () => {
  const registry = new PendingChangeSets();
  registered(registry, "run-1", { ...FRONT_REQ, mode: "manual" });

  assert.equal(registry.offer(BACK_REQ, APP, alwaysQueued), undefined);
  assert.equal(registry.take("run-1"), undefined);
});

test("an ineligible offer never merges into a queued run", () => {
  const registry = new PendingChangeSets();
  registered(registry, "run-1", FRONT_REQ);

  assert.equal(registry.offer({ ...BACK_REQ, source: "manual" }, APP, alwaysQueued), undefined);
  assert.equal(registry.offer({ ...BACK_REQ, guidance: "x" }, APP, alwaysQueued), undefined);
});
