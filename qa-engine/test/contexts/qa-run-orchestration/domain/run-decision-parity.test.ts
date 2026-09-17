import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type RunEvidence } from "@contexts/qa-run-orchestration/domain/run-decision.service.ts";

/* Flaky is the one declared widening: the characterization harness can only observe "none"
   (flaky never calls publish or openIssue), while decide() returns "quarantine". Do not map
   one onto the other. Every other verdict's sideEffect must match the harness literal. */

interface ParityCase {
  scenario: string;
  evidence: RunEvidence;
  expectedVerdict: string;
  /* The harness's literal EXPECTED_SIDE_EFFECT/EXPECTED_SIDE_EFFECT_B2 value (deps-call-observable). */
  expectedHarnessSideEffect: "pr" | "issue" | "shadow-log" | "none";
}

/* ── Part 1: the 10 scenarios.ts goldens (GATE A) — mirrors EXPECTED_VERDICT/EXPECTED_SIDE_EFFECT
   from golden-outcome.test.ts:94-117 exactly. Evidence transcribed from each scenario's
   AppConfig/deps in scenarios.ts (see the per-case comment for the exact source).
 */
const goldenCases: ParityCase[] = [
  {
    /* scenarioApp (needsReview:true), makeDeps({}) → generated (approved:true), passing(), no
       coverage config (blocksPublish=false), not shadow. Source: scenarios.ts:226-234.
     */
    scenario: "green-pr",
    evidence: { verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "pass",
    expectedHarnessSideEffect: "pr",
  },
  {
    /* scenarioApp, makeDeps({ run: fail }) — verdict!=='pass' short-circuits before any pass-path
       evidence matters. Source: scenarios.ts:236-246.
     */
    scenario: "fail-issue",
    evidence: { verdict: "fail", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "fail",
    expectedHarnessSideEffect: "issue",
  },
  {
    scenario: "flaky-quarantine",
    evidence: { verdict: "flaky", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "flaky",
    expectedHarnessSideEffect: "none", /* decide()'s domain sideEffect is "quarantine" — see the pin loop below */
  },
  {
    /* scenarioApp, makeDeps({ agent: noopAgent }) — the classify-skip/no-op path never reaches
       generating's pass-path chain regardless of the flag's own value. Source: scenarios.ts:260-268.
     */
    scenario: "no-op-skip",
    evidence: { verdict: "skipped", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "skipped",
    expectedHarnessSideEffect: "none",
  },
  {
    /* scenarioApp, makeDeps({ validation: { ok:false, ... } }) — verdict!=='pass' short-circuits.
       Source: scenarios.ts:270-280.
     */
    scenario: "invalid-issue",
    evidence: { verdict: "invalid", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "invalid",
    expectedHarnessSideEffect: "issue",
  },
  {
    /* scenarioApp, makeDeps({ healthy: false }) — verdict!=='pass' short-circuits. Source:
       scenarios.ts:282-290.
     */
    scenario: "infra-error",
    evidence: { verdict: "infra-error", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "infra-error",
    expectedHarnessSideEffect: "none",
  },
  {
    /* codeApp (needsReview:true), makeDeps({ isCodeMode: true }) → generated (approved:true),
       passing(). Code mode reuses the SAME pass-path chain (report()/decide are verdict-shaped,
       not e2e-vs-code-shaped). Source: scenarios.ts:292-300.
     */
    scenario: "code-mode",
    evidence: { verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "pass",
    expectedHarnessSideEffect: "pr",
  },
  {
    /* crossApp (needsReview:false, shadow:false explicit), makeDeps({ isCrossRepo: true }) →
       generated (approved:true), passing(). Source: scenarios.ts:302-322.
     */
    scenario: "cross-repo",
    evidence: { verdict: "pass", generating: true, needsReview: false, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "pass",
    expectedHarnessSideEffect: "pr",
  },
  {
    /* shadowApp (needsReview:true, shadow:true), makeDeps({}) → generated (approved:true),
       passing(). Source: scenarios.ts:324-332.
     */
    scenario: "shadow",
    evidence: { verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: true, onFailure: "github-issue" },
    expectedVerdict: "pass",
    expectedHarnessSideEffect: "shadow-log",
  },
  {
    /* scenarioApp, context mode's own generate() stub returns { approved: true, reviewed: false },
       passing(). Context mode's early-return path is synthesized by the harness/adapter but the
       VERDICT it reproduces is real: pass, reviewer-approved, no coverage block configured, not
       shadow → the same green-publish branch. Source: scenarios.ts:334-351.
     */
    scenario: "context",
    evidence: { verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "pass",
    expectedHarnessSideEffect: "pr",
  },
];

/* EXPECTED_SIDE_EFFECT_B2 from golden-outcome.test.ts:145-170 exactly. Evidence transcribed
   from each scenario's AppConfig/deps in scenarios.ts's buildScenarioDepsB2 (per-case source line
   noted below).
 */
const goldenCasesB2: ParityCase[] = [
  {
    /* scenarioApp (needsReview:true); the static-gate repair loop recovers on the regen round, so
       by decide-time the run is a clean pass. Source: scenarios.ts:381-398.
     */
    scenario: "static-repair-recovers",
    evidence: { verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "pass",
    expectedHarnessSideEffect: "pr",
  },
  {
    /* covApp("enforce") (needsReview:true, spread from scenarioApp); the improvement regen produces
       no new specs so the coverage gap never closes → blocksPublish=true. Verdict stays "pass" —
       the harness's own comment (golden-outcome.test.ts:160) confirms blocksPublish holds the PR
       WITHOUT reclassifying RunOutcome.verdict. Source: scenarios.ts:400-428.
     */
    scenario: "coverage-enforce-blocks",
    evidence: { verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: true, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "pass",
    expectedHarnessSideEffect: "issue",
  },
  {
    /* covApp("enforce"); the second collectCoverage (after the improvement regen) reports full
       coverage → the gap closes, blocksPublish=false. Source: scenarios.ts:430-454.
     */
    scenario: "coverage-enforce-improves",
    evidence: { verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "pass",
    expectedHarnessSideEffect: "pr",
  },
  {
    /* covApp("enforce"); collectCoverage returns null (unmeasured) — decideCoverage("unknown")
       NEVER blocks, even in enforce mode (the keystone invariant) → blocksPublish=false. Source:
       scenarios.ts:456-470.
     */
    scenario: "coverage-enforce-unknown",
    evidence: { verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "pass",
    expectedHarnessSideEffect: "pr",
  },
  {
    /* fixLoop.maxRetries=0 disables the fix-loop entirely; a permanently-failing single execute
       never retries — verdict stays "fail". verdict!=='pass' short-circuits before any pass-path
       evidence matters. Source: scenarios.ts:472-488.
     */
    scenario: "fixloop-maxretries-zero",
    evidence: { verdict: "fail", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "fail",
    expectedHarnessSideEffect: "issue",
  },
  {
    /* scenarioApp with needsReview:false override; the adjudicator classifies the failure as
       app_defect → an Issue is filed, verdict stays "fail". Source: scenarios.ts:490-522.
     */
    scenario: "adjudicator-app-defect",
    evidence: { verdict: "fail", generating: true, needsReview: false, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "fail",
    expectedHarnessSideEffect: "issue",
  },
  {
    /* scenarioApp with needsReview:false override; the adjudicator classifies the failure as
       runner_infra → verdict becomes "infra-error", no repo Issue. Source: scenarios.ts:524-553.
     */
    scenario: "adjudicator-runner-infra",
    evidence: { verdict: "infra-error", generating: true, needsReview: false, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "infra-error",
    expectedHarnessSideEffect: "none",
  },
  {
    /* scenarioApp with needsReview:false override; two retries with an identical failing case →
       decideProgress returns false → break-needs-human fires: verdict stays "fail", Issue filed.
       Source: scenarios.ts:555-584.
     */
    scenario: "adjudicator-ambiguous-break",
    evidence: { verdict: "fail", generating: true, needsReview: false, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "fail",
    expectedHarnessSideEffect: "issue",
  },
  {
    /* scenarioApp; a strict-mode ambiguity persists after the corrective regen → the deterministic
       pre-exec block holds the run BEFORE execution as "invalid" (a distinct gate from the static-
       validate invalid already covered by invalid-issue). verdict!=='pass' short-circuits. Source:
       scenarios.ts:586-605.
     */
    scenario: "w2-preexec-block",
    evidence: { verdict: "invalid", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "invalid",
    expectedHarnessSideEffect: "issue",
  },
  {
    /* codeApp; the compile gate reports infra:true (broken toolchain) → verdict becomes
       "infra-error", no Issue, no execute. Source: scenarios.ts:607-624.
     */
    scenario: "codemode-infra-toolchain",
    evidence: { verdict: "infra-error", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "infra-error",
    expectedHarnessSideEffect: "none",
  },
  {
    /* scenarioApp; the agent builds a context map but it fails validateContextFn → context mode
       returns "invalid" and files an Issue — a distinct verdict from the clean-pass "context"
       golden above. verdict!=='pass' short-circuits. Source: scenarios.ts:627-640.
     */
    scenario: "context-invalid",
    evidence: { verdict: "invalid", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "invalid",
    expectedHarnessSideEffect: "issue",
  },
];

/* ── Part 3: the pipeline-codex.test.ts scenarios with a real decide-relevant outcome (the harness
   replays 3 codex scenarios that assert a verdict/sideEffect; a 4th is a pure config-shape
   assertion that never calls runPipeline — not decide-relevant, so not included here). Mirrors
   golden-outcome.test.ts:246-305.
 */
const codexCases: ParityCase[] = [
  {
    /* codexApp (needsReview:false), a green single-provider codex run → pass, PR published.
       Source: golden-outcome.test.ts:247-259.
     */
    scenario: "pipeline-codex.ts:green-pass",
    evidence: { verdict: "pass", generating: true, needsReview: false, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "pass",
    expectedHarnessSideEffect: "pr",
  },
  {
    /* codexApp; the SAME green fixture as green-pass, only the assertion differs (usage
       attribution, not decide-relevant beyond verdict/sideEffect). Source:
       golden-outcome.test.ts:260-283.
     */
    scenario: "pipeline-codex.ts:usage-attribution",
    evidence: { verdict: "pass", generating: true, needsReview: false, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue" },
    expectedVerdict: "pass",
    expectedHarnessSideEffect: "pr",
  },
  /* "pipeline-codex.ts:infra-error-propagates" is deliberately EXCLUDED: it asserts the adapter
     THROWS (an AgentUnavailableError from generate()) rather than returning any RunOutcome for
     decide() to consume — there is no verdict/sideEffect for a thrown-before-verdict error to pin
     against. See golden-outcome.test.ts:284-304 and its expectThrows handling.
   */
];

const allCases: ParityCase[] = [...goldenCases, ...goldenCasesB2, ...codexCases];

test("parity pin: the golden/B2/codex scenario set is non-trivial (guards against an accidentally-empty pin)", () => {
  assert.equal(allCases.length, 23, "expected exactly 10 goldens + 11 B2 scenarios + 2 decide-relevant codex scenarios");
});

for (const c of allCases) {
  test(`parity pin — ${c.scenario}: decide(evidence) matches the golden verdict + side effect`, () => {
    const decision = decide(c.evidence);
    assert.equal(decision.verdict, c.expectedVerdict, `${c.scenario}: verdict mismatch`);

    /* Flaky → quarantine here; the harness probe can only see "none" for that path. */
    const expectedDomainSideEffect = decision.verdict === "flaky" ? "quarantine" : c.expectedHarnessSideEffect;
    assert.equal(decision.sideEffect, expectedDomainSideEffect, `${c.scenario}: sideEffect mismatch`);
  });
}
