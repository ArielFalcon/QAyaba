/* Advisory Conventional Commits classifier, cross-checked against the diff. The type→action table is the default; if the message under-promises (refactor/style/chore…) yet the diff adds logic, it escalates to generate. Scope comes from changed files, not header parentheses. Constant-value diffs (e.g. timeout: 5000 → 10000) are NOT auto-escalated — a value-diff heuristic on arbitrary source is high-noise. */
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";

/* Per-call DiffParserService (stateless) so domain import does not construct a kernel instance at module load. The genuinely* walkers stay private: relocation subtraction is classify-specific, not generic diff parsing. */
function changedFilesFromDiff(diff: string): string[] {
  return new DiffParserService().changedFiles(diff);
}

export type CommitType =
  | "feat" | "fix" | "perf" | "refactor" | "chore"
  | "style" | "docs" | "ci" | "build" | "test" | "revert" | "unknown";

export type CommitAction = "generate" | "regression" | "skip";

export interface CommitIntent {
  type: CommitType;
  breaking: boolean;
  /** First line — what the agent uses as intent. */
  message: string;
  /** Lines after the subject — the richest statement of intent. */
  body?: string;
  /** The agent derives the scope/area from these, not from header parentheses. */
  changedFiles: string[];
}

export interface CommitClassification extends CommitIntent {
  /** Diff signal: does it add net logic? */
  hasLogicChange: boolean;
  /** The message claims "no tests" but the diff adds logic. */
  contradiction: boolean;
  action: CommitAction;
  reason: string;
}

/* feat/fix → tests; perf/refactor → regression (behavior unchanged); the rest carry no tests. */
const DEFAULT_ACTION: Record<CommitType, CommitAction> = {
  feat: "generate",
  fix: "generate",
  perf: "regression",
  refactor: "regression",
  chore: "skip",
  style: "skip",
  docs: "skip",
  ci: "skip",
  build: "skip",
  test: "skip",
  revert: "skip",
  unknown: "generate", /* no recognizable convention: when in doubt, test */
};

export function classifyCommit(message: string, diff: string): CommitClassification {
  const { type, breaking } = parseHeader(message);
  const firstLine = (message.split("\n")[0] ?? "").trim();
  /* The body is the richest human statement of intent; the subject alone is often too terse for a test objective. */
  const body = message.split("\n").slice(1).join("\n").trim();
  const changedFiles = changedFilesFromDiff(diff);
  /* Behavior can change in code OR in config-as-code the source-extension logic check is blind to (e.g. Spring application.yml under a chore message). */
  const hasLogicChange = genuinelyAddedLogic(diff) > 0;
  const hasBehaviorConfigChange = genuinelyAddedConfig(diff) > 0;

  let action: CommitAction = breaking ? "generate" : DEFAULT_ACTION[type];
  let contradiction = false;
  let reason = `type=${type}`;

  if (breaking) {
    reason = "breaking change → generate";
  } else if ((action === "skip" || action === "regression") && (hasLogicChange || hasBehaviorConfigChange)) {
    /* The message promises no new behavior, but the diff adds it (code logic or behavior config). */
    contradiction = true;
    action = "generate";
    const what = hasLogicChange ? "logic" : "behavior config";
    reason = `message '${type}' expected no tests, but the diff adds ${what} → escalated to generate`;
  } else if (action === "skip") {
    /* Removals and DB migrations invalidate existing expectations more than they create a new surface — escalate to regression (re-run the suite), never generate. */
    const removedLogic = genuinelyRemovedLogic(diff);
    const migrationChange = genuinelyAddedMigration(diff);
    if (removedLogic > 0) {
      contradiction = true;
      action = "regression";
      reason = `message '${type}' expected no tests, but the diff REMOVES logic (${removedLogic} line(s)) → escalated to regression (stale specs may surface)`;
    } else if (migrationChange > 0) {
      contradiction = true;
      action = "regression";
      reason = `message '${type}' expected no tests, but the diff adds a DB migration → escalated to regression`;
    }
  }
  /* Constant-value diffs are NOT auto-escalated. A value-diff heuristic on arbitrary source is high-noise (nearly every line touches some literal); the false-generate cost at fleet scale is real. */

  return { type, breaking, message: firstLine, body: body || undefined, changedFiles, hasLogicChange, contradiction, action, reason };
}

/* skip < regression < generate — the action reflects the worst (most test-worthy) change anywhere in the range. */
const ACTION_SEVERITY: Record<CommitAction, number> = { skip: 0, regression: 1, generate: 2 };

/**
 * Classifies a push/PR range as one decision. `headMessage` is the tip commit (always explicit — never inferred from array position). `otherMessages` are the rest (order-independent; only MAX-severity action is taken). Empty `otherMessages` matches classifyCommit. Each message is classified against the same union diff; `intent` is always the head's.
 */
export function classifyRange(headMessage: string, otherMessages: readonly string[], diff: string): CommitClassification {
  const headClassification = classifyCommit(headMessage, diff);
  const otherClassifications = otherMessages.map((m) => classifyCommit(m, diff));
  const all = [headClassification, ...otherClassifications];
  const winner = all.reduce((worst, cur) =>
    ACTION_SEVERITY[cur.action] > ACTION_SEVERITY[worst.action] ? cur : worst,
  );
  return {
    ...headClassification,
    action: winner.action,
    reason: otherMessages.length > 0 ? `range of ${all.length} commit(s): ${winner.reason}` : winner.reason,
    contradiction: winner.contradiction,
    hasLogicChange: all.some((c) => c.hasLogicChange),
  };
}


const TYPES = new Set<string>([
  "feat", "fix", "perf", "refactor", "chore", "style", "docs", "ci", "build", "test", "revert",
]);

function parseHeader(message: string): { type: CommitType; breaking: boolean } {
  const first = (message.split("\n")[0] ?? "").trim();
  if (/^Revert "/i.test(first)) return { type: "revert", breaking: false };
  const m = first.match(/^(\w+)(?:\([^)]*\))?(!)?:/);
  const raw = m?.[1]?.toLowerCase();
  const type = (raw && TYPES.has(raw) ? raw : "unknown") as CommitType;
  const breaking = Boolean(m?.[2]) || /(^|\n)BREAKING[ -]CHANGE:/.test(message);
  return { type, breaking };
}

/* For an E2E engine a template change is a behavior change (it is what the browser renders). */
const SOURCE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "java", "kt", "py", "go", "rb", "cs",
  "php", "rs", "swift", "scala", "c", "cc", "cpp", "h", "hpp", "vue", "svelte",
  "html", "astro",
]);

function isSourceFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SOURCE_EXT.has(ext);
}

/* Genuinely-added logic = added logic lines minus identical removed counterparts (a relocation, not new behavior). Added-minus-relocations (not repo-wide net) so a new branch in one file is not cancelled by an unrelated removal in another. */
function genuinelyAddedLogic(diff: string): number {
  let currentSource = false;
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentSource = isSourceFile(line.replace(/^\+\+\+ (?:b\/)?/, ""));
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git")) {
      if (line.startsWith("diff --git")) currentSource = false;
      continue;
    }
    if (!currentSource) continue;
    if (line.startsWith("+")) {
      if (looksLikeLogic(line.slice(1))) added.push(line.slice(1).trim());
    } else if (line.startsWith("-")) {
      if (looksLikeLogic(line.slice(1))) removed.push(line.slice(1).trim());
    }
  }
  /* Each removal can cancel at most one addition. */
  const removedCounts = new Map<string, number>();
  for (const r of removed) removedCounts.set(r, (removedCounts.get(r) ?? 0) + 1);
  let net = 0;
  for (const a of added) {
    const c = removedCounts.get(a) ?? 0;
    if (c > 0) removedCounts.set(a, c - 1);
    else net++;
  }
  return net;
}

/* Symmetric twin of genuinelyAddedLogic: removed lines minus identical added counterparts. A removal-only diff never registers in genuinelyAddedLogic, so a skip-typed deletion would otherwise leave stale suite coverage unverified. Standalone walk so the two stay independently testable. */
function genuinelyRemovedLogic(diff: string): number {
  let currentSource = false;
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentSource = isSourceFile(line.replace(/^\+\+\+ (?:b\/)?/, ""));
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git")) {
      if (line.startsWith("diff --git")) currentSource = false;
      continue;
    }
    if (!currentSource) continue;
    if (line.startsWith("+")) {
      if (looksLikeLogic(line.slice(1))) added.push(line.slice(1).trim());
    } else if (line.startsWith("-")) {
      if (looksLikeLogic(line.slice(1))) removed.push(line.slice(1).trim());
    }
  }
  /* Each addition can cancel at most one removal. */
  const addedCounts = new Map<string, number>();
  for (const a of added) addedCounts.set(a, (addedCounts.get(a) ?? 0) + 1);
  let net = 0;
  for (const r of removed) {
    const c = addedCounts.get(r) ?? 0;
    if (c > 0) addedCounts.set(r, c - 1);
    else net++;
  }
  return net;
}

/* SQL migrations — narrow, same "behavior-config, not everything" discipline: a `.sql` file under a conventional migration directory (Flyway/Liquibase `db/migration`, `migrations`, `db/changelog`) or whose name carries a version/sequence prefix. A schema change invalidates existing expectations, so it escalates to regression, never generate. */
const MIGRATION_PATH = /(^|\/)(db[\\/]migration|migrations|db[\\/]changelog)[\\/][^/]+\.sql$/i;
const MIGRATION_FILENAME = /(^|\/)(v\d+(\.\d+)*__|r__|\d{3,}[_-]).*\.sql$/i;

function isMigrationFile(path: string): boolean {
  return MIGRATION_PATH.test(path) || MIGRATION_FILENAME.test(path);
}

/* Net-added lines in a migration file (SQL has none of the LOGIC-regex keywords). Any added line is schema-affecting; relocations are subtracted by content. */
function genuinelyAddedMigration(diff: string): number {
  let inMigration = false;
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      inMigration = isMigrationFile(line.replace(/^\+\+\+ (?:b\/)?/, ""));
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git")) {
      if (line.startsWith("diff --git")) inMigration = false;
      continue;
    }
    if (!inMigration) continue;
    if (line.startsWith("+")) {
      const c = line.slice(1).trim();
      if (c && !/^--/.test(c)) added.push(c);
    } else if (line.startsWith("-")) {
      const c = line.slice(1).trim();
      if (c && !/^--/.test(c)) removed.push(c);
    }
  }
  const removedCounts = new Map<string, number>();
  for (const r of removed) removedCounts.set(r, (removedCounts.get(r) ?? 0) + 1);
  let net = 0;
  for (const a of added) {
    const c = removedCounts.get(a) ?? 0;
    if (c > 0) removedCounts.set(a, c - 1);
    else net++;
  }
  return net;
}

/* Behavior-config files whose changes alter runtime behavior (Spring app/profile config, Spring Cloud bootstrap). Narrow: dependency manifests and CI yaml are excluded so routine bumps do not force-escalate. */
const BEHAVIOR_CONFIG = /(^|\/)(application|bootstrap)(-[\w]+)?\.(ya?ml|properties)$/i;

function isBehaviorConfigFile(path: string): boolean {
  return BEHAVIOR_CONFIG.test(path);
}

/* Net-added meaningful (non-blank, non-comment) lines in behavior-config files. Config carries no code keywords, so any added setting is a potential behavior change; relocations are subtracted by content. */
function genuinelyAddedConfig(diff: string): number {
  let inConfig = false;
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      inConfig = isBehaviorConfigFile(line.replace(/^\+\+\+ (?:b\/)?/, ""));
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git")) {
      if (line.startsWith("diff --git")) inConfig = false;
      continue;
    }
    if (!inConfig) continue;
    if (line.startsWith("+")) {
      const c = line.slice(1).trim();
      if (c && !/^#/.test(c)) added.push(c);
    } else if (line.startsWith("-")) {
      const c = line.slice(1).trim();
      if (c && !/^#/.test(c)) removed.push(c);
    }
  }
  const removedCounts = new Map<string, number>();
  for (const r of removed) removedCounts.set(r, (removedCounts.get(r) ?? 0) + 1);
  let net = 0;
  for (const a of added) {
    const c = removedCounts.get(a) ?? 0;
    if (c > 0) removedCounts.set(a, c - 1);
    else net++;
  }
  return net;
}

const LOGIC = /\b(if|else|for|while|switch|case|return|function|class|interface|enum|def|func|await|async|throw|try|catch|yield)\b|=>|\b\w+\s*\(/;

function looksLikeLogic(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  if (/^(\/\/|\*|\/\*|\*\/|#|<!--|-->)/.test(t)) return false; /* comment line */
  /* Strip string/template-literal contents first, so code-like words inside a string are not mistaken for logic. */
  return LOGIC.test(stripStrings(t));
}

function stripStrings(s: string): string {
  /* Replaces "..." / '...' / `...` contents (handles escapes). */
  return s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}
