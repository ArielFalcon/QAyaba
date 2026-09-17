import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";
import type { RunOutcome as LegacyRunOutcome } from "../../../src/types.ts";
import { runOutcomeEquivalent, type ComparableOutcome } from "../characterization/equivalence.ts";

/* Structural-compatibility pin (shell RunOutcome → kernel only): a shell RunOutcome must be
   assignable TO the kernel shape. The kernel fields are intentionally WIDE (errorClass: string | null,
   usage?: unknown, reflection?: unknown) so any shell value satisfies the kernel type. The reverse
   (kernel → shell) is NOT required: the kernel is a supertype, not an isomorphic copy, and the
   comparator works on a behavioral projection (ComparableOutcome) that does not read
   usage/reflection — so wide kernel types are fine. This test pins the direction that matters:
   shell → kernel.
 */
test("kernel RunOutcome is structurally assignable FROM legacy RunOutcome (legacy → kernel)", () => {
  const kernel: KernelRunOutcome = {
    runId: "r1", app: "demo", sha: "abc1234", mode: "diff", target: "e2e",
    verdict: "pass", errorClass: null,
    gateSignals: { static: true, coverageRatio: 0.8, valueScore: null, reviewerCorrections: [], reviewerApproved: true, flaky: false, retries: 0 },
    rulesRetrieved: [], at: "2026-06-24T00:00:00.000Z",
  };
  const asLegacy: LegacyRunOutcome = kernel as unknown as LegacyRunOutcome; /* narrowing (shell is a subtype of kernel) */
  const asKernel: KernelRunOutcome = asLegacy; /* shell → kernel: shell is a structural subtype, always assignable */
  assert.equal(asKernel.verdict, "pass");

  const comparable: ComparableOutcome = { ...kernel };
  assert.equal(runOutcomeEquivalent(comparable, comparable).equal, true);
});

/* kernel RunOutcome.gateSignals declares catalogGate* so the type, not just the comparator, carries them. */
test("kernel RunOutcome.gateSignals accepts catalogGateInWindow/Advisory/FailClosed (Plan 7-R B5.2)", () => {
  const kernel: KernelRunOutcome = {
    runId: "r1", app: "demo", sha: "abc1234", mode: "diff", target: "e2e",
    verdict: "pass", errorClass: null,
    gateSignals: {
      static: true, coverageRatio: 0.8, valueScore: null, reviewerCorrections: [],
      reviewerApproved: true, flaky: false, retries: 0,
      catalogGateInWindow: 3, catalogGateAdvisory: 1, catalogGateFailClosed: 0,
    },
    rulesRetrieved: [], at: "2026-06-24T00:00:00.000Z",
  };
  assert.equal(kernel.gateSignals.catalogGateInWindow, 3);
  assert.equal(kernel.gateSignals.catalogGateAdvisory, 1);
  assert.equal(kernel.gateSignals.catalogGateFailClosed, 0);

  const comparable: ComparableOutcome = { ...kernel };
  assert.equal(runOutcomeEquivalent(comparable, comparable).equal, true);
  const differentFailClosed: ComparableOutcome = {
    ...comparable,
    gateSignals: { ...comparable.gateSignals, catalogGateFailClosed: 2 },
  };
  assert.equal(runOutcomeEquivalent(comparable, differentFailClosed).equal, false);
});

/* RunOutcome carries an optional, widely-typed `adjudication` field — `class: string` (NOT a
   narrow literal union), so the kernel never imports the domain's concrete AdjudicatorClass type
   (adjudicate.service.ts / fix-loop.aggregate.ts). The domain's current producer emits five values
   (app_defect, generated_test_defect, runner_infra, dev_infra, objective_gap) but the kernel type
   must not enumerate or hardcode them.
 */
test("kernel RunOutcome accepts an optional adjudication field, widely typed (class: string)", () => {
  const withAdjudication: KernelRunOutcome = {
    runId: "r1", app: "demo", sha: "abc1234", mode: "diff", target: "e2e",
    verdict: "fail", errorClass: null,
    gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 1 },
    rulesRetrieved: [], at: "2026-06-24T00:00:00.000Z",
    adjudication: { class: "app_defect", confidence: "high", action: "break-issue", reason: "5xx" },
  };
  assert.equal(withAdjudication.adjudication?.class, "app_defect");

  /* Absent case — never fabricated. A run whose FixLoop never invoked the adjudicator omits it. */
  const withoutAdjudication: KernelRunOutcome = {
    runId: "r2", app: "demo", sha: "abc1234", mode: "diff", target: "e2e",
    verdict: "pass", errorClass: null,
    gateSignals: { static: true, coverageRatio: 0.9, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [], at: "2026-06-24T00:00:00.000Z",
  };
  assert.equal(withoutAdjudication.adjudication, undefined);

  /* Wide-string pin: an arbitrary future class value the domain might add later must still satisfy
     the kernel type WITHOUT a kernel edit — the field is `string`, not a literal union.
   */
  const futureClass: KernelRunOutcome = {
    ...withoutAdjudication,
    adjudication: { class: "some_future_class_the_kernel_never_heard_of" },
  };
  assert.equal(futureClass.adjudication?.class, "some_future_class_the_kernel_never_heard_of");
});
