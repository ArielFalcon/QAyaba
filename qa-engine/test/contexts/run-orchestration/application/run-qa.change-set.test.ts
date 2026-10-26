/* A run over several repos: each entry's deploy is awaited in entry order, each entry is classified, and the run's action is the highest severity of the entries. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok, err } from "@kernel/result.ts";
import { InfraError } from "@kernel/domain-error.ts";
import type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";
import { ChangeSet, type ChangeEntry } from "@contexts/change-analysis/application/index.ts";
import type { ServiceLink } from "@kernel/service-links.ts";
import type { CrossRepoImpactPort, ServiceLinksPort } from "@contexts/service-topology/application/index.ts";
import { dispose, newRig, observe } from "./run-flow/run-end-rig.ts";

const FRONT = "org/front";
const BACK = "org/back";
const FRONT_SHA = Sha.of("f111111");
const BACK_SHA = Sha.of("b222222");

function twoRepoSet(): ChangeSet {
  return ChangeSet.of("demo", [
    { repo: BACK, role: "service", headSha: BACK_SHA },
    { repo: FRONT, role: "primary", headSha: FRONT_SHA },
  ]);
}

function recordingGate(calls: string[], tag: string, failWith?: string): DeployGatePort {
  return {
    waitUntilServing: async (sha) => {
      calls.push(`${tag}@${sha.toString()}`);
      return failWith ? err(new InfraError(failWith)) : ok(true);
    },
  };
}

test("a two-entry run waits for each entry's deploy in entry order", async () => {
  const rig = newRig();
  try {
    const calls: string[] = [];
    rig.input = { changeSet: twoRepoSet(), sha: FRONT_SHA };
    rig.waitUntilServing = async () => { calls.push("anchor"); return ok(true); };
    rig.extra = { companionDeployGates: new Map([[BACK, recordingGate(calls, "back")]]) };
    const observed = await observe(rig, "change-set-gates");
    assert.equal(observed.result?.decision.verdict, "pass");
    assert.deepEqual(calls.slice(0, 2), [`back@${BACK_SHA.toString()}`, "anchor"]);
  } finally {
    dispose(rig);
  }
});

test("a companion entry whose deploy never serves ends the run naming its repo", async () => {
  const rig = newRig();
  try {
    const calls: string[] = [];
    rig.input = { changeSet: twoRepoSet(), sha: FRONT_SHA };
    rig.waitUntilServing = async () => { calls.push("anchor"); return ok(true); };
    rig.extra = { companionDeployGates: new Map([[BACK, recordingGate(calls, "back", "DEV did not serve sha b222222")]]) };
    const observed = await observe(rig, "change-set-gate-fails");
    assert.equal(observed.result?.decision.verdict, "infra-error");
    assert.match(observed.result?.note ?? "", /org\/back/);
    assert.match(observed.result?.note ?? "", /DEV did not serve sha b222222/);
    assert.ok(!calls.includes("anchor"), "the entries after the failing one are not awaited");
  } finally {
    dispose(rig);
  }
});

test("a single-entry run keeps the gate's message as its note", async () => {
  const rig = newRig();
  try {
    rig.waitUntilServing = async () => err(new InfraError("DEV did not serve sha abc1234"));
    const observed = await observe(rig, "change-set-single-gate");
    assert.equal(observed.result?.note, "DEV did not serve sha abc1234");
  } finally {
    dispose(rig);
  }
});

test("every entry is classified and the run's action is the highest severity", async () => {
  const rig = newRig();
  try {
    const seen: string[] = [];
    rig.input = { changeSet: twoRepoSet(), sha: FRONT_SHA };
    rig.classify = async (entry: ChangeEntry) => {
      seen.push(entry.repo);
      return entry.repo === FRONT
        ? { action: "skip", reason: "docs only", diff: "front diff" }
        : { action: "generate", reason: "logic changed", diff: "back diff" };
    };
    const observed = await observe(rig, "change-set-classify");
    assert.deepEqual([...seen].sort(), [BACK, FRONT]);
    assert.notEqual(observed.result?.gateSignals.furthestPhase, "classify", "a skipping anchor does not end a run whose companion generates");
    assert.equal(observed.result?.decision.verdict, "pass");
  } finally {
    dispose(rig);
  }
});

test("a run whose every entry skips ends skipped without generating", async () => {
  const rig = newRig();
  try {
    let authored = 0;
    rig.input = { changeSet: twoRepoSet(), sha: FRONT_SHA };
    rig.classify = async () => ({ action: "skip", reason: "docs only", diff: "" });
    rig.author = async () => { authored += 1; throw new Error("must not generate"); };
    const observed = await observe(rig, "change-set-all-skip");
    assert.equal(authored, 0);
    assert.equal(observed.result?.decision.verdict, "skipped");
  } finally {
    dispose(rig);
  }
});

test("the cross-repo impact is resolved for each service entry of the change at its own head, and merged", async () => {
  const linkTo = (repo: string): ServiceLink => ({
    from: { repo: FRONT, file: "src/api.ts", symbol: "call" },
    to: { repo, file: "src/routes.ts", symbol: "handle" },
    transport: "http",
    confidence: 1,
    source: "openapi",
  });
  const links = [linkTo(BACK), linkTo("org/billing")];
  const asked: string[] = [];
  const crossRepoImpact: CrossRepoImpactPort = {
    resolve: async (repo, sha) => {
      asked.push(`${repo}@${sha}`);
      return { impactedLinks: [{ link: linkTo(repo), tier: "contract-file" }] };
    },
  };
  const serviceLinks: ServiceLinksPort = { resolve: async () => ({ links, drift: [] }) };
  const rig = newRig();
  try {
    rig.input = {
      changeSet: ChangeSet.of("demo", [
        { repo: FRONT, role: "primary", headSha: FRONT_SHA },
        { repo: BACK, role: "service", headSha: BACK_SHA },
        { repo: "org/billing", role: "service", headSha: Sha.of("c333333") },
      ]),
      sha: FRONT_SHA,
    };
    rig.extra = { serviceLinks, crossRepoImpact };
    const observed = await observe(rig, "change-set-impact");
    assert.deepEqual(asked, [`${BACK}@b222222`, "org/billing@c333333"]);
    assert.equal(observed.result?.outcome?.gateSignals.crossRepoImpactedCount, 2);
  } finally {
    dispose(rig);
  }
});
