import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { MultiRepoCheckoutAdapter, type MultiRepoCheckoutDeps, type ServiceStageInput } from "@contexts/qa-run-orchestration/infrastructure/bridges/multi-repo-checkout.adapter.ts";

function spyDeps(): MultiRepoCheckoutDeps & {
  ensureMirrorCalls: Array<{ repo: string; sha: string }>;
  ensureMirrorAtBranchCalls: Array<{ repo: string; branch: string }>;
  stageCalls: ServiceStageInput[];
} {
  const ensureMirrorCalls: Array<{ repo: string; sha: string }> = [];
  const ensureMirrorAtBranchCalls: Array<{ repo: string; branch: string }> = [];
  const stageCalls: ServiceStageInput[] = [];
  return {
    ensureMirrorCalls,
    ensureMirrorAtBranchCalls,
    stageCalls,
    ensureMirror: async (repo, sha) => {
      ensureMirrorCalls.push({ repo, sha });
      return `/mirrors/${repo.replaceAll("/", "__")}`;
    },
    ensureMirrorAtBranch: async (repo, branch) => {
      ensureMirrorAtBranchCalls.push({ repo, branch });
      return `/mirrors/${repo.replaceAll("/", "__")}`;
    },
    stageServiceContext: async (input) => {
      stageCalls.push(input);
      return { dir: "unused", manifestPath: "unused" };
    },
  };
}

test("same-repo checkout: ensures the primary at the event sha, stages every declared service", async () => {
  const deps = spyDeps();
  const adapter = new MultiRepoCheckoutAdapter(
    { primaryRepo: "org/demo", baseBranch: "main", services: [{ repo: "org/orders-svc" }], isCode: false },
    deps,
  );

  const dir = await adapter.checkout(Sha.of("abc1234567"));

  assert.equal(dir, "/mirrors/org__demo");
  assert.deepEqual(deps.ensureMirrorCalls, [{ repo: "org/demo", sha: "abc1234567" }]);
  assert.deepEqual(deps.ensureMirrorAtBranchCalls, [{ repo: "org/orders-svc", branch: "main" }]);
  assert.deepEqual(deps.stageCalls, [{ workingCopyDir: "/mirrors/org__demo", service: { repo: "org/orders-svc", mirrorDir: "/mirrors/org__orders-svc" } }]);
});

test("same-repo checkout: no declared services never calls ensureMirrorAtBranch/stage", async () => {
  const deps = spyDeps();
  const adapter = new MultiRepoCheckoutAdapter({ primaryRepo: "org/demo", baseBranch: "main", services: [], isCode: false }, deps);

  await adapter.checkout(Sha.of("abc1234567"));

  assert.deepEqual(deps.ensureMirrorAtBranchCalls, []);
  assert.deepEqual(deps.stageCalls, []);
});

test("cross-repo checkout: ensures the SERVICE at the event sha, the primary at baseBranch HEAD, stages the trigger with its sha then siblings contracts-only", async () => {
  const deps = spyDeps();
  const adapter = new MultiRepoCheckoutAdapter(
    {
      primaryRepo: "org/demo",
      baseBranch: "main",
      services: [{ repo: "org/orders-svc" }, { repo: "org/payments-svc", baseBranch: "develop" }],
      triggerService: { repo: "org/orders-svc" },
      isCode: false,
    },
    deps,
  );

  const dir = await adapter.checkout(Sha.of("def5678901"));

  assert.equal(dir, "/mirrors/org__demo", "checkout must return the PRIMARY dir, not the service dir");
  assert.deepEqual(deps.ensureMirrorCalls, [{ repo: "org/orders-svc", sha: "def5678901" }]);
  assert.deepEqual(deps.ensureMirrorAtBranchCalls, [
    { repo: "org/demo", branch: "main" },
    { repo: "org/payments-svc", branch: "develop" },
  ], "the trigger is not also cloned at branch HEAD; only the primary and the OTHER sibling are");
  assert.deepEqual(deps.stageCalls, [
    { workingCopyDir: "/mirrors/org__demo", service: { repo: "org/orders-svc", mirrorDir: "/mirrors/org__orders-svc" }, sha: "def5678901" },
    { workingCopyDir: "/mirrors/org__demo", service: { repo: "org/payments-svc", mirrorDir: "/mirrors/org__payments-svc" } },
  ], "trigger is staged with the event sha; the sibling is contracts-only (no sha)");
});

test("code target: declared services are never staged, even when triggerService is set", async () => {
  const deps = spyDeps();
  const adapter = new MultiRepoCheckoutAdapter(
    { primaryRepo: "org/demo", baseBranch: "main", services: [{ repo: "org/orders-svc" }], isCode: true },
    deps,
  );

  await adapter.checkout(Sha.of("abc1234567"));

  assert.deepEqual(deps.ensureMirrorAtBranchCalls, [], "code target must never mirror declared services (no e2e dir concept)");
  assert.deepEqual(deps.stageCalls, []);
});

test("declared services are mirrored CONCURRENTLY, not one-at-a-time (a sequential loop would deadlock this test)", async () => {
  const deps = spyDeps();
  let bStarted = false;
  let releaseA: () => void = () => {};
  const aGate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const ensureMirrorAtBranch = async (repo: string, branch: string): Promise<string> => {
    deps.ensureMirrorAtBranchCalls.push({ repo, branch });
    if (repo === "org/svc-a") {
      await aGate; // only resolves once svc-b's call has started — impossible under a sequential await-per-item loop
    } else if (repo === "org/svc-b") {
      bStarted = true;
      releaseA();
    }
    return `/mirrors/${repo.replaceAll("/", "__")}`;
  };
  const adapter = new MultiRepoCheckoutAdapter(
    { primaryRepo: "org/demo", baseBranch: "main", services: [{ repo: "org/svc-a" }, { repo: "org/svc-b" }], isCode: false },
    { ...deps, ensureMirrorAtBranch },
  );

  const outcome = await Promise.race([
    adapter.checkout(Sha.of("abc1234567")).then(() => "done" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300)),
  ]);

  assert.equal(bStarted, true, "svc-b's mirror call must have started");
  assert.equal(outcome, "done", "checkout must complete promptly — a sequential (for-await) loop would never call svc-b while svc-a is still pending, deadlocking this test");
});
