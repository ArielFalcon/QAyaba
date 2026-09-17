

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const PROTECTED_PATHS: string[] = [
  /* 1. recovery net */
  "boot-guard.mjs",
  "src/server/self-update.ts",
  "src/server/merge-guard.ts",
  
  "src/orchestrator/sanitizer.ts",
  
  "qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts",
  
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
  "qa-engine/src/contexts/generation/infrastructure/sanitize-text.ts",
  
  "qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/publication-port.adapter.ts",
  
  "src/server/auth.ts",
  "src/server/github-auth.ts",
  "src/server/webhook.ts",
  
  "qa-engine/src/contexts/generation/infrastructure/",
  
  "qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/",
  
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
  "docker-compose.yml",
  "docker-compose.override.yml",
  "package.json",
  "package-lock.json",
];

export function isProtectedPath(file: string): boolean {
  const f = file.replace(/^\.\/*/, "").replace(/\\/g, "/");
  return PROTECTED_PATHS.some((p) => {
    if (p.startsWith("*")) return f.endsWith(p.slice(1)); 
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
  const f = file.replace(/^\.\/*/, "").replace(/\\/g, "/");
  return SECURITY_SENSITIVE_SURFACE_ROOTS.some((root) => f.startsWith(root));
}

export interface ChangeStat {
  files: string[];
  additions: number;
  deletions: number;
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
  const protectedTouched = stat.files.filter(isProtectedPath);
  if (protectedTouched.length > 0) {
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

/*
 * Parse `git diff --numstat` output into a ChangeStat. Binary files report "-" for the
 * counts; treat those as 0 lines (the file still counts toward the file limit).
 */
export function parseNumstat(out: string): ChangeStat {
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const [add, del, ...rest] = parts;
    files.push(rest.join("\t"));
    additions += add === "-" ? 0 : Number(add) || 0;
    deletions += del === "-" ? 0 : Number(del) || 0;
  }
  return { files, additions, deletions };
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
    reasons.push(`${recent.length} autonomous deploy(s) in the last ${Math.round(limits.windowMs / 60000)}min (limit ${limits.maxInWindow}) — possible self-modification loop`);
  }
  const last = history.length ? Math.max(...history) : Number.NEGATIVE_INFINITY;
  if (now - last < limits.cooldownMs) {
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
