

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WriteConfinementService } from "../../qa-engine/src/contexts/workspace-and-publication/domain/write-confinement.service";

/*
 * Validation + safety layers gating the maintainer's autonomous self-merge — the
 * highest-consequence path in this system: an LLM-authored fix, hot-swapped into the running
 * service and merged to main with no human in the loop unless a gate below stops it.
 *
 * The layered gates: PROTECTED_PATHS (this module) forbids an autonomous fix from rewriting the
 * recovery net, the secret boundary, or its own gate integrity; assessChange/assessRate cap an
 * autonomous fix's size and deploy frequency so a bad fix can't loop the system into
 * self-modification; a required `ci` check on main is the outer guard before merge; and the
 * canary-before-promote hot-swap (in index.ts) proves the fix healthy in the running process
 * BEFORE it is merged, with the boot-guard rollback net as the last line of defense if a swap
 * still ships something broken. Together: a rollback is always possible, an over-large/unscoped
 * rewrite is never auto-deployed, and a fix that doesn't fix cannot loop forever.
 */
export const PROTECTED_PATHS: string[] = [
  /* 1. recovery net */
  "boot-guard.mjs",
  "src/server/self-update.ts",
  "src/server/merge-guard.ts",
  /*
   * These sequence the autonomous-deploy gates themselves (the SELF_MAINTAINER_AUTOMERGE
   * kill-switch, assessChange/assessRate, performSwap/rollback, the mandatory justification
   * fields) — an autonomous fix that rewrites the maintainer runtime could silently skip its
   * own gates without ever touching merge-guard.ts, boot-guard.mjs or self-update.ts.
   */
  "src/server/maintainer-runtime.ts",
  "src/server/maintainer.ts",
  "src/server/maintainer-summary.ts",
  "src/server/maintainer-memory.ts",

  "src/orchestrator/sanitizer.ts",

  "qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts",
  /*
   * Builds the child env used to prepare an authenticated Playwright session (storageState form
   * login / PKCS#12 mTLS) — it handles credential material the same way scrub-env.ts does, so it
   * gets the same protection.
   */
  "qa-engine/src/shared-infrastructure/process-sandbox/auth-session-env.ts",
  /*
   * The adapter that actually WRITES auth material (storageState/client.p12/cert.pass) into the
   * orchestrator-only authDir — same risk class as scrub-env.ts / auth-session-env.ts above; an
   * unreviewed edit could silently redirect writes back into the agent-visible mirror.
   */
  "qa-engine/src/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts",
  /*
   * The port contract auth-session.adapter.ts implements — an autonomous narrowing
   * (e.g. dropping a request field a caller relies on) silently disables the guard the type exists
   * to require, without touching the adapter file itself.
   */
  "qa-engine/src/contexts/qa-run-orchestration/application/ports/auth-session.port.ts",
  /*
   * The login seed copied into every watched repo: it receives the app credentials in its env and
   * decides where the session is saved — an edit could log them or write the session back under
   * the agent-visible mirror.
   */
  "config/e2e/auth.setup.ts",

  "qa-engine/src/contexts/workspace-and-publication/domain/write-confinement.service.ts",
  /*
   * The write-confinement EFFECTFUL adapter — actually runs the git restore/clean revert this
   * domain service decides on. Equally load-bearing; the domain service alone deciding correctly
   * is meaningless if this adapter's git calls are weakened.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/write-confinement.adapter.ts",

  "qa-engine/src/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts",
  /*
   * The VcsWritePort/GitHubPrPort/GitHubIssuePort/ShadowPublicationPort interface definitions — an
   * autonomous narrowing (e.g. dropping commit()'s denyModifiedTracked param or its
   * revertedDenylisted return) silently disables the guards those types exist to require, without
   * touching the adapter files themselves.
   */
  "qa-engine/src/contexts/workspace-and-publication/application/ports/index.ts",

  /*
   * Composes the reviewer-facing Issue/PR body from the run's own artifacts. Deliberately NOT a
   * log dump — an earlier incident let an unsanitized raw execution log reach a public Issue
   * through this render path, bypassing the "concise, high-level account" it exists to produce.
   * An autonomous edit that starts appending unbounded/raw text here could reopen that leak even
   * though the whole-body sanitizer downstream still runs (it redacts known secret SHAPES, not
   * "is this actually a log dump").
   */
  "qa-engine/src/contexts/workspace-and-publication/domain/render-publication.ts",
  /*
   * Builds the Authorization header from GITHUB_TOKEN — the token-handling boundary for every
   * GitHub API call this context makes.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/github-http.ts",
  /*
   * Clone/fetch auth-header injection (authHeaderArgs) + the tokenless-URL policy that keeps a
   * credential from being persisted in origin's URL — a credential-leak vector if weakened.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/mirror-provision.adapter.ts",
  /*
   * Decides the scrubEnv() invocation (extraAllowed pattern) for the e2e install's npm lifecycle
   * scripts — an autonomous widening here leaks the orchestrator's own secrets to the WATCHED
   * repo's own (potentially attacker-influenced) install scripts.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/setup.adapter.ts",
  /*
   * The spawn primitives for the untrusted-code-execution sandbox (sandbox.ts, already protected,
   * delegates the actual spawn to these) — they receive an already-scrubbed env and run untrusted
   * agent-authored binaries; weakening the spawn/kill contract here is the same class of risk as
   * scrub-env.ts itself.
   */
  "qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts",

  /*
   * The ONE killTree an autonomous fix could neuter quietly (e.g. drop the process-group
   * signal, or swallow the kill and silently no-op) — the change would still compile and pass a
   * shallow test while a hung/runaway untrusted child (Playwright, codex exec, npm/mvn/gradle)
   * is never actually torn down, a resource-exhaustion / hang risk the sandbox exists to prevent.
   */
  "qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts",
  /*
   * The composition root — wires RedactionPortAdapter, WriteConfinementAdapter, VcsWriteAdapter,
   * CODE_PUBLISH_EXCLUDES, and every GitHub adapter. An autonomous edit here can rewire ANY security
   * port to a weaker (or fake) implementation without ever touching the port/adapter files
   * themselves — the single widest-blast-radius file in the whole security surface.
   */
  "src/server/rewritten-engine-factory.ts",

  "qa-engine/src/shared-kernel/ports/redaction.port.ts",
  /*
   * Model-prompt sanitizer twin (diff/commit-body/reviewer-text → model). Must stay in lockstep
   * with src/orchestrator/sanitizer.ts so prompt assembly never imports src/.
   */
  // Stryker disable next-line StringLiteral: equivalent while the generation/infrastructure/ prefix entry stands; listed so narrowing that prefix cannot unprotect it
  "qa-engine/src/contexts/generation/infrastructure/sanitize-text.ts",

  // Stryker disable next-line StringLiteral: equivalent while the bridges/ prefix entry stands; listed so narrowing that prefix cannot unprotect it
  "qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/publication-port.adapter.ts",

  "src/server/auth.ts",
  "src/server/github-auth.ts",
  "src/server/webhook.ts",
  /*
   * The REST control-plane router — decides whether /api/auth/login and /api/auth/local ever
   * reach auth.ts/github-auth.ts at all. Those handlers being protected is meaningless if an
   * autonomous fix can silently stop routing to them (or route around them) here instead.
   */
  "src/server/api.ts",

  "qa-engine/src/contexts/generation/infrastructure/",

  "qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/",

  /*
   * The ShadowPublicationPort implementation — log-only, no-ops every PR/Issue/commit/push side
   * effect when qa.shadow: true. This IS the shadow-mode safety boundary that lets a newly
   * onboarded app run the full pipeline without touching its real repo; an autonomous edit that
   * makes any of its methods actually perform the side effect defeats that boundary silently.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/shadow-log.adapter.ts",

  "src/integrations/repo-mirror.ts",
  /*
   * codexExecEnv's env allowlist for untrusted `codex exec` spawns — the same risk class as
   * scrub-env.ts above (an unreviewed widening leaks the orchestrator's own secrets to untrusted
   * agent-authored code).
   */
  "src/agent-runtime/codex-strategy.ts",
  /*
   * reviewerPrimaryCollisionErrors is the SOLE guard that reviewer/primary use different models in
   * dual mode — deleting or weakening it silently collapses independent-judgment review into a
   * rubber stamp with no detectable failure.
   */
  "src/agent-runtime/config.ts",
  /*
   * The OpenCode agents' models and tool permissions — including the read-only boundary on watched
   * repos. Widening a role's permissions here grants the LLM write authority without touching code.
   */
  "agents/opencode.json",

  "*.test.ts",
  "tsconfig.json",
  "src/index.ts",

  "qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/code-setup.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/sandbox.ts",

  "qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts",
  /* 4. build/topology the canary cannot verify (image rebuild only) */
  ".github/",
  "Dockerfile",
  "agents/Dockerfile",
  /* Decides what the image build context contains — dropping an entry can bake .env into the image. */
  ".dockerignore",
  "docker-compose.yml",
  "docker-compose.override.yml",
  "package.json",
  "package-lock.json",
];

/*
 * One repo-relative spelling for every path the gates compare: Windows separators become "/",
 * repeated slashes collapse, then leading "./" groups are stripped — in that order, so ".\\src\\x"
 * and ".//src/x" both become "src/x". Only whole "./" groups go: the dot of a dotfile path
 * (".github/", ".dockerignore") is kept.
 */
function normalizeRepoPath(file: string): string {
  const slashed = file.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  // Stryker disable next-line Regex: equivalent for real paths — git never reports a "./" group past the start of a path
  return slashed.replace(/^(?:\.\/)+/, "");
}

export function isProtectedPath(file: string): boolean {
  const f = normalizeRepoPath(file);
  return PROTECTED_PATHS.some((p) => {
    if (p.startsWith("*")) return f.endsWith(p.slice(1)); 
    // Stryker disable next-line ConditionalExpression,StringLiteral: stricter only — a prefix match on an exact entry can only protect more paths
    if (p.endsWith("/")) return f.startsWith(p);  /* directory prefix */
    return f === p;  /* exact repo-relative path */
  });
}

export const SECURITY_SENSITIVE_SURFACE_ROOTS: string[] = [
  "qa-engine/src/contexts/workspace-and-publication/",
  "qa-engine/src/shared-infrastructure/process-sandbox/",
  "qa-engine/src/contexts/generation/infrastructure/",
  "qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/",
];

/*
 * Explicit, reviewed allowlist: files under the surface roots above that are NOT security-sensitive.
 * Adding an entry here is a REVIEWED decision (same bar as adding one to PROTECTED_PATHS) — never a
 * default. Each entry states WHY it is safe to leave autonomously editable.
 */
export const NOT_SECURITY_SENSITIVE: string[] = [
  /*
   * Pure decision logic (verdict/reviewerApproved/coverageBlocks/shadow/e2eChanged -> pr|issue|
   * shadow|quarantine|noop) — no I/O, no secret handling, no git write; a regression here is caught
   * by its own heavily-covered *.test.ts (already protected by the gate-integrity group above).
   */
  "qa-engine/src/contexts/workspace-and-publication/domain/publish-decision.service.ts",
  /*
   * Thin GitHub API caller — consumes the injected github-http.ts client (which IS protected, it
   * owns the auth-header injection) and carries no credential of its own.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/github-issue.adapter.ts",

  "qa-engine/src/contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts",
  /* `git gc --auto` only — no credential, no write-confinement/publish interaction. */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/mirror-gc.adapter.ts",
];

export function isSecuritySensitiveSurface(file: string): boolean {
  const f = normalizeRepoPath(file);
  return SECURITY_SENSITIVE_SURFACE_ROOTS.some((root) => f.startsWith(root));
}

export interface ChangeStat {
  files: string[];
  additions: number;
  deletions: number;
  unparsed?: string[];  /* diff-summary rows that could not be read; any one blocks the change */
}

export interface ChangeLimits {
  maxFiles: number;
  maxLines: number;  /* additions + deletions */
}

export const DEFAULT_CHANGE_LIMITS: ChangeLimits = { maxFiles: 15, maxLines: 400 };

export interface GateResult {
  ok: boolean;
  reasons: string[];  /* human-readable reasons it was blocked (empty when ok) */
}

export function assessChange(stat: ChangeStat, limits: ChangeLimits = DEFAULT_CHANGE_LIMITS): GateResult {
  const reasons: string[] = [];
  if (stat.files.length === 0) reasons.push("the fix changed no files");
  const unparsed = stat.unparsed ?? [];
  if (unparsed.length > 0) {
    // Stryker disable next-line StringLiteral: message detail only — the separator between the named rows
    reasons.push(`the diff summary holds rows the guard cannot read (human review required): ${unparsed.join(" | ")}`);
  }
  const protectedTouched = stat.files.filter(isProtectedPath);
  if (protectedTouched.length > 0) {
    // Stryker disable next-line StringLiteral: message detail only — the separator between the named files
    reasons.push(`touches protected recovery/build files (human review required): ${protectedTouched.join(", ")}`);
  }
  if (stat.files.length > limits.maxFiles) {
    reasons.push(`changes ${stat.files.length} files, over the ${limits.maxFiles}-file limit for an autonomous fix`);
  }
  const lines = stat.additions + stat.deletions;
  if (lines > limits.maxLines) {
    reasons.push(`changes ${lines} lines, over the ${limits.maxLines}-line limit for an autonomous fix`);
  }
  return { ok: reasons.length === 0, reasons };
}

const RENAME_ARROW = " => ";

/* git's C-style path decoding (octal byte escapes to UTF-8, \" \\ \t \n …) has one owner: write
   confinement decodes the same quoting out of `git status`. */
const gitPaths = new WriteConfinementService();

/* Length of the C-quoted path `text` opens with, through its closing quote; -1 when it never closes. */
function quotedLength(text: string): number {
  // Stryker disable next-line EqualityOperator: equivalent — text[text.length] is undefined, so the extra pass only ends the loop
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

/* The path one side of a numstat path field names. git quotes every path holding `"`, `\` or a
   control character, so a side holding any must be exactly one quoted path with only escapes git
   prints — else null. */
function decodeSide(side: string): string | null {
  if (!/["\\\u0000-\u001f\u007f]/.test(side)) return side;
  if (!side.startsWith('"') || quotedLength(side) !== side.length) return null;
  try {
    return gitPaths.decodeGitPath(side);
  } catch {
    return null;
  }
}

/* A path field split into [path] or, for a rename, [old, new]; null when no single split exists.
   A quoted old side ends at its closing quote, a bare one at the first arrow — a second arrow
   leaves a bare split ambiguous. */
function renameSides(field: string): string[] | null {
  if (!field.startsWith('"')) {
    const sides = field.split(RENAME_ARROW);
    return sides.length <= 2 ? sides : null;
  }
  const end = quotedLength(field);
  if (end === field.length) return [field];
  /* An unclosed quote (-1) fails this check too: the field opens with a quote, not the arrow. */
  return field.startsWith(RENAME_ARROW, end) ? [field.slice(0, end), field.slice(end + RENAME_ARROW.length)] : null;
}

/*
 * git compacts a rename of two bare paths around their shared directory prefix and suffix as
 * `pfx{old => new}sfx`. Returns the two paths that reading names; [] when the field cannot be that
 * shape (no "{" before the arrow or no "}" after it); null when extra braces allow more than one
 * reading.
 */
function braceReading(oldSide: string, newSide: string): string[] | null {
  const [pfx, oldMid, ...moreOpen] = oldSide.split("{");
  const [newMid, sfx, ...moreClose] = newSide.split("}");
  if (oldMid === undefined || sfx === undefined) return [];
  if (moreOpen.length + moreClose.length > 0) return null;
  return [normalizeRepoPath(`${pfx}${oldMid}${sfx}`), normalizeRepoPath(`${pfx}${newMid}${sfx}`)];
}

/*
 * The repo paths a numstat path field names, or null when it fits no shape git prints. git C-quotes
 * a path holding `"`, `\`, a control character or (core.quotePath, the default) a non-ASCII byte,
 * and prints a rename as `old => new`: each whole path quoted on its own when either needs quoting,
 * otherwise brace-compacted. A brace-compacted field is also a valid plain rename of two brace-named
 * files, so both readings are returned — each side is checked whichever one git meant.
 */
function numstatPaths(field: string): string[] | null {
  const sides = renameSides(field);
  if (sides === null) return null;
  const paths = sides.map(decodeSide);
  if (!paths.every((p): p is string => p !== null)) return null;
  const [oldSide, newSide] = sides;
  /* a quoted side means git printed whole paths, never a brace-compacted pair */
  if (newSide === undefined || field.includes('"')) return paths;
  const braces = braceReading(oldSide as string, newSide);
  return braces === null ? null : [...paths, ...braces];
}

const NUMSTAT_ROW = /^(\d+|-)\t(\d+|-)\t(.+)$/;

/*
 * Parse `git diff --numstat` output into a ChangeStat. Binary files report "-" for the counts;
 * treat those as 0 lines (the file still counts toward the file limit). A row the parser cannot
 * read is kept in `unparsed`, never dropped: an unreadable row may name a protected path.
 */
export function parseNumstat(out: string): ChangeStat {
  const files: string[] = [];
  const unparsed: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const row = NUMSTAT_ROW.exec(line);
    const paths = row && numstatPaths(row[3] as string);
    if (!row || !paths) {
      unparsed.push(line);
      continue;
    }
    files.push(...paths);
    additions += row[1] === "-" ? 0 : Number(row[1]);
    deletions += row[2] === "-" ? 0 : Number(row[2]);
  }
  return { files, additions, deletions, unparsed };
}

export interface RateLimits {
  maxInWindow: number;  /* max autonomous deploys per window */
  windowMs: number;
  cooldownMs: number;  /* minimum gap between two deploys */
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  maxInWindow: 3,
  windowMs: 60 * 60 * 1000,
  cooldownMs: 5 * 60 * 1000,
};

/* Loop / rate guard: caps autonomous deploys in a sliding window and enforces a cooldown. */
export function assessRate(history: number[], now: number, limits: RateLimits = DEFAULT_RATE_LIMITS): GateResult {
  const reasons: string[] = [];
  const recent = history.filter((t) => now - t >= 0 && now - t < limits.windowMs);
  if (recent.length >= limits.maxInWindow) {
    // Stryker disable next-line ArithmeticOperator: message detail only — the window length shown in minutes
    reasons.push(`${recent.length} autonomous deploy(s) in the last ${Math.round(limits.windowMs / 60000)}min (limit ${limits.maxInWindow}) — possible self-modification loop`);
  }
  const last = history.length ? Math.max(...history) : Number.NEGATIVE_INFINITY;
  if (now - last < limits.cooldownMs) {
    // Stryker disable next-line ArithmeticOperator: message detail only — the seconds shown
    reasons.push(`last autonomous deploy was ${Math.round((now - last) / 1000)}s ago (cooldown ${Math.round(limits.cooldownMs / 1000)}s)`);
  }
  return { ok: reasons.length === 0, reasons };
}

/*
 * Persisted deploy ledger (data/maintainer-deploys.json). It MUST survive restarts, because
 * a hot-swap restarts the process — without persistence the rate guard would reset every time
 * it deploys, defeating the loop protection. fs is injectable so the logic is unit-tested.
 */
export interface LedgerFs {
  read(p: string): string | null;
  write(p: string, s: string): void;
}

export const realLedgerFs: LedgerFs = {
  read: (p) => {
    try {
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    } catch {
      return null;
    }
  },
  write: (p, s) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, s);
  },
};

export function readDeployHistory(path: string, fs: LedgerFs = realLedgerFs): number[] {
  const raw = fs.read(path);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export function recordDeploy(path: string, now: number, fs: LedgerFs = realLedgerFs, keep = 50): void {
  const hist = readDeployHistory(path, fs);
  hist.push(now);
  fs.write(path, JSON.stringify(hist.slice(-keep)));
}
