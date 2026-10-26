/*
 * What a fault of a collaborator off the verdict's path does to a run, site by site: an ordinary fault is carried on, the run's
 * deadline ends the run as such, and an untrusted git tree reaches the caller, wherever in the run the collaborator was asked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { UntrustedGitTreeError } from "@kernel/domain-error.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import { traceFactsOf } from "@kernel/run-trace-facts.ts";
import { scriptedGeneration } from "../../../../support/generation-output.ts";
import { dispose, newRig, observe, type Rig } from "./run-end-rig.ts";

type Fault = "ordinary" | "deadline" | "untrusted";

const FAULTS: Record<Fault, () => Error> = {
  ordinary: () => new Error("the collaborator is down"),
  deadline: () => new RunDeadlineExceededError(600_000, "diff-tiny", "generator", "mid-turn"),
  untrusted: () => new UntrustedGitTreeError("the git dir is not the orchestrator's"),
};

interface Site {
  id: string;
  /** Makes the collaborator throw `fault` when the run asks it. */
  arm: (rig: Rig, fault: Error) => void;
  /** How the run ends when the fault is an ordinary one. */
  ordinary: string;
  /** The collaborator is asked after the run ended and takes no agent turn, so the deadline cannot reach it. */
  noDeadline?: true;
}

const failing = (fault: Error) => async (): Promise<never> => {
  throw fault;
};

/* The store behind the run with one call replaced (the methods are the store's own, so they are forwarded, not copied). */
const storeFailing = (rig: Rig, call: "restore" | "fingerprint" | "capture", fault: Error): void => {
  const real = rig.ws.suiteStore;
  rig.store = {
    restore: (root) => real.restore(root),
    fingerprint: (root, specs) => real.fingerprint(root, specs),
    capture: (input) => real.capture(input),
    demoteAuth: (root, reason) => real.demoteAuth(root, reason),
    [call]: failing(fault),
  };
};

const SITES: readonly Site[] = [
  { id: "suite store restore", ordinary: "final-proof-guard", arm: (rig, fault) => storeFailing(rig, "restore", fault) },
  { id: "suite store fingerprint after a green run", ordinary: "final-proof-guard", arm: (rig, fault) => storeFailing(rig, "fingerprint", fault) },
  { id: "suite store capture of an accepted suite", ordinary: "decided", arm: (rig, fault) => storeFailing(rig, "capture", fault) },
  { id: "authoring location", ordinary: "decided", arm: (rig, fault) => { rig.extra = { ...rig.extra, geolocation: { open: failing(fault) } as never }; } },
  { id: "run_spec loop", ordinary: "decided", arm: (rig, fault) => { rig.extra = { ...rig.extra, closedLoop: { open: failing(fault) } as never }; } },
  { id: "agent browser", ordinary: "decided", arm: (rig, fault) => { rig.extra = { ...rig.extra, agentBrowser: { open: failing(fault) } as never }; } },
  { id: "code-graph tools", ordinary: "decided", arm: (rig, fault) => { rig.extra = { ...rig.extra, codeGraphTools: { open: failing(fault) } as never }; } },
  { id: "pre-generation grounding", ordinary: "decided", arm: (rig, fault) => { rig.extra = { ...rig.extra, preGenerationGrounding: { ground: failing(fault) } as never }; } },
  { id: "write confinement", ordinary: "decided", arm: (rig, fault) => { rig.extra = { ...rig.extra, confinement: { enforce: failing(fault) } as never }; } },
  {
    id: "context map capture",
    ordinary: "context-pass",
    noDeadline: true,
    arm: (rig, fault) => {
      rig.input = { mode: "context" };
      rig.generate = async () => scriptedGeneration({ specs: [".qa/context.json"], note: "built map" });
      rig.extra = { ...rig.extra, contextMapCapture: { capture: failing(fault) } as never };
    },
  },
  { id: "mirror gc", ordinary: "decided", noDeadline: true, arm: (rig, fault) => { rig.extra = { ...rig.extra, mirrorGc: { prune: failing(fault) } as never }; } },
];

for (const site of SITES) {
  for (const kind of ["ordinary", "deadline", "untrusted"] as const) {
    if (kind === "deadline" && site.noDeadline) continue;
    test(`a ${kind} fault of the ${site.id} ${kind === "ordinary" ? `is carried on: the run ends ${site.ordinary}` : kind === "deadline" ? "ends the run on its deadline" : "reaches the caller"}`, async () => {
      const rig = newRig();
      try {
        const fault = FAULTS[kind]();
        site.arm(rig, fault);
        const observed = await observe(rig, `site-${kind}`);
        if (kind === "untrusted") {
          assert.equal(observed.threw, fault);
          return;
        }
        assert.equal(observed.threw, undefined, String(observed.threw));
        assert.equal(traceFactsOf(observed.result!)?.endReason, kind === "ordinary" ? site.ordinary : "run-deadline");
      } finally {
        dispose(rig);
      }
    });
  }
}
