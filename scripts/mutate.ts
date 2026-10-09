/*
 * Mutation-tests ONE critical module against ONLY the test files that exercise it (Stryker, command
 * runner, TypeScript checker). Each preset names the files to mutate — optionally narrowed to the
 * decision logic's line range as `file.ts:start-end` — and the test files that run per mutant, so a
 * run takes minutes, not the whole suite per mutant.
 *
 *   npm run mutate -- <preset>                  full run (every mutant against the preset's tests)
 *   npm run mutate -- <preset> --incremental    re-test only mutants whose source changed
 *   npm run mutate -- <preset> --concurrency=N  run N Stryker workers instead of the default
 *   npm run mutate -- --list              the presets
 *   npm run mutate:keystone               the change-coverage keystone preset
 *
 * Incremental mode is opt-in: the command runner reports the whole test command as ONE test, so
 * Stryker cannot see a test-file change and reuses every earlier result — a strengthened test would
 * leave its survivors stale, and a weakened one would keep its kills. Use it only while editing the
 * mutated source itself.
 *
 * The Stryker config and the checker's tsconfig are generated under os.tmpdir(); the incremental
 * state and the JSON report live under reports/mutation/ (gitignored), the sandbox under
 * .stryker-tmp/ (gitignored). A run deletes the preset's previous JSON report first, so a run that
 * fails before reporting never prints a stale summary. docs/testing-standards.md records each
 * preset's baseline score and `break` threshold: a preset fails its run when its score drops below
 * its own `break`.
 *
 * A timed-out mutant counts as detected in the score (an infinite loop is a real kill), but it is
 * reported apart from killed ones with a killed-only score beside it: under load a slow test run
 * also times out, so a timeout alone proves nothing. Presets whose tests spawn processes (git) set a
 * lower `concurrency` so the workers do not starve each other into timeouts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = "reports/mutation";

export interface MutationThresholds {
  high: number;
  low: number;
  /* The run exits non-zero below this score; null = never fails the run. */
  break: number | null;
}

export interface MutationPreset {
  description: string;
  /* Repo-relative source files, optionally `path.ts:start-end` to mutate only a line range. */
  mutate: readonly string[];
  /* Repo-relative test files that run against every mutant: the module's own tests plus the seam
     tests of its direct consumers — never the whole suite. */
  tests: readonly string[];
  thresholds: MutationThresholds;
  /* Upper bound on Stryker workers, for presets whose tests spawn processes (git). */
  concurrency?: number;
}

const OS = "qa-engine/src/contexts/objective-signal/domain";
const OS_TEST = "qa-engine/test/contexts/objective-signal/domain";
const LEARN = "qa-engine/src/contexts/cross-run-learning/domain";
const LEARN_TEST = "qa-engine/test/contexts/cross-run-learning/domain";
const ORCH = "qa-engine/src/contexts/qa-run-orchestration";
const ORCH_TEST = "qa-engine/test/contexts/qa-run-orchestration";
const GEN = "qa-engine/src/contexts/generation";
const GEN_TEST = "qa-engine/test/contexts/generation";
const PUB = "qa-engine/src/contexts/workspace-and-publication/domain";
const PUB_TEST = "qa-engine/test/contexts/workspace-and-publication/domain";
const PUB_INFRA = "qa-engine/src/contexts/workspace-and-publication/infrastructure";
const OS_INFRA = "qa-engine/src/contexts/objective-signal/infrastructure";
const OS_INFRA_TEST = "qa-engine/test/contexts/objective-signal/infrastructure";
const TOPO = "qa-engine/src/contexts/service-topology/infrastructure";
const TOPO_TEST = "qa-engine/test/contexts/service-topology/infrastructure";
const TE_INFRA = "qa-engine/src/contexts/test-execution/infrastructure";
const TE_INFRA_TEST = "qa-engine/test/contexts/test-execution/infrastructure";

const DEFAULT_THRESHOLDS: MutationThresholds = { high: 90, low: 80, break: null };

export const PRESETS: Readonly<Record<string, MutationPreset>> = {
  keystone: {
    description: "change-coverage keystone: decide/blocks, changed-line assembly, coverage-gap prompt",
    mutate: [`${OS}/decide-coverage.service.ts`, `${OS}/assemble-change-coverage.ts`, `${OS}/render-coverage-gap.ts`],
    tests: [
      `${OS_TEST}/decide-coverage.service.test.ts`,
      `${OS_TEST}/assemble-change-coverage.test.ts`,
      `${OS_TEST}/render-coverage-gap.test.ts`,
      `${ORCH_TEST}/infrastructure/bridges/objective-signal-port.adapter.test.ts`,
    ],
    /* The keystone was already an enforced gate; every other preset starts in signal mode. */
    thresholds: { high: 90, low: 80, break: 80 },
  },
  "rule-learning": {
    description: "cross-run learning: rule governance (promotion/demotion) and the outcome fold",
    mutate: [`${LEARN}/rule-governance.service.ts`, `${LEARN}/rule-fold.ts`],
    tests: [
      `${LEARN_TEST}/rule-governance.service.test.ts`,
      `${LEARN_TEST}/rule-fold.test.ts`,
      "qa-engine/test/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.test.ts",
      `${ORCH_TEST}/infrastructure/bridges/learning-port.adapter.test.ts`,
      "src/server/history.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "fix-loop": {
    description: "FixLoop aggregate: adjudicate → regen → re-execute, filtered-retry scope, regression guard",
    mutate: [`${ORCH}/domain/fix-loop.aggregate.ts`],
    tests: [
      `${ORCH_TEST}/domain/fix-loop.aggregate.test.ts`,
      `${ORCH_TEST}/domain/fix-loop-characterization.test.ts`,
      `${ORCH_TEST}/application/run-qa.use-case.test.ts`,
      `${ORCH_TEST}/application/coordination-fixloop.use-case.test.ts`,
      `${ORCH_TEST}/infrastructure/bridges/generation-port.adapter.test.ts`,
      "qa-engine/test/contract/coordination-seam.contract.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  coordination: {
    description: "coordination routing: acceptance report, pushback authority checks, delegation-failure class, orchestration router",
    mutate: [
      `${ORCH}/application/coordination/acceptance-report.ts`,
      `${ORCH}/application/coordination/pushback.ts`,
      `${ORCH}/application/coordination/delegation-failure-class.ts`,
      `${ORCH}/application/coordination/orchestration-router.ts`,
    ],
    tests: [
      `${ORCH_TEST}/application/coordination-pushback.test.ts`,
      `${ORCH_TEST}/application/coordination-router.test.ts`,
      "qa-engine/test/contract/coordination-phases-5-14.contract.test.ts",
      "qa-engine/test/contract/coordination-disk-and-model.contract.test.ts",
      "qa-engine/test/contract/coordination-delegation.contract.test.ts",
      "qa-engine/test/contract/coordination-sidekick.contract.test.ts",
      "qa-engine/test/contract/coordination-seam.contract.test.ts",
      `${ORCH_TEST}/application/coordination-active.use-case.test.ts`,
      `${ORCH_TEST}/application/coordination-fixloop.use-case.test.ts`,
      "src/server/coordination-events.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "agent-efficiency": {
    description: "agent efficiency metrics: tool taxonomy, call sequence/redundancy, prompt-provided reads, step exhaustion, coarse windows, turn summary, and the in-session call tracker with its call identity",
    mutate: [
      `${GEN}/domain/tool-call-taxonomy.ts`,
      `${GEN}/domain/call-sequence.ts`,
      `${GEN}/domain/provided-context.ts`,
      `${GEN}/domain/step-exhaustion.ts`,
      `${GEN}/domain/coarse-run-efficiency.ts`,
      `${GEN}/domain/turn-efficiency-summary.ts`,
      `${GEN}/infrastructure/sse/call-efficiency-tracker.ts`,
      `${GEN}/infrastructure/sse/call-fingerprint.ts`,
    ],
    tests: [
      `${GEN_TEST}/domain/tool-call-taxonomy.test.ts`,
      `${GEN_TEST}/domain/call-sequence.test.ts`,
      `${GEN_TEST}/domain/provided-context.test.ts`,
      `${GEN_TEST}/domain/step-exhaustion.test.ts`,
      `${GEN_TEST}/domain/coarse-run-efficiency.test.ts`,
      `${GEN_TEST}/domain/turn-efficiency-summary.test.ts`,
      `${GEN_TEST}/infrastructure/sse/call-efficiency-tracker.test.ts`,
      `${GEN_TEST}/infrastructure/sse/call-fingerprint.test.ts`,
      `${GEN_TEST}/infrastructure/sse/event-stream.test.ts`,
      `${GEN_TEST}/infrastructure/agent-transport-policy.test.ts`,
      "qa-engine/test/contract/agent-efficiency-reconcile.contract.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "generation-end": {
    description: "generation end: classification of how a generation ended, its note, the run terminal it maps to, and the learning gates",
    mutate: [
      `${GEN}/domain/generation-end.ts`,
      `${ORCH}/domain/helpers/generation-end-terminal.ts`,
      `${ORCH}/domain/helpers/learning-gates.ts`,
    ],
    tests: [
      `${GEN_TEST}/domain/generation-end.test.ts`,
      `${ORCH_TEST}/domain/helpers/generation-end-terminal.test.ts`,
      `${ORCH_TEST}/domain/helpers/learning-gates.test.ts`,
      `${ORCH_TEST}/domain/helpers/error-class.test.ts`,
      `${ORCH_TEST}/domain/helpers/should-distill-learning.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "precondition-verdict": {
    description: "auth precondition: the typed error, the run terminal it maps to, the E-PRECONDITION class and where it is resolved, and the audit finding that keeps it out of learning",
    mutate: [
      `${ORCH}/domain/auth-precondition.ts`,
      `${ORCH}/domain/helpers/precondition-terminal.ts`,
      /* Only the lines that name and resolve the class: the rest of these modules belongs to other classes. */
      `${ORCH}/domain/helpers/error-class.ts:18-18`,
      `${ORCH}/domain/helpers/error-class.ts:29-29`,
      `${ORCH}/domain/helpers/error-class.ts:111-111`,
      `${LEARN}/process-audit.ts:27-27`,
      `${LEARN}/process-audit.ts:80-87`,
    ],
    tests: [
      `${ORCH_TEST}/domain/auth-precondition.test.ts`,
      `${ORCH_TEST}/domain/helpers/precondition-terminal.test.ts`,
      `${ORCH_TEST}/domain/helpers/error-class.test.ts`,
      `${ORCH_TEST}/domain/helpers/error-class-parity.test.ts`,
      `${ORCH_TEST}/domain/helpers/learning-gates.test.ts`,
      `${LEARN_TEST}/process-audit.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "login-evidence": {
    description: "login evidence: the classifier that reads a login attempt, and the scrubber and note that keep credentials out of what a failed login writes",
    mutate: [`${ORCH}/domain/helpers/login-evidence.ts`],
    tests: [
      `${ORCH_TEST}/domain/helpers/login-evidence.test.ts`,
      `${ORCH_TEST}/domain/helpers/classify-login-evidence.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "route-capturability": {
    description: "route capturability: which route strings name one page a browser can open, which of the map's routes the changed files point at and so come first, the filter and the cut the pack applies to the candidates, and the list of routes left out",
    mutate: [
      "qa-engine/src/shared-kernel/route-capturability.ts",
      `${GEN}/domain/route-ranking.ts`,
      /* Only the lines that rank the derived routes, filter the candidates, cut them, log and list what was left out. */
      `${GEN}/infrastructure/context-pack.ts:129-138`,
      `${GEN}/infrastructure/context-pack.ts:201-209`,
      `${GEN}/infrastructure/context-pack.ts:246-255`,
    ],
    tests: [
      "qa-engine/test/shared-kernel/route-capturability.test.ts",
      `${GEN_TEST}/domain/route-ranking.test.ts`,
      `${GEN_TEST}/infrastructure/context-pack.test.ts`,
      `${GEN_TEST}/infrastructure/dom-snapshot.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "carry-forward": {
    description: "carry-forward of the specs a run delivers: the canonical spec path, the one fold that keeps each spec once with its newest declared text, what a verdict declares, the merge after each pass (the lead refreshes, a sidekick adds paths only), the attribution of a selector contradiction to the specs that raised it, the line of the suite's entry and the listing of the suite for a regeneration (which specs there are, which the turn must change, how many of the others are shown, whether the objective is asked again) with the way it is written into a prompt, and the lines that wire them: the declarations a generation returns, the origin each check gives its contradictions (the pre-exec gate's and Lever-2's, through the FixLoop), the specs each regeneration is handed, the adapter's check that each is still there and the grounding's fold of the manifest into the suite's entries",
    mutate: [
      "qa-engine/src/shared-kernel/spec-path.ts",
      "qa-engine/src/shared-kernel/delivered-spec.ts",
      `${GEN}/domain/declared-specs.ts`,
      `${ORCH}/domain/helpers/delivered-specs.ts`,
      `${ORCH}/domain/helpers/contradiction-attribution.ts`,
      `${GEN}/domain/suite-entry.ts`,
      `${GEN}/domain/suite-listing.ts`,
      `${GEN}/domain/suite-listing-render.ts`,
      /* Only the lines that declare a generation's specs, hand them on and probe them: the rest of these modules is other code. */
      `${GEN}/application/generate-tests.use-case.ts:128-129`,
      `${ORCH}/infrastructure/bridges/generation-port.adapter.ts:104-109`,
      `${ORCH}/infrastructure/bridges/generation-port.adapter.ts:135-136`,
      `${ORCH}/infrastructure/bridges/generation-port.adapter.ts:177-177`,
      /* The grounding's one line that folds the manifest into the suite's entries. */
      `${ORCH}/infrastructure/bridges/pre-generation-grounding-port.adapter.ts:209-209`,
      /* The checks' own lines that say which spec raised a contradiction, and the FixLoop's hand-over of them. */
      `${ORCH}/domain/helpers/selector-check.ts:401-405`,
      `${ORCH}/domain/pre-exec-grounding.service.ts:57-62`,
      `${ORCH}/domain/pre-exec-grounding.service.ts:66-66`,
      `${ORCH}/domain/pre-exec-grounding.service.ts:68-68`,
      `${ORCH}/domain/pre-exec-grounding.service.ts:76-76`,
      `${ORCH}/domain/pre-exec-grounding.service.ts:79-79`,
      `${ORCH}/domain/pre-exec-grounding.service.ts:82-82`,
      `${ORCH}/domain/pre-exec-grounding.service.ts:95-98`,
      `${ORCH}/domain/pre-exec-grounding.service.ts:105-105`,
      `${ORCH}/domain/pre-exec-grounding.service.ts:114-115`,
      `${ORCH}/domain/pre-exec-grounding.service.ts:119-119`,
      `${ORCH}/domain/pre-exec-grounding.service.ts:124-124`,
      `${ORCH}/domain/fix-loop.aggregate.ts:193-193`,
      /* The run's own lines: what it has delivered, the regeneration that is handed it, the merge after the first pass and the sidekick's, and the attribution of each contradiction. */
      `${ORCH}/application/run-qa.use-case.ts:766-776`,
      `${ORCH}/application/run-qa.use-case.ts:1017-1018`,
      `${ORCH}/application/run-qa.use-case.ts:1023-1023`,
      `${ORCH}/application/run-qa.use-case.ts:1110-1111`,
      `${ORCH}/application/run-qa.use-case.ts:1117-1117`,
      `${ORCH}/application/run-qa.use-case.ts:1123-1123`,
      `${ORCH}/application/run-qa.use-case.ts:1126-1129`,
      `${ORCH}/application/run-qa.use-case.ts:1137-1137`,
      `${ORCH}/application/run-qa.use-case.ts:1166-1168`,
      `${ORCH}/application/run-qa.use-case.ts:1371-1371`,
      `${ORCH}/application/run-qa.use-case.ts:1380-1385`,
      `${ORCH}/application/run-qa.use-case.ts:1577-1579`,
      `${ORCH}/application/run-qa.use-case.ts:1600-1601`,
      `${ORCH}/application/run-qa.use-case.ts:1603-1603`,
      `${ORCH}/application/run-qa.use-case.ts:1609-1611`,
      `${ORCH}/application/run-qa.use-case.ts:1623-1623`,
      `${ORCH}/application/run-qa.use-case.ts:1739-1739`,
      `${ORCH}/application/run-qa.use-case.ts:1871-1871`,
    ],
    tests: [
      "qa-engine/test/shared-kernel/spec-path.test.ts",
      "qa-engine/test/shared-kernel/delivered-spec.test.ts",
      `${GEN_TEST}/domain/declared-specs.test.ts`,
      `${GEN_TEST}/application/generate-tests.declared-specs.test.ts`,
      `${ORCH_TEST}/domain/helpers/delivered-specs.test.ts`,
      `${ORCH_TEST}/domain/helpers/contradiction-attribution.test.ts`,
      `${ORCH_TEST}/domain/helpers/selector-check.origins.test.ts`,
      `${ORCH_TEST}/domain/pre-exec-grounding.service.test.ts`,
      `${ORCH_TEST}/domain/fix-loop.aggregate.test.ts`,
      `${GEN_TEST}/domain/suite-entry.test.ts`,
      `${GEN_TEST}/domain/suite-listing.test.ts`,
      `${GEN_TEST}/domain/suite-listing-render.test.ts`,
      `${ORCH_TEST}/infrastructure/bridges/pre-generation-grounding-port.adapter.test.ts`,
      /* Apart from run-qa.use-case.test.ts, whose many tests would all run once per mutant. */
      `${ORCH_TEST}/application/run-qa.carry-forward.test.ts`,
      `${ORCH_TEST}/infrastructure/bridges/generation-port.adapter.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "redirect-advisory": {
    description: "redirect advisory: why a route degraded and where a redirect led, the state line and the advisory block that render it, and the split that keeps the block out of the live DOM section",
    mutate: [
      `${GEN}/infrastructure/route-catalog.ts:14-24`,
      `${GEN}/infrastructure/route-catalog.ts:65-128`,
      /* Only the lines that state a degraded route, build the advisory block and the capture, and warn about a gated app: the tree rendering they call is older code. */
      `${GEN}/infrastructure/dom-snapshot.ts:227-231`,
      `${GEN}/infrastructure/dom-snapshot.ts:251-287`,
      `${GEN}/infrastructure/context-pack.ts:175-178`,
      `${GEN}/infrastructure/context-pack.ts:215-216`,
    ],
    tests: [
      `${GEN_TEST}/infrastructure/route-catalog.test.ts`,
      `${GEN_TEST}/infrastructure/dom-snapshot.test.ts`,
      `${GEN_TEST}/infrastructure/context-pack.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "patch-app-yaml": {
    description: "app config patch: the managed fields of an app's YAML are edited in place, and placeholders, comments and unmanaged keys come out as they went in",
    mutate: ["src/server/onboarding/patch-app-yaml.ts"],
    tests: ["src/server/onboarding/patch-app-yaml.test.ts", "src/server/app-admin.test.ts"],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "prompt-contract": {
    description: "prompt contract: the claims lint, the regeneration predicate, the diff size, the harness-facts export scan and the reader that feeds it, the step milestone, the way a listing of the suite is written into a prompt, with a sample of the matrix that lints the reachable generator prompts",
    mutate: [
      `${GEN}/domain/prompt-contract-lint.ts`,
      `${GEN}/domain/regen-turn.ts`,
      `${GEN}/domain/diff-stat.ts`,
      `${GEN}/domain/harness-facts.ts`,
      `${GEN}/domain/step-limit.ts`,
      `${GEN}/domain/suite-listing-render.ts`,
      `${ORCH}/infrastructure/bridges/pre-generation-grounding-port.adapter.ts:122-171`,
    ],
    tests: [
      `${GEN_TEST}/domain/prompt-contract-lint.test.ts`,
      `${GEN_TEST}/domain/regen-turn.test.ts`,
      `${GEN_TEST}/domain/diff-stat.test.ts`,
      `${GEN_TEST}/domain/harness-facts.test.ts`,
      `${GEN_TEST}/domain/step-limit.test.ts`,
      `${GEN_TEST}/domain/suite-listing-render.test.ts`,
      `${ORCH_TEST}/infrastructure/bridges/pre-generation-grounding-port.harness-facts.test.ts`,
      `${GEN_TEST}/infrastructure/prompt-builders/prompts.regen.test.ts`,
      `${GEN_TEST}/infrastructure/prompt-builders/prompts.scaffold.test.ts`,
      `${GEN_TEST}/infrastructure/prompt-builders/prompts.harness-facts.test.ts`,
      `${GEN_TEST}/infrastructure/prompt-builders/prompts.step-limit.test.ts`,
      `${GEN_TEST}/infrastructure/prompt-builders/prompts.listing.test.ts`,
      "scripts/prompt-contract-matrix.sample.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "step-limit": {
    description: "step limit: the cap each role runs under, read live from the runtime (the agent-list read, the judgment of a cap, the OpenCode mapping and its warnings, the facades' routing by provider), the baked reader's order of names and the per-run memo that hands each role its limit (one read, a deadline, one warning)",
    mutate: [
      "src/agent-runtime/step-limit.ts",
      /* Only the lines that read, judge and route a limit: the rest of these modules is other code. */
      "src/agent-runtime/opencode-strategy.ts:85-102",
      "src/agent-runtime/opencode-strategy.ts:158-166",
      "src/agent-runtime/facades.ts:49-51",
      "src/agent-runtime/facades.ts:103-115",
      "src/integrations/opencode-client.ts:201-202",
      "src/integrations/opencode-client.ts:314-316",
      "src/integrations/opencode-client.ts:324-334",
      /* The factory's per-run memo: the deadline, the role mapping, the one read and its warning. */
      "src/server/rewritten-engine-factory.ts:514-546",
    ],
    tests: [
      "src/agent-runtime/step-limit.test.ts",
      "src/agent-runtime/opencode-strategy.test.ts",
      "src/agent-runtime/facades.test.ts",
      "src/integrations/opencode-agents.test.ts",
      "src/integrations/opencode-client.test.ts",
      /* Apart from rewritten-engine-factory.test.ts, whose many tests would all run once per mutant. */
      "src/server/rewritten-engine-factory.step-limit.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "merge-guard": {
    description: "self-maintainer auto-merge gates: protected paths, change/rate limits",
    mutate: ["src/server/merge-guard.ts"],
    tests: ["src/server/merge-guard.test.ts", "src/server/maintainer-runtime.test.ts"],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "coordination-events": {
    description: "coordination telemetry ledger read model served to the API/TUI",
    mutate: ["src/server/coordination-events.ts"],
    tests: ["src/server/coordination-events.test.ts", "src/server/api.test.ts"],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "local-login": {
    description: "web console local-login policy: loopback peer/flag AND loopback-or-allowlisted Host header",
    mutate: ["src/server/auth.ts:86-167"],
    tests: ["src/server/auth.test.ts", "src/server/api.test.ts"],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "write-confinement": {
    description: "publication write confinement: which paths a publish may touch",
    mutate: [`${PUB}/write-confinement.service.ts`],
    tests: [
      `${PUB_TEST}/write-confinement.service.test.ts`,
      "qa-engine/test/contexts/workspace-and-publication/infrastructure/write-confinement.adapter.test.ts",
      "qa-engine/test/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
    /* Both adapter tests drive real git repositories per case. */
    concurrency: 2,
  },
  "spec-path-confinement": {
    description: "spec path confinement: the one reader of a path an agent reported (the real-path anchor, the refusal of symlinks, parent segments, absolute paths and named pipes, the size cap, the released descriptor, the descriptor tied to the validated file by its identity and by the kernel's path, the file read whole), the strict read, listing, directory and write of the files the orchestrator keeps in the spec directory (no link on the way, a capped listing, a temporary file renamed over the target), the removal of what refuses a read (a name unlinked or a directory set aside, never opened or followed, never outside the spec directory) and the walk of the specs that never follows a link, looks at no more than a cap of entries in all and names what it could not walk, and the walk of the files of a repository that follows no link, counts what is no file, directory or link and is held to a cap of entries and of files, with the sites that read, probe, write, list or remove through them: the manifest's IO, the read gate's manifest check and zero-assertion scan, the context map, what setup reads, copies and replaces in the project (the seed, flows/, the fixtures, ignore, login and config files, the lock and the install marker, which it removes once when the strict read refuses it), the login's stock check and the verdict parser's listing of the suite",
    mutate: [
      "qa-engine/src/shared-infrastructure/spec-path-confinement.ts",
      /* The manifest's file hashes, its strict read (a refusal is "no manifest") and its write (a refusal is thrown). */
      `${GEN}/infrastructure/manifest-fs.ts:7-46`,
      `${GEN}/infrastructure/manifest-fs.ts:79-92`,
      /* The read gate's zero-assertion scan (a spec it cannot vouch for, and a path it could not walk, are findings) and its manifest check, whose output goes back to the agent. */
      "qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks.ts:71-111",
      "qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks.ts:147-159",
      /* The context map: a strict read, and warnings that say nothing of what the file holds. */
      `${ORCH}/infrastructure/bridges/pre-generation-grounding-port.adapter.ts:86-117`,
      /* Setup: the caps, the strict copy of the seed (the mark of a project last) and the wiring of the real strict calls, the entries of .qa that are removed when they are not ordinary, the strict read and replacement of each file of the project (a refusal fails the setup), the removal of what refuses the install marker, and the lock vetted before an install is started. */
      `${PUB_INFRA}/setup.adapter.ts:25-27`,
      `${PUB_INFRA}/setup.adapter.ts:223-275`,
      `${PUB_INFRA}/setup.adapter.ts:285-288`,
      `${PUB_INFRA}/setup.adapter.ts:331-524`,
      `${PUB_INFRA}/setup.adapter.ts:528-529`,
      /* The login's stock check: a strict read whose refusal fails the login. */
      `${ORCH}/infrastructure/auth-session.adapter.ts:73-73`,
      `${ORCH}/infrastructure/auth-session.adapter.ts:231-237`,
      /* The verdict parser's listing of the suite: the one walk of the specs, with its cap. */
      `${GEN}/infrastructure/verdict-parser.adapter.ts:15-18`,
    ],
    tests: [
      "qa-engine/test/shared-infrastructure/spec-path-confinement.test.ts",
      "qa-engine/test/shared-infrastructure/spec-path-confinement.seam.test.ts",
      "qa-engine/test/shared-infrastructure/spec-path-confinement.owned.test.ts",
      "qa-engine/test/shared-infrastructure/spec-path-confinement.listing.test.ts",
      "qa-engine/test/shared-infrastructure/spec-path-confinement.purge.test.ts",
      "qa-engine/test/shared-infrastructure/spec-path-confinement.repo-walk.test.ts",
      /* Lever-2's spec sources, the reviewer's inlining and the review DOM grounding. */
      `${ORCH_TEST}/infrastructure/bridges/generation-port.adapter.test.ts`,
      `${ORCH_TEST}/infrastructure/bridges/review-dom-grounding-port.adapter.test.ts`,
      `${GEN_TEST}/infrastructure/prompt-builders/prompts.test.ts`,
      /* The manifest's file hashes and write, the sidekick's claimed files and the pre-exec capture. */
      `${GEN_TEST}/infrastructure/manifest-fs.test.ts`,
      "qa-engine/test/contract/coordination-disk-and-model.contract.test.ts",
      `${ORCH_TEST}/infrastructure/bridges/pre-exec-grounding-port.adapter.test.ts`,
      /* The read gate's manifest check and zero-assertion scan, the listing of the specs and the context map. */
      "qa-engine/test/contexts/test-execution/infrastructure/static-gate.checks.test.ts",
      `${ORCH_TEST}/infrastructure/bridges/pre-generation-grounding-port.adapter.test.ts`,
      `${ORCH_TEST}/infrastructure/bridges/pre-generation-grounding-port.context-map.test.ts`,
      /* What setup reads and replaces, and the login's stock check. */
      "qa-engine/test/contexts/workspace-and-publication/infrastructure/setup.adapter.confinement.test.ts",
      "qa-engine/test/contexts/workspace-and-publication/infrastructure/setup.adapter.test.ts",
      `${ORCH_TEST}/infrastructure/auth-session.adapter.confinement.test.ts`,
      `${ORCH_TEST}/infrastructure/auth-session.adapter.test.ts`,
      /* The verdict parser's listing of the suite. */
      `${GEN_TEST}/infrastructure/verdict-parser.adapter.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "run-output-readers": {
    description: "what a run of the tests leaves for the orchestrator to read: the strict, capped read of a directory of output and of a native report (never waits on a pipe, never follows a link, never throws, says how many files it left out and why without naming or quoting them, and uses a set of dumps, reports or counters whole or not at all, so that the coverage or the count of a part is never taken for the run's), the coverage dumps and reports, the collector that reads the reports of every kind together, the fault-injection counters and the oracle's reading of the count (an unknown count gives no score), the counter also through the composition root that wires it (whose own lines are broken by hand)",
    mutate: [
      "qa-engine/src/shared-infrastructure/run-output-reader.ts",
      `${OS_INFRA}/coverage-dump-reader.ts`,
      `${OS_INFRA}/target-coverage-collector.ts`,
      `${OS_INFRA}/fault-injection-counter-reader.ts`,
      /* The oracle's reading of the count of corrupted responses: unknown, none, or some. */
      `${OS_INFRA}/fault-injection-oracle.adapter.ts:38-49`,
    ],
    tests: [
      /* The reader's own cases: what a directory that is cut at the entry cap is, to a set used whole and to one scanned. */
      "qa-engine/test/shared-infrastructure/run-output-reader.test.ts",
      `${OS_INFRA_TEST}/coverage-dump-reader.test.ts`,
      `${OS_INFRA_TEST}/coverage-dump-reader.confinement.test.ts`,
      `${OS_INFRA_TEST}/fault-injection-counter-reader.test.ts`,
      `${OS_INFRA_TEST}/fault-injection-oracle.adapter.test.ts`,
      /* The real readers behind the collector the factory builds. */
      `${OS_INFRA_TEST}/target-coverage-collector.test.ts`,
      /* Apart from rewritten-engine-factory.test.ts, whose many tests would all run once per mutant. */
      "src/server/rewritten-engine-factory.fault-injection.test.ts",
      /* The scan that the e2e runner reads the failure dumps with: it uses what it can and keeps going, where the readers above use a set whole or not at all. */
      "qa-engine/test/contexts/test-execution/infrastructure/e2e-execution.runner.confinement.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "e2e-run-reads": {
    description: "what the e2e runner reads back from the Playwright child, which runs code the agent wrote: the JSON report (a strict, capped read that never waits on a pipe or follows a link, and a report that cannot be used is a run with no result, infrastructure and never a pass, said with the reason and nothing the report held) and the failure-capture dumps (each read strictly under a cap, each that cannot be used left out so that its case runs without grounding, said once for the directory with a count and a reason and no file's name or content), with the lines of the runner that read them back and that distrust a pass the child did not exit 0 for (the status or the signal that ended it) and leave the report of a run that is settled unread",
    mutate: [
      /* Why a pass is not believed, and what the runner makes of it. */
      "qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:143-148",
      "qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:260-271",
      /* The caps, the report's read, the dump's decoding and the dumps' read. */
      "qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:347-414",
      /* What the runner does when the child is gone: reads the report unless the run is settled, before the directory it is in is removed (a line apart, which is the removal and not a read), and says why when it could not. */
      "qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:601-603",
      "qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:605-608",
    ],
    tests: [
      "qa-engine/test/contexts/test-execution/infrastructure/e2e-execution.runner.confinement.test.ts",
      "qa-engine/test/contexts/test-execution/infrastructure/e2e-execution.runner.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "v8-coverage-decode": {
    description: "what a V8 browser coverage dump says of the changed files, which the agent's tests wrote: the lines of a changed file that have a byte that ran (a script served at the file's URL, or a bundle read through its source map), decoded in time and memory bounded by the dump's size and not by its numbers (ranges painted from the last back so that every byte is decided once, the lines of a script and the lines of a file bounded, the source map's segments taken one at a time, a script that is no changed file never decoded) and the adapter that adds up what each dump covered",
    mutate: [`${OS_INFRA}/v8-browser-coverage.adapter.ts`],
    tests: [
      `${OS_INFRA_TEST}/v8-browser-coverage.parse.test.ts`,
      `${OS_INFRA_TEST}/v8-browser-coverage.adapter.test.ts`,
      /* The read that reduces each dump as it is read, and the collector the factory builds over it. */
      `${OS_INFRA_TEST}/coverage-dump-reader.test.ts`,
      `${OS_INFRA_TEST}/target-coverage-collector.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "repo-reads": {
    description: "what the orchestrator reads of the mirror of a repository and writes of what it stages from one, directories the agent can write into: the walk of the files of a repository's tree and the reader that skips what it cannot use and says it once without a name or a byte of a file (no link followed, no named pipe opened, entries and sizes bounded), the three boundary resolvers that read the sources and the OpenAPI document of every repository of a system through it, and the staging of a service's context (the service's files listed, read and omitted with a reason when refused, the staging directory emptied and written through the strict calls rooted at the working copy)",
    mutate: [
      "qa-engine/src/shared-infrastructure/repo-reader.ts",
      `${TOPO}/repo-walk.ts`,
      /* The loops that list and read each repository's sources, and the OpenAPI documents. */
      `${TOPO}/event-resolver.adapter.ts:49-59`,
      `${TOPO}/http-backend-resolver.adapter.ts:65-76`,
      `${TOPO}/http-backend-resolver.adapter.ts:83-88`,
      `${TOPO}/http-backend-resolver.adapter.ts:130-130`,
      `${TOPO}/openapi-http-resolver.adapter.ts:269-289`,
      /* The staging: the reset of the directory, what is staged and what is read, the listing, the manifest and the default strict calls. */
      "src/server/service-context.ts:137-138",
      "src/server/service-context.ts:150-152",
      "src/server/service-context.ts:159-167",
      "src/server/service-context.ts:174-174",
      "src/server/service-context.ts:193-204",
      "src/server/service-context.ts:232-233",
      "src/server/service-context.ts:245-282",
    ],
    tests: [
      "qa-engine/test/shared-infrastructure/repo-reader.test.ts",
      `${TOPO_TEST}/resolvers.confinement.test.ts`,
      `${TOPO_TEST}/event-resolver.adapter.test.ts`,
      `${TOPO_TEST}/http-backend-resolver.adapter.test.ts`,
      `${TOPO_TEST}/openapi-http-resolver.adapter.test.ts`,
      "src/server/service-context.confinement.test.ts",
      "src/server/service-context.test.ts",
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "code-run-reads": {
    description: "what a code run reads of its repository's working copy and writes into it, which the agent writes into: the manifest that names the test command (a strict, capped read that never waits on a pipe or follows a link; one that cannot be used is a refusal, said with the reason and nothing the file held, which the project carries: a run of it is infrastructure and the setup of it fails) and the mutation oracle's config (replaced through a temporary file, never written through a link, and a config that cannot be written leaves the run unmeasured without starting Stryker) and report (a strict, capped read; one that cannot be used is a run that produced none)",
    mutate: [
      /* The manifest: what is a refusal, the strict read, the project that carries a refusal, and what a run and a setup make of it. */
      `${TE_INFRA}/code-execution.runner.ts:44-47`,
      `${TE_INFRA}/code-execution.runner.ts:54-81`,
      `${TE_INFRA}/code-execution.runner.ts:92-94`,
      `${TE_INFRA}/code-execution.runner.ts:100-100`,
      `${TE_INFRA}/code-execution.runner.ts:378-387`,
      `${TE_INFRA}/code-setup.ts:40-41`,
      `${OS_INFRA}/stryker-mutation-oracle.adapter.ts:16-17`,
      /* The write of the config (not what the config holds, which is other code) and the read of the report. */
      `${OS_INFRA}/stryker-mutation-oracle.adapter.ts:57-58`,
      `${OS_INFRA}/stryker-mutation-oracle.adapter.ts:74-75`,
      `${OS_INFRA}/stryker-mutation-oracle.adapter.ts:77-100`,
    ],
    tests: [
      `${TE_INFRA_TEST}/code-execution.detect.confinement.test.ts`,
      `${TE_INFRA_TEST}/code-execution.runner.test.ts`,
      `${OS_INFRA_TEST}/stryker-mutation-oracle.confinement.test.ts`,
      `${OS_INFRA_TEST}/stryker-mutation-oracle.adapter.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  "run-decision": {
    description: "run decision: verdict → side effect (pr/issue/shadow-log/quarantine/none)",
    mutate: [`${ORCH}/domain/run-decision.service.ts`, `${ORCH}/domain/run-decision.ts`],
    tests: [
      `${ORCH_TEST}/domain/run-decision.service.test.ts`,
      `${ORCH_TEST}/domain/run-decision.test.ts`,
      `${ORCH_TEST}/domain/run-decision-parity.test.ts`,
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
};

/* Top-level entries never copied into the Stryker sandbox: build outputs, runtime data, the Go TUI,
   the web app and editor/agent state — none of them is read by a preset's tests. */
const SANDBOX_IGNORE = [
  "client",
  "web",
  "data",
  ".mirrors",
  ".omo",
  ".opencode",
  ".superpowers",
  ".sisyphus",
  ".idea",
  ".claude",
  ".atl",
  ".codegraph",
  ".qa-store",
  "qa-engine/.tsbuild",
  "reports",
];

/* The most Stryker workers a run starts by default, and the CPUs it leaves to the rest of the machine. */
export const MAX_WORKERS = 8;
export const FREE_CPUS = 2;

/* At most MAX_WORKERS workers, FREE_CPUS CPUs left free, at least one; a preset's own cap lowers it, the CLI flag overrides both. */
export function concurrencyFor(preset: MutationPreset, opts: { concurrency?: number }, cpus: number): number {
  if (opts.concurrency !== undefined) return opts.concurrency;
  const machine = Math.max(1, Math.min(MAX_WORKERS, cpus - FREE_CPUS));
  return preset.concurrency === undefined ? machine : Math.min(machine, preset.concurrency);
}

export function reportPathFor(root: string, name: string): string {
  return join(root, REPORT_DIR, `${name}.json`);
}

/* The incremental state stays: --incremental reads it. */
export function clearPreviousReport(root: string, name: string): void {
  rmSync(reportPathFor(root, name), { force: true });
}

export function sourcePathOf(entry: string): string {
  return entry.replace(/:\d+(-\d+)?$/, "");
}

/* Why a `path.ts:start-end` entry cannot narrow a file of `lineCount` lines, or undefined when it can; an entry with no range names the whole file. */
export function rangeProblemOf(entry: string, lineCount: number): string | undefined {
  if (sourcePathOf(entry) === entry) return undefined;
  const range = /:(\d+)-(\d+)$/.exec(entry);
  if (range === null) return "the suffix is not a start-end line range";
  const start = Number(range[1]);
  const end = Number(range[2]);
  if (start < 1) return "the range starts before line 1";
  if (end < start) return "the range ends before it starts";
  if (end > lineCount) return `the range ends at line ${end} but the file has ${lineCount} lines`;
  return undefined;
}

/* The preset's tests, run in their own process group (scripts/run-in-group.mjs) so a timed-out run's
   test-file processes die with it instead of spinning on an infinite-loop mutant. */
export function testCommandFor(preset: MutationPreset): string {
  const tests = preset.tests.map((t) => JSON.stringify(t)).join(" ");
  return `node scripts/run-in-group.mjs node --import ./test-setup.mjs --import tsx --test ${tests}`;
}

/* The checker type-checks the mutated files (and what they import) with the options of the project
   they belong to; `references` are not inherited through `extends`, so this runs in single-project
   mode. allowImportingTsExtensions lets src/ files pull in qa-engine sources, which import with `.ts`.
   The file lives under os.tmpdir(), so typeRoots points back at the repo's @types. */
export function checkerTsconfigFor(preset: MutationPreset, root: string): object {
  const sources = preset.mutate.map(sourcePathOf);
  const inQaEngine = sources.every((s) => s.startsWith("qa-engine/"));
  return {
    extends: join(root, inQaEngine ? "qa-engine/tsconfig.json" : "tsconfig.json"),
    compilerOptions: {
      noEmit: true,
      composite: false,
      declaration: false,
      emitDeclarationOnly: false,
      allowImportingTsExtensions: true,
      typeRoots: [join(root, "node_modules", "@types")],
    },
    files: sources.map((s) => join(root, s)),
    include: [],
  };
}

export function strykerConfigFor(
  name: string,
  preset: MutationPreset,
  opts: { tsconfigFile: string; concurrency: number; incremental: boolean },
): object {
  return {
    packageManager: "npm",
    testRunner: "command",
    commandRunner: { command: testCommandFor(preset) },
    coverageAnalysis: "off",
    checkers: ["typescript"],
    tsconfigFile: opts.tsconfigFile,
    /* Stryker's default inserts `// @ts-nocheck` into every JS and TS file of the sandbox, which changes the bytes a test may hash (the stock check of a shipped seed). The tests run through tsx, which does not type-check, and the checker reads the project's own files, so nothing needs the comment. */
    disableTypeChecks: false,
    mutate: [...preset.mutate],
    incremental: opts.incremental,
    incrementalFile: `${REPORT_DIR}/${name}.incremental.json`,
    reporters: ["clear-text", "progress", "json"],
    jsonReporter: { fileName: `${REPORT_DIR}/${name}.json` },
    ignorePatterns: SANDBOX_IGNORE,
    thresholds: preset.thresholds,
    timeoutMS: 15000,
    concurrency: opts.concurrency,
  };
}

interface ReportMutant {
  status: string;
  mutatorName: string;
  replacement?: string;
  location: { start: { line: number; column: number } };
}

export interface MutationSummary {
  mutants: number;
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  compileErrors: number;
  /* Mutants a `// Stryker disable` directive excludes. */
  ignored: number;
  /* (killed + timeout) / (killed + timeout + survived + noCoverage), in percent; null when nothing was valid. */
  score: number | null;
  /* killed / (killed + timeout + survived + noCoverage): the score without trusting a single timeout. */
  killedScore: number | null;
  survivors: string[];
}

export function summarize(report: { files: Record<string, { mutants: ReportMutant[] }> }): MutationSummary {
  const count = { Killed: 0, Survived: 0, Timeout: 0, NoCoverage: 0, CompileError: 0, Ignored: 0 } as Record<string, number>;
  const survivors: string[] = [];
  let mutants = 0;
  for (const [file, { mutants: list }] of Object.entries(report.files)) {
    for (const m of list) {
      mutants += 1;
      count[m.status] = (count[m.status] ?? 0) + 1;
      if (m.status === "Survived" || m.status === "NoCoverage") {
        const at = `${file}:${m.location.start.line}:${m.location.start.column}`;
        survivors.push(`${m.status.padEnd(10)} ${at}  ${m.mutatorName}  ${JSON.stringify(m.replacement ?? "")}`);
      }
    }
  }
  const killed = count.Killed ?? 0;
  const survived = count.Survived ?? 0;
  const timeout = count.Timeout ?? 0;
  const noCoverage = count.NoCoverage ?? 0;
  const valid = killed + timeout + survived + noCoverage;
  const percent = (n: number) => (valid === 0 ? null : Math.round((n / valid) * 10000) / 100);
  return {
    mutants,
    killed,
    survived,
    timeout,
    noCoverage,
    compileErrors: count.CompileError ?? 0,
    ignored: count.Ignored ?? 0,
    score: percent(killed + timeout),
    killedScore: percent(killed),
    survivors,
  };
}

function usage(): string {
  const lines = Object.entries(PRESETS).map(([n, p]) => `  ${n.padEnd(20)} ${p.description}`);
  return `usage: npm run mutate -- <preset> [--incremental] [--concurrency=N]\n\npresets:\n${lines.join("\n")}`;
}

export interface RunOptions {
  list: boolean;
  preset: string | undefined;
  /* Off unless asked for: see the incremental note at the top of this file. */
  incremental: boolean;
  /* --concurrency=N with a positive integer N; otherwise the preset/machine default. */
  concurrency?: number;
}

export function runOptionsFrom(argv: readonly string[]): RunOptions {
  const flag = argv.find((a) => a.startsWith("--concurrency="));
  const concurrency = flag === undefined ? NaN : Number(flag.slice("--concurrency=".length));
  return {
    list: argv.includes("--list"),
    preset: argv.find((a) => !a.startsWith("--")),
    incremental: argv.includes("--incremental"),
    ...(Number.isInteger(concurrency) && concurrency > 0 ? { concurrency } : {}),
  };
}

function main(argv: string[]): number {
  const opts = runOptionsFrom(argv);
  if (opts.list) {
    console.log(usage());
    return 0;
  }
  const name = opts.preset;
  const preset = name === undefined ? undefined : PRESETS[name];
  if (name === undefined || preset === undefined) {
    console.error(name === undefined ? usage() : `unknown preset "${name}"\n\n${usage()}`);
    return 2;
  }

  const workDir = mkdtempSync(join(tmpdir(), `qayaba-mutate-${name}-`));
  try {
    const tsconfigFile = join(workDir, "tsconfig.json");
    writeFileSync(tsconfigFile, JSON.stringify(checkerTsconfigFor(preset, ROOT), null, 2));
    const configFile = join(workDir, "stryker.conf.json");
    const concurrency = concurrencyFor(preset, opts, availableParallelism());
    writeFileSync(
      configFile,
      JSON.stringify(strykerConfigFor(name, preset, { tsconfigFile, concurrency, incremental: opts.incremental }), null, 2),
    );

    clearPreviousReport(ROOT, name);
    console.log(`mutate ${name}: ${concurrency} worker(s)`);
    const strykerArgs = ["run", configFile];
    const run = spawnSync(join(ROOT, "node_modules", ".bin", "stryker"), strykerArgs, { cwd: ROOT, stdio: "inherit" });
    if (run.error) throw run.error;

    const reportFile = reportPathFor(ROOT, name);
    if (existsSync(reportFile)) {
      const s = summarize(JSON.parse(readFileSync(reportFile, "utf8")));
      console.log(`\nmutate ${name}: ${s.mutants} mutants — killed ${s.killed}, timeout ${s.timeout}, survived ${s.survived}, no-coverage ${s.noCoverage}, compile-error ${s.compileErrors}, ignored ${s.ignored}, score ${s.score ?? "n/a"}% (killed only ${s.killedScore ?? "n/a"}%)`);
      for (const line of s.survivors) console.log(`  ${line}`);
    }
    return run.status ?? 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
