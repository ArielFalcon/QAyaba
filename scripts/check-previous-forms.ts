/* The CI gate that keeps retired forms retired: banned terms (a name or sentence that describes a previous form of the system) and dead file references (a path or a `file.ts:LINE` citation that points at nothing). Hits are allowed only through scripts/previous-forms.allow.json, and an allow-list entry that matches nothing fails the run, so the list only shrinks. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BannedRule {
  id: string;
  patterns: RegExp[];
  /** Folders where the rule does not apply: the records cite a retired name on purpose. */
  exemptPrefixes?: string[];
}

export interface AllowEntry {
  rule: string;
  path: string;
  contains: string;
  reason: string;
}

export interface Violation {
  rule: string;
  path: string;
  line: number;
  text: string;
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface CheckResult {
  violations: Violation[];
  allowed: number;
  unusedAllow: AllowEntry[];
}

const RECORDS_PREFIX = "docs/architecture/";
/* The seed revisions the setup adapter upgrades are kept byte-for-byte as they shipped, so they name what the seed has since dropped. */
/* The tests that pin what a retired name leaves behind (a stored row that still carries the value fields, a grade that is no longer emitted): they have to write the names. */
const RETIRED_FIELD_TESTS = [
  "src/server/persistence/repositories/learning.repository.retired-fields.test.ts",
  "qa-engine/test/contexts/evaluation/retired-graders.test.ts",
];
const SHIPPED_SEED_REVISIONS_PREFIX = "qa-engine/test/contexts/workspace-and-publication/infrastructure/__fixtures__/seed-revisions/";

export const BANNED_RULES: BannedRule[] = [
  { id: "engine-flag", patterns: [/PIPELINE_ENGINE/i, /pipeline-engine-flag/i, /selectEngine/i] },
  { id: "rewritten-name", patterns: [/Rewritten[A-Z]/, /rewritten-(engine|orchestrator)/i, /rewritten (engine|path|adapters?|orchestrator|publish)/i] },
  { id: "legacy", patterns: [/\blegacy\b/i, /\bLegacy[A-Z]/, /\blegacy[A-Z]/] },
  { id: "bridges", patterns: [/\bbridges?\//i, /wireBridges/i, /bridge adapters?/i, /grounding bridges/i, /the bridges/i] },
  { id: "codex", patterns: [/codex/i] },
  { id: "dual-mode", patterns: [/dual[- ](mode|runtime|agent)/i, /AGENT_RUNTIME_MODE/i, /\bAgentMode\b/i, /SingleAgentFacade/i, /DualAgentFacade/i] },
  { id: "router-kind", patterns: [/"router"/i, /orchestration-router/i, /RETIRED_EXPLORER_ROLE/i, /coordinationMode/i, /qa\.explorer/i] },
  /* The configuration key is `qa.changeCoverage.mode` (ADR-0005); `qa.coveragePolicy` is the spelling the documents drifted to. The records quote it on purpose. */
  { id: "coverage-policy-key", patterns: [/\bqa\.coveragePolicy\b/], exemptPrefixes: [RECORDS_PREFIX] },
  { id: "claude-md", patterns: [/CLAUDE\.md/i] },
  { id: "codebase-memory", patterns: [/codebase-memory/i] },
  { id: "shell-error-taxonomy", patterns: [/\bsrc\/errors\b/], exemptPrefixes: [RECORDS_PREFIX] },
  {
    id: "unreached-engine-ports",
    patterns: [/\b(RepoInfoPort|ComplexityExtractorPort|PatternExtractorPort|RelationExtractorPort|SemanticDiffExtractorPort|SymbolExtractorPort|ExtractorSet|StaticSignal|ExtractionContext|DomGroundingPort|PlanParserPort|CodeValidatePort)\b/],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  { id: "ast-grep-flag", patterns: [/\bhasAstGrepRules\b/, /\bastGrep\b/], exemptPrefixes: [RECORDS_PREFIX] },
  { id: "api-token-resolver", patterns: [/\bresolveApiToken\b/], exemptPrefixes: [RECORDS_PREFIX] },
  { id: "bound-before-redact", patterns: [/\bboundEvidenceText\b/], exemptPrefixes: [RECORDS_PREFIX] },
  { id: "sanitizer-prompt-cap", patterns: [/\bcapText\b/, /\bMAX_PROMPT_BODY_CHARS\b/], exemptPrefixes: [RECORDS_PREFIX] },
  { id: "secret-audit-record", patterns: [/\bSECRET_AUDIT(?:_MAX)?\b/, /\brecordAudit\b/], exemptPrefixes: [RECORDS_PREFIX] },
  { id: "lifecycle-shutting-down-setter", patterns: [/\bsetShuttingDown\b/], exemptPrefixes: [RECORDS_PREFIX] },
  { id: "default-models-table", patterns: [/\bDEFAULT_MODELS\b/], exemptPrefixes: [RECORDS_PREFIX] },
  { id: "fallback-models-table", patterns: [/\bFALLBACK_MODELS\b/], exemptPrefixes: [RECORDS_PREFIX] },
  { id: "proposer-model-pin", patterns: [/\bPROPOSER_MODEL\b/], exemptPrefixes: [RECORDS_PREFIX] },
  {
    id: "self-maintainer-runtime",
    patterns: [
      /\b(maintainer-(?:runtime|memory|summary)|merge-guard|self-update|boot-guard|qayaba-self)\b/,
      /\bSELF_MAINTAINER_[A-Z_]+\b/,
      /\b(QAYABA_REPO|DEFAULT_SELF_REPO|selfRepo|PROTECTED_MIRROR_NAMES|PROTECTED_PATHS)\b/,
      /\b(recordIncident|recordEngineIncident|triggerMaintainer|handleMaintainerApi|getMaintainerStatus|createMaintainerRuntime|installUnhandledRejectionRecorder)\b/,
      /\/api\/maintainer\b/,
      /\bqa-maintainer\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "code-target",
    patterns: [
      /--target\s+["']?code\b/,
      /^\s*#?\s*code:\s*true\s*$/,
      /\bisCodeApp\b/,
      /\bcode[- ]mode\b/i,
      /\bcode target\b/i,
      /\bGO_VERSION\b/,
      /\b(?:CodeExecutionStrategy|CodeValidationStrategy|CodeSetup|CodeProject|isCodeDenied|StrykerMutationOracle|readNativeReports|NativeReports|CoverageCollectorAdapter|LcovCoverageAdapter|C8CoverageAdapter|JacocoCoverageAdapter|createCodeValidateDeps|validateCodeProject|detectCodeProject)\b/,
      /\b(?:stryker-mutation-oracle|code-execution\.(?:runner|strategy)|code-setup|code-validation\.strategy|test-run-evidence|lcov-coverage|c8-coverage|jacoco-coverage|coverage-collector\.adapter|code-run-reads)\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "intelligence-view",
    patterns: [
      /\b(?:IntelligenceView|LearningRuleView|ScorecardView|CurriculumView)(?:Schema)?\b/,
      /\b(?:loadIntelligenceView|toIntelligenceView|getIntelligence|getAppIntelligence|appIntelligence|intelligence-view|intelligenceModel|screenIntelligence|intelligenceSelectedMsg)\b/,
      /\/apps\/(?:\{name\}|:name)\/intelligence\b/,
      /\bqayaba\.reflector\.enabled\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "reflector",
    patterns: [
      /\b(?:qa-reflector|QA_REFLECTOR_ENABLED|REFLECTOR_TIMEOUT_MS|REFLECTOR_ENABLED_ENV|REFLECT_TIMEOUT_MS)\b/,
      /\b(?:reflector-switch|reflector-port\.adapter|reflector\.port|resolveReflectorEnabled|ReflectorPort|ReflectorPortAdapter|reflectorPort|reflectorEnabled|reflectorTimeoutMs)\b/,
      /\b(?:ReflectionInput|toReflectionInput|updateRunOutcomeReflection)\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "rule-loop",
    patterns: [
      /\b(?:renderLearnedRules|renderLearnedRulesForReviewer|RuleGovernanceService|FoldRunOutcome|QuarantineLearnedRulesUseCase|LearningPortAdapter|StubLearningRepository|SqliteLearningRepository|LearningRepositoryPort|LearningStorePort|LearningPort|historyLearningStore|reflectorUnproven|attributableRules|LEARNING_RULE_LEDGER_LIMIT|showLearning|TracedLearningPort)\b/,
      /\b(?:rule-fold|rule-governance|render-learned-rules|learning-quarantine|ledger-cli|ledger-report|learning-rule|learning-port\.adapter|learned-rule-model|distill-rule)\b/,
      /\b(?:learned-rules|reviewer-learned-rules|learnedRules|rulesRetrieved|retrievedRuleIds|retrievedRules|retrievalRelevance|rule-learning|learning:quarantine)\b/,
      /\b(?:retrieve-rules|LearningRule|RetrievedRule|RuleView|readRules|deprecateRule|ledger-heal|noise-rule)\b/,
      /--learning\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "curriculum",
    patterns: [
      /\b(?:CurriculumPortAdapter|CurriculumPort|TracedCurriculumPort|CurriculumFoldInput|foldCurriculum|initCurriculum|loadCurriculum|saveCurriculum|CURRICULUM_CORRUPT|MAX_SELECTED_EXEMPLARS)\b/,
      /\b(?:SelectedExemplar|SkillExemplar|skillExemplars|selectedExemplars|offeredArchetypes|diffArchetypes|renderExemplarsForPrompt|matchExemplars|BUILT_IN_EXEMPLARS|ALL_ARCHETYPES|ScenarioArchetype|detectStructuralPatterns)\b/,
      /\b(?:read-diff-shapes|select-exemplars|readDiffShapes|selectExemplars|skill-exemplars|scenario-catalog|scenario-archetype|structural-pattern|learned-rule|curriculum-port\.adapter|curriculum-model|db:curriculum)\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "value-oracle-trend",
    patterns: [
      /\b(?:ValueTrendSchema|ValueTrend|loadScorecard|oracle-types|ScorecardEntry)\b/,
      /\bTrendsView\.valueOracle\b/,
      /\bSignalsView\.valueOracle\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "response-value-oracle",
    patterns: [
      /\b(?:FaultInjectionOracleAdapter|NullValueOracleAdapter|ValueOraclePort|ValueOracleResult|ValueOraclePolicy|resolveValueOraclePolicy|FaultAim|FaultAimCandidate|faultAimOf|faultAim|scoreFaultInjection|FaultInjectionScore|CandidateValueUnscored|isFlowBreak|FLOW_BREAK|faultInject|faultOperations|oraclePolicy|faultOperationsFromEnv|faultOperationFor|corruptValues|faultCounterSequence|seed-fault-operations)\b/,
      /\b(?:fault-injection-oracle|null-value-oracle|value-oracle\.port|fault-injection-score|fault-aim|fault-calibration|fault-calibrate)\b/,
      /\b(?:CalibrationVerdict|CalibrationReplicate|CandidateCalibration|MAX_REPLICATE_SPREAD|MIN_APPLICABLE_SHARE|MAX_FLOW_BREAK_SHARE)\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX, SHIPPED_SEED_REVISIONS_PREFIX],
  },
  {
    id: "value-fields",
    patterns: [/\b(?:valueScore|valueByCandidate|valueStats|valueStale|mutantCount|killedCount|CandidateValue|ValueStats|mutation_value|E-VALUE-SURVIVED)\b/],
    exemptPrefixes: [RECORDS_PREFIX, SHIPPED_SEED_REVISIONS_PREFIX, ...RETIRED_FIELD_TESTS],
  },
  {
    id: "llm-judges",
    patterns: [
      /\b(?:RunJudgesUseCase|CalibrateJudgeUseCase|JudgeService|composeJudges|JudgeAgentPort|JudgeLedgerPort|JudgeRegradePort|JudgeEvidencePort|CalibrationPairsPort|CalibrationStorePort|JudgeRepository|JudgeCatalogEntry|judgeCatalog|judgeLabelSpec|JUDGE_WORKDIR|JUDGE_NAMES)\b/,
      /\b(?:qa-judge|judge-calibrate|judge-service|judge-agent|judge-settings|judges-composition|judge-adapters|judge-calibration|enqueueIdle|abortIdle)\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "qa-explore",
    patterns: [
      /\b(?:CODE_GRAPH_EXPLORE_AGENT|AGENT_BROWSER_READ_ONLY_AGENTS|EXPLORE_BRIEF_SECTIONS|EXPLORE_BUDGET_MS|EXPLORE_CALL_SHARE|admitExploreRequest|runExploreRound|assembleExploreBrief|assembleExploreOutcome|renderExploreBrief|renderExploreOutcome|backExploreFindings|shapeExploreFindings|graphHoldsSymbol|requestIsReadOnly)\b/,
      /\b(?:qa-explore|explore-kind|explore-round|explore-request|explore-verification|explore-ids|explore-brief|lead-explore-outcome)\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "escalated-model",
    patterns: [
      /\b(?:resolveSidekickModel|SIDEKICK_TIER|SidekickTier|sidekickEscalatedModel|coordinationEscalatedModel)\b/,
      /\bresolve-sidekick-model\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "dev-lease-shared",
    patterns: [/\b(?:DevLeasePort|DevAccess|DevLeaseOptions|readOnlyEnforced)\b/, /\bwithLease\b/],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "whole-repo-modes",
    patterns: [/\.qa\/analysis\.json/, /\bEXHAUSTIVE_EXTRA_DELIVERED\b/, /--mode[ =](?:complete|exhaustive)\b/, /diff\|complete\|exhaustive/],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "review-loop-switch",
    patterns: [/\breviewLoopIntegrity\b/, /\bintegrity\??\.reviewLoop\b/],
    exemptPrefixes: [RECORDS_PREFIX, "src/orchestrator/config-loader.test.ts"],
  },
  {
    id: "intent-lock-enforce",
    patterns: [/\b(?:contractFeedback|ContractFeedback|contract-feedback|MAX_CONTRACT_RETRIES|renderContractViolations|ContractViolationShape)\b/, /\bintentLock\b[^\n]*\benforce\b/, /\bintent lock\b[^\n]*\b(?:refused|enforce)\b/i],
    exemptPrefixes: [RECORDS_PREFIX, "src/orchestrator/config-loader.test.ts", "src/orchestrator/config-loader.ts"],
  },
  {
    id: "app-telemetry-route",
    patterns: [/\b(?:AppTelemetryView|AppTelemetryViewSchema|getAppTelemetry|computeTelemetryAnalysis|TelemetryAnalysis|TelemetryRoleStat|TelemetryEfficiency)\b/, /\/apps\/(?::name|\{name\}|[\w-]+)\/telemetry\b/],
    exemptPrefixes: [RECORDS_PREFIX, "src/server/api.test.ts", "src/contract/openapi.test.ts"],
  },
  {
    id: "escalation-signal",
    patterns: [/\b[eE]scalationRate\b/],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "audit-dev-not-rendered",
    patterns: [/\brecurring-dev-not-rendered\b/, /\bDEV_NOT_RENDERED_CLASS\b/],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  {
    id: "langfuse-sink",
    patterns: [
      /\b(?:LangfuseScoreSink|LangfuseConfig|resolveLangfuseConfig|scoreSinkHealthOf|ScoreSinkHealth|scoreConfigsOfCatalog|langfuseScoreId|getRunIdByTraceId)\b/,
      /\b(?:langfuse-score-sink|langfuse-labels|langfuse:labels|collector-langfuse|langfuse-proxy|docker-compose\.langfuse)\b/,
    ],
    exemptPrefixes: [RECORDS_PREFIX],
  },
  { id: "stored-outcome-copy", patterns: [/\b(?:toStoredRunOutcome|StructuredReflection)\b/], exemptPrefixes: [RECORDS_PREFIX] },
  { id: "shell-dead-run-types", patterns: [/\bAgentResult\b/], exemptPrefixes: [RECORDS_PREFIX] },
  { id: "shell-events-reexport", patterns: [/\bsrc\/contract\/events(?:\.ts)?(?![\w.-])/], exemptPrefixes: [RECORDS_PREFIX] },
  {
    id: "narration",
    patterns: [/migration-tier/i, /\bSlice \d/i, /\bcutover\b/i, /deleted twin/i, /frozen oracle/i, /the (old|earlier|former) (engine|pipeline|loader|path|build)/i, /\bcharacterization\b/i, /\bported (from|to)\b/i],
  },
];

const SKIPPED_PREFIXES = ["odd/"];
const SKIPPED_FILES = new Set([
  "docs/architecture-remediation.md",
  "package-lock.json",
  "client/go.sum",
  "scripts/check-previous-forms.ts",
  "scripts/check-previous-forms.test.ts",
  "scripts/previous-forms.allow.json",
]);
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|p12|db|sqlite|mp4|wasm)$/i;
const PATH_EXTENSIONS = "ts|mjs|cjs|md|json|ya?ml|go|sh";
const PATH_TOKEN = new RegExp(`(?<![\\w@./-])((?:[\\w-]+/)+[\\w.-]+\\.(?:${PATH_EXTENSIONS}))(?![\\w/-])`, "g");
const CITATION = new RegExp(`(?<![\\w/.-])([\\w.-]+\\.(?:${PATH_EXTENSIONS}|tsx|js)):(\\d+)(?:-(\\d+))?(?!\\d|:\\d)`, "g");
const TEST_FILE = /\.test\.(ts|mjs)$/;
/* Fixtures hold synthetic content (their paths and citations name files of an imagined app), .gitignore names ignored paths by design,
   the test runner's recorded file costs may name a test file deleted since they were recorded (the runner ignores such an entry), and
   the architecture records cite the code as it was when they were written, which later deletions remove. The banned terms still apply to all of them. */
const REFERENCE_CHECK_SKIPPED = (path: string): boolean =>
  path.includes("/__fixtures__/") || path === ".gitignore" || path === "scripts/test-timings.json" || path.startsWith(RECORDS_PREFIX);
const FIXTURE_ROOTS = ["web/src/app/"];

export function isScanned(path: string): boolean {
  if (SKIPPED_FILES.has(path) || BINARY_EXTENSIONS.test(path)) return false;
  return !SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isImportLine(line: string): boolean {
  return /^\s*(import\b|export\b.*\bfrom\b)|\brequire\(|\bimport\(/.test(line);
}

function lineCount(content: string): number {
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

/* The pure check: every input is passed in, so it runs on fixtures without git. */
export function checkPreviousForms(
  files: SourceFile[],
  allow: AllowEntry[],
  allPaths: string[] = files.map((f) => f.path),
  isIgnored: (path: string) => boolean = () => false,
): CheckResult {
  const tracked = new Set(allPaths);
  const topLevel = new Set(allPaths.filter((p) => p.includes("/")).map((p) => p.split("/")[0]!));
  const directories = new Set<string>();
  for (const p of allPaths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const byBasename = new Map<string, SourceFile[]>();
  for (const file of files) {
    const base = file.path.slice(file.path.lastIndexOf("/") + 1);
    byBasename.set(base, [...(byBasename.get(base) ?? []), file]);
  }
  const trackedBasenames = new Set(allPaths.map((p) => p.slice(p.lastIndexOf("/") + 1)));

  const hits: Violation[] = [];
  for (const file of files) {
    if (!isScanned(file.path)) continue;
    const lines = file.content.split("\n");
    lines.forEach((text, index) => {
      const line = index + 1;
      for (const rule of BANNED_RULES) {
        if (rule.exemptPrefixes?.some((prefix) => file.path.startsWith(prefix))) continue;
        if (rule.patterns.some((pattern) => pattern.test(text))) hits.push({ rule: rule.id, path: file.path, line, text: text.trim() });
      }
      const referencesChecked = !REFERENCE_CHECK_SKIPPED(file.path);
      if (referencesChecked && !TEST_FILE.test(file.path) && !isImportLine(text)) {
        for (const match of text.matchAll(PATH_TOKEN)) {
          const token = match[1]!;
          const segments = token.split("/");
          if (!topLevel.has(segments[0]!)) continue;
          if (segments[0] === "src" && !directories.has(segments.slice(0, 2).join("/"))) continue;
          if (FIXTURE_ROOTS.some((root) => token.startsWith(root)) || isIgnored(token)) continue;
          if (!tracked.has(token)) hits.push({ rule: "dead-path", path: file.path, line, text: `${token} — ${text.trim()}` });
        }
      }
      for (const match of referencesChecked ? text.matchAll(CITATION) : []) {
        const name = match[1]!;
        const last = Number(match[3] ?? match[2]);
        if (!trackedBasenames.has(name)) {
          hits.push({ rule: "dead-citation", path: file.path, line, text: `${name}:${match[2]} names no tracked file — ${text.trim()}` });
          continue;
        }
        const candidates = byBasename.get(name) ?? [];
        if (candidates.length === 1 && last > lineCount(candidates[0]!.content)) {
          hits.push({ rule: "dead-citation", path: file.path, line, text: `${name}:${match[2]}${match[3] ? `-${match[3]}` : ""} is past the end of the file — ${text.trim()}` });
        }
      }
    });
  }

  const used = new Set<AllowEntry>();
  const violations: Violation[] = [];
  let allowed = 0;
  for (const hit of hits) {
    const entry = allow.find((a) => a.rule === hit.rule && a.path === hit.path && hit.text.includes(a.contains));
    if (entry) {
      used.add(entry);
      allowed++;
    } else {
      violations.push(hit);
    }
  }
  return { violations, allowed, unusedAllow: allow.filter((a) => !used.has(a)) };
}

export function formatResult(result: CheckResult): string[] {
  const out = result.violations.map((v) => `${v.rule} ${v.path}:${v.line} ${v.text.slice(0, 200)}`);
  for (const a of result.unusedAllow) out.push(`unused-allow ${a.rule} ${a.path} "${a.contains}" matches nothing; remove the entry`);
  return out;
}

function isText(content: Buffer): boolean {
  return !content.subarray(0, 8000).includes(0);
}

export function loadTrackedFiles(root: string): { files: SourceFile[]; allPaths: string[] } {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  const files: SourceFile[] = [];
  for (const path of listed) {
    if (BINARY_EXTENSIONS.test(path)) continue;
    let raw: Buffer;
    try {
      raw = readFileSync(join(root, path));
    } catch {
      continue;
    }
    if (isText(raw)) files.push({ path, content: raw.toString("utf8") });
  }
  return { files, allPaths: listed };
}

/* The candidate paths git ignores (user data such as config/apps/<app>.yaml), as a predicate. */
function ignoredPaths(root: string, candidates: string[]): (path: string) => boolean {
  if (candidates.length === 0) return () => false;
  let out = "";
  try {
    out = execFileSync("git", ["check-ignore", "-z", "--stdin"], { cwd: root, input: candidates.join("\0"), encoding: "utf8" });
  } catch {
    /* exit status 1 means none of them is ignored */
  }
  const ignored = new Set(out.split("\0").filter(Boolean));
  return (path) => ignored.has(path);
}

export function main(root: string): number {
  const allow = JSON.parse(readFileSync(join(root, "scripts", "previous-forms.allow.json"), "utf8")) as AllowEntry[];
  const { files, allPaths } = loadTrackedFiles(root);
  const first = checkPreviousForms(files, allow, allPaths);
  const result = checkPreviousForms(files, allow, allPaths, ignoredPaths(root, first.violations.filter((v) => v.rule === "dead-path").map((v) => v.text.split(" — ")[0]!)));
  const lines = formatResult(result);
  if (lines.length > 0) {
    console.error(lines.join("\n"));
    console.error(`previous-forms:check — ${result.violations.length} violation(s), ${result.unusedAllow.length} unused allow-list entr${result.unusedAllow.length === 1 ? "y" : "ies"}`);
    return 1;
  }
  console.log(`previous-forms:check — clean (${result.allowed} allow-listed hit(s))`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(join(dirname(fileURLToPath(import.meta.url)), "..")));
}
