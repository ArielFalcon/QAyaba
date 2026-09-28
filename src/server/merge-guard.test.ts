import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync, rmSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  isProtectedPath,
  isSecuritySensitiveSurface,
  assessChange,
  parseNumstat,
  assessRate,
  readDeployHistory,
  recordDeploy,
  LedgerFs,
  DEFAULT_CHANGE_LIMITS,
  DEFAULT_RATE_LIMITS,
  SECURITY_SENSITIVE_SURFACE_ROOTS,
  NOT_SECURITY_SENSITIVE,
  PROTECTED_PATHS,
} from "./merge-guard";

/* The completeness walk: every file under the security-sensitive surface roots of a tree rooted at
   `treeRoot` that is neither protected nor explicitly reviewed as not-sensitive. It runs against the
   real repository read-only, and against throwaway temp trees for the planted-file cases — tests never
   write into the tracked tree (node --test runs files in parallel; a planted file is visible to every
   concurrent tree-scanning test).
 */
const repoRoot = join(import.meta.dirname, "..", "..");
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".claude", ".stryker-tmp"]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(full);
  }
}

function unclassifiedUnder(treeRoot: string, surfaceRoots: string[]): string[] {
  const files: string[] = [];
  for (const surfaceRoot of surfaceRoots) {
    const abs = join(treeRoot, surfaceRoot);
    if (existsSync(abs)) walk(abs, files);
  }
  const bad: string[] = [];
  for (const full of files) {
    const rel = relative(treeRoot, full).replace(/\\/g, "/");
    if (!isProtectedPath(rel) && !NOT_SECURITY_SENSITIVE.includes(rel)) bad.push(rel);
  }
  return bad;
}

/* A throwaway tree holding only the given repo-relative files — the planted-file cases run here. */
function tempTreeWith(relPaths: string[]): string {
  const treeRoot = mkdtempSync(join(tmpdir(), "merge-guard-tree-"));
  for (const rel of relPaths) {
    const full = join(treeRoot, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "export {};\n");
  }
  return treeRoot;
}

/* Ordinary, existing source files an autonomous fix may touch — the negative examples below. */
const ORDINARY_FILES = [
  "src/server/queue.ts",
  "src/server/metrics.ts",
  "qa-engine/src/contexts/objective-signal/domain/decide-coverage.service.ts",
];

test("the ordinary-file examples exist and are not protected", () => {
  for (const file of ORDINARY_FILES) {
    assert.ok(existsSync(join(repoRoot, file)), `${file} must exist — a negative example naming a deleted file proves nothing`);
    assert.equal(isProtectedPath(file), false, `${file} must stay autonomously editable`);
  }
});

test("isProtectedPath flags the recovery net and build/topology, exact and prefix", () => {
  assert.equal(isProtectedPath("boot-guard.mjs"), true);
  assert.equal(isProtectedPath("src/server/self-update.ts"), true);
  assert.equal(isProtectedPath("src/server/merge-guard.ts"), true);
  assert.equal(isProtectedPath("docker-compose.yml"), true);
  assert.equal(isProtectedPath("./Dockerfile"), true);
  assert.equal(isProtectedPath(".github/workflows/ci.yml"), true);
});

/* git reports forward-slash repo-relative paths, but the gate must not depend on it: a Windows
   separator or a redundant "./" / "//" spelling of a protected path is still that path. */
test("isProtectedPath protects a path however its separators and leading ./ are spelled", () => {
  for (const spelling of [".\\src\\index.ts", "src\\index.ts", ".//src/index.ts", "././src/index.ts", "src//index.ts"]) {
    assert.equal(isProtectedPath(spelling), true, `${JSON.stringify(spelling)} is src/index.ts`);
  }
  for (const spelling of [".\\.github\\workflows\\ci.yml", "./.github/workflows/ci.yml", ".github\\workflows\\ci.yml"]) {
    assert.equal(isProtectedPath(spelling), true, `${JSON.stringify(spelling)} is under .github/`);
  }
  for (const file of ORDINARY_FILES) {
    assert.equal(isProtectedPath(`.\\${file.replace(/\//g, "\\")}`), false, `${file} stays editable in any spelling`);
  }
});

test("isSecuritySensitiveSurface recognizes the surface however the path is spelled", () => {
  const file = "qa-engine/src/contexts/workspace-and-publication/domain/new-module.ts";
  for (const spelling of [file, `./${file}`, `.//${file}`, `.\\${file.replace(/\//g, "\\")}`]) {
    assert.equal(isSecuritySensitiveSurface(spelling), true, `${JSON.stringify(spelling)} is on the surface`);
  }
  assert.equal(isSecuritySensitiveSurface("./src/server/queue.ts"), false);
});

/* The login seed decides how credentials reach the setup run and where the session is saved;
   .dockerignore decides what (e.g. .env) is baked into the image; agents/opencode.json sets the
   agents' models and tool permissions — including the read-only boundary on watched repos. */
test("isProtectedPath protects the login seed, the image build context filter and the agent permissions", () => {
  assert.equal(isProtectedPath("config/e2e/auth.setup.ts"), true);
  assert.equal(isProtectedPath(".dockerignore"), true);
  assert.equal(isProtectedPath("./.dockerignore"), true);
  assert.equal(isProtectedPath("agents/opencode.json"), true);
  assert.equal(isProtectedPath("agents\\opencode.json"), true);
});

test("isProtectedPath flags the secret boundary (a fix must never weaken what scrubs data leaving the system)", () => {
  assert.equal(isProtectedPath("src/orchestrator/sanitizer.ts"), true);
  /* the untrusted-spawn secret allowlist (BLOCKED_ENV_PREFIX/ALLOWED_ENV_EXACT/ALLOWED_ENV_PREFIX) —
     every scrubEnv consumer converged on this file; widening it unreviewed would leak secrets to
     agent-authored code.
   */
  assert.equal(isProtectedPath("qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts"), true);
  /* SECURITY CRITICAL (verified by grep — absent before this fix): the write-confinement domain
     service is now the SOLE implementation of CONFINEMENT_DENYLIST + the classify/revert logic; an
     unreviewed autonomous "fix" here could silently narrow the denylist or break revert semantics.
   */
  assert.equal(isProtectedPath("qa-engine/src/contexts/workspace-and-publication/domain/write-confinement.service.ts"), true);
  /* the composition root — wires RedactionPortAdapter, WriteConfinementAdapter, VcsWriteAdapter,
     CODE_PUBLISH_EXCLUDES, and every GitHub adapter. An autonomous edit here can rewire ANY
     security port to a weaker (or fake) implementation without touching the port/adapter files
     themselves.
   */
  assert.equal(isProtectedPath("src/server/rewritten-engine-factory.ts"), true);
  /* the canonical REDACTED placeholder + SecretLeakError, consumed by BOTH sanitizer twins
     (src/orchestrator/sanitizer.ts and qa-engine's sanitize-text.ts) — a fix could weaken redaction
     for the whole system from this single shared-kernel seam.
   */
  assert.equal(isProtectedPath("qa-engine/src/shared-kernel/ports/redaction.port.ts"), true);
  /* the logs→Issue containsSecret fail-loud call site — an autonomous fix could remove the guard
     that refuses to ship a secret-carrying Issue body.
   */
  assert.equal(isProtectedPath("qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/publication-port.adapter.ts"), true);
});

/* The adapter that actually WRITES auth material (storageState/client.p12/cert.pass)
   and the port contract that shapes it — an unreviewed edit here could silently redirect writes
   back into the agent-visible mirror, or drop a field a caller relies on to keep material out of
   it. Protected the same way as scrub-env.ts / auth-session-env.ts.
 */
test("isProtectedPath flags the auth-material adapter and its port contract", () => {
  assert.equal(isProtectedPath("qa-engine/src/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/qa-run-orchestration/application/ports/auth-session.port.ts"), true);
});

/* three control-plane auth files were BOTH unscanned (not
   under a SECURITY_SENSITIVE_SURFACE_ROOTS root) AND unprotected — a weakening edit to any of them
   passed silently. auth.ts mints/validates the HMAC session token; github-auth.ts is the push/admin
   authorization rule gating control-plane access; webhook.ts's verifySignature is the HMAC gate on
   who can trigger a run at all. None lives under either existing surface root (both are qa-engine
   dirs; these are src/server/ standalone files) — added as exact PROTECTED_PATHS entries rather than
   promoting all of src/server/ to a root, which would force review of ~40 unrelated files (views,
   metrics, telemetry, queue, …) with no genuine security content.
 */
test("isProtectedPath flags the control-plane auth boundary", () => {
  assert.equal(isProtectedPath("src/server/auth.ts"), true);
  assert.equal(isProtectedPath("src/server/github-auth.ts"), true);
  assert.equal(isProtectedPath("src/server/webhook.ts"), true);
});

/* api.ts is the REST control-plane router that decides which auth handlers are even
   reachable (it routes POST /api/auth/login and GET /api/auth/local to auth.ts/github-auth.ts) —
   auth.ts/github-auth.ts/webhook.ts were protected but the router deciding whether their guards run
   at all was not; an autonomous edit here could silently stop calling them, or route around them,
   without ever touching a protected file.
 */
test("isProtectedPath flags the control-plane router that decides auth-handler reachability", () => {
  assert.equal(isProtectedPath("src/server/api.ts"), true);
});

/* These four sequence the autonomous-deploy gates themselves (the SELF_MAINTAINER_AUTOMERGE
   kill-switch, assessChange/assessRate, performSwap/rollback, and the mandatory justification
   fields) — an autonomous fix that rewrites maintainer-runtime.ts could silently skip its own
   gates without ever touching merge-guard.ts, boot-guard.mjs or self-update.ts.
 */
test("isProtectedPath flags the maintainer runtime that sequences the autonomous-deploy gates", () => {
  assert.equal(isProtectedPath("src/server/maintainer-runtime.ts"), true);
  assert.equal(isProtectedPath("src/server/maintainer.ts"), true);
  assert.equal(isProtectedPath("src/server/maintainer-summary.ts"), true);
  assert.equal(isProtectedPath("src/server/maintainer-memory.ts"), true);
});

test("isProtectedPath flags the module that decides where the token, auth material, history and logs live", () => {
  assert.ok(existsSync(join(repoRoot, "src/paths.ts")), "a protected path naming a deleted file proves nothing");
  assert.equal(isProtectedPath("src/paths.ts"), true);
});

/* An exact entry names one file. A different file whose path merely starts with it (a .tsx sibling,
   a backup copy) is not that file and stays autonomously editable; only directory entries match by
   prefix. */
test("an exact protected entry protects that file only, never a longer path that starts with it", () => {
  for (const exact of ["src/paths.ts", "src/server/auth.ts", "Dockerfile", "package.json"]) {
    assert.equal(isProtectedPath(exact), true, exact);
    assert.equal(isProtectedPath(`${exact}x`), false, `${exact}x`);
    assert.equal(isProtectedPath(`${exact}.orig`), false, `${exact}.orig`);
  }
});

test("isProtectedPath flags the test infrastructure an autonomous fix could weaken to pass its own checks", () => {
  const testInfrastructure = [
    "test-setup.mjs",
    "scripts/test-write-guard.mjs",
    "src/server/web-console/console-harness.ts",
    "scripts/mutate.ts",
  ];
  for (const file of testInfrastructure) {
    assert.ok(existsSync(join(repoRoot, file)), `${file} must exist — a protected path naming a deleted file proves nothing`);
    assert.equal(isProtectedPath(file), true, `${file} must require human review`);
  }
});

/* assembled and sanitized — literally the directory the 4th and 5th unsanitized-prompt-site defects
   lived in (only sanitize-text.ts was protected; every sibling, including prompts.ts itself, was
   not). qa-run-orchestration/infrastructure/bridges/ is the port-implementation layer wiring EVERY
   domain security boundary (write-confinement, publication, GitHub) into the use case — only
   publication-port.adapter.ts was protected. Per-file judgment on exactly this class of surface has
   now failed 5 times (the meta-lesson) — rather than add a partial, reasoned allowlist here too, both
   directories are wholesale PROTECTED_PATHS prefixes: every file in them, present or future, requires
   human review. The residual is zero by construction, not by review, and needs no NOT_SECURITY_SENSITIVE
   entries at all.
 */
test("isProtectedPath flags the whole generation/infrastructure and orchestration bridges surface", () => {
  assert.equal(isProtectedPath("qa-engine/src/contexts/generation/infrastructure/prompt-builders/prompts.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/generation/infrastructure/route-catalog.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/generation/infrastructure/sse/reexplore.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/deploy-gate-port.adapter.ts"), true);
});

/* despite being squarely inside the secret/confinement/review boundary this module protects. */
test("isProtectedPath flags repo-mirror.ts, codex-strategy.ts and agent-runtime/config.ts", () => {
  /* owns authHeaderArgs() (GITHUB_TOKEN into git URLs), hardenGitArgs() (disables hooksPath — its own
     comment calls this a root-RCE escape), and scrubGitError() (its comment cites a PAST incident of a
     PAT logged in plaintext).
   */
  assert.equal(isProtectedPath("src/integrations/repo-mirror.ts"), true);
  /* codexExecEnv's env allowlist for untrusted `codex exec` spawns — same risk class as scrub-env.ts,
     already protected above.
   */
  assert.equal(isProtectedPath("src/agent-runtime/codex-strategy.ts"), true);
  /* reviewerPrimaryCollisionErrors is the SOLE guard that reviewer/primary use different models —
     deleting it silently collapses dual-mode review into a rubber stamp.
   */
  assert.equal(isProtectedPath("src/agent-runtime/config.ts"), true);
});

test("every file under the security-sensitive surface is either protected or explicitly reviewed as not-sensitive", () => {
  const unclassified = unclassifiedUnder(repoRoot, SECURITY_SENSITIVE_SURFACE_ROOTS);
  assert.deepEqual(unclassified, [], `unclassified security-sensitive file(s) — add each to PROTECTED_PATHS or NOT_SECURITY_SENSITIVE: ${JSON.stringify(unclassified)}`);
});

/* The default is inverted: a NEW file under the surface forces a classification decision whatever it
   is named — an enumeration of "sensitive-looking" names would miss secrets.ts, confine.ts, egress.ts.
 */
test("a newly added file under the security-sensitive surface is flagged whatever its name, while protected and reviewed files are not", () => {
  const domain = "qa-engine/src/contexts/workspace-and-publication/domain/";
  const planted = ["secret-guard.service.ts", "secrets.ts", "confine.ts", "egress.ts"].map((name) => `${domain}${name}`);
  const protectedFile = PROTECTED_PATHS.find((p) => !p.endsWith("/") && !p.startsWith("*") && isSecuritySensitiveSurface(p));
  const reviewedFile = NOT_SECURITY_SENSITIVE[0];
  assert.ok(protectedFile && reviewedFile, "the surface must hold at least one protected and one reviewed file");

  const treeRoot = tempTreeWith([...planted, protectedFile, reviewedFile]);
  try {
    const unclassified = unclassifiedUnder(treeRoot, SECURITY_SENSITIVE_SURFACE_ROOTS);
    for (const file of planted) {
      assert.ok(unclassified.includes(file), `${file} must be flagged the moment it appears (got: ${JSON.stringify(unclassified)})`);
    }
    assert.equal(unclassified.includes(protectedFile), false, `${protectedFile} is protected and must not be flagged`);
    assert.equal(unclassified.includes(reviewedFile), false, `${reviewedFile} is reviewed as not-sensitive and must not be flagged`);
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
});

/* generation/infrastructure/ and qa-run-orchestration/infrastructure/bridges/ must be in
   SECURITY_SENSITIVE_SURFACE_ROOTS so the completeness walk scans them: narrowing the blanket
   generation/infrastructure/ prefix to per-file entries that skip ONE existing file must be caught.
 */
test("narrowing the generation/infrastructure protection past one file is caught by the completeness walk", () => {
  const root = "qa-engine/src/contexts/generation/infrastructure/";
  const idx = PROTECTED_PATHS.indexOf(root);
  assert.ok(idx >= 0, "expected the blanket prefix entry to exist in PROTECTED_PATHS before mutating it");

  const files: string[] = [];
  walk(join(repoRoot, root), files);
  const relFiles = files.map((f) => relative(repoRoot, f).replace(/\\/g, "/"));
  const skipped = relFiles[0];
  assert.ok(skipped, "generation/infrastructure/ must hold at least one file");
  const narrowed = relFiles.filter((f) => f !== skipped);
  PROTECTED_PATHS.splice(idx, 1, ...narrowed);
  try {
    assert.equal(isProtectedPath(skipped), false, `sanity: the narrowing must leave ${skipped} unprotected`);
    const unclassified = unclassifiedUnder(repoRoot, SECURITY_SENSITIVE_SURFACE_ROOTS);
    assert.ok(unclassified.includes(skipped), `the completeness walk must catch the narrowed prefix — got unclassified: ${JSON.stringify(unclassified)}`);
  } finally {
    PROTECTED_PATHS.splice(idx, narrowed.length, root);
  }
});

test("isProtectedPath flags the gate-integrity surface (the fix must not weaken its own gate)", () => {
  /* *.test.ts (suffix glob, anywhere) — the npm-test gate the pre-deploy self-test runs. */
  assert.equal(isProtectedPath("qa-engine/test/contexts/objective-signal/domain/decide-coverage.service.test.ts"), true);
  assert.equal(isProtectedPath("src/server/queue.test.ts"), true);
  assert.equal(isProtectedPath("./src/server/merge-guard.test.ts"), true);
  assert.equal(isProtectedPath("tsconfig.json"), true);
  assert.equal(isProtectedPath("src/index.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/test-execution/infrastructure/code-setup.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/shared-infrastructure/process-sandbox/sandbox.ts"), true);
  /* which spawns agent-authored specs (untrusted) exactly like code-execution.runner.ts above. */
  assert.equal(isProtectedPath("qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts"), true);
  /* a non-test source file next to its tests is still editable (glob is a strict .test.ts suffix). */
  assert.equal(isProtectedPath("src/server/queue.ts"), false);
});

test("assessChange blocks a fix that touches a protected file", () => {
  const r = assessChange({ files: [ORDINARY_FILES[0]!, "boot-guard.mjs"], additions: 5, deletions: 2 });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes("protected")));
});

test("assessChange blocks an over-large fix (files or lines)", () => {
  const tooManyFiles = assessChange({ files: Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`), additions: 10, deletions: 0 });
  assert.equal(tooManyFiles.ok, false);
  assert.ok(tooManyFiles.reasons.some((x) => x.includes("file")));

  const tooManyLines = assessChange({ files: ["src/a.ts"], additions: 500, deletions: 50 });
  assert.equal(tooManyLines.ok, false);
  assert.ok(tooManyLines.reasons.some((x) => x.includes("line")));
});

test("assessChange allows a minimal, in-scope fix", () => {
  const r = assessChange({ files: ORDINARY_FILES.slice(0, 2), additions: 12, deletions: 4 });
  assert.deepEqual(r, { ok: true, reasons: [] });
});

test("assessChange blocks an empty change", () => {
  assert.equal(assessChange({ files: [], additions: 0, deletions: 0 }).ok, false);
});

test("parseNumstat handles text and binary rows", () => {
  const out = ["3\t1\tsrc/a.ts", "10\t0\tsrc/b.ts", "-\t-\tassets/logo.png"].join("\n");
  const stat = parseNumstat(out);
  assert.deepEqual(stat.files, ["src/a.ts", "src/b.ts", "assets/logo.png"]);
  assert.equal(stat.additions, 13);
  assert.equal(stat.deletions, 1);
});

test("a renamed protected file (delete row under --no-renames) is still caught", () => {
  /* With --no-renames, renaming boot-guard.mjs surfaces as a delete of the protected path
     plus an add of the new one. assessChange must block on the delete row.
   */
  const out = ["0\t40\tboot-guard.mjs", "40\t0\tboot-guard-x.mjs"].join("\n");
  const r = assessChange(parseNumstat(out));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes("protected")));
});

/* A directory entry of PROTECTED_PATHS: every path under it needs human review. */
const PROTECTED_DIR = PROTECTED_PATHS.find((p) => p.startsWith("qa-engine/") && p.endsWith("/")) as string;

test("git's own numstat for a non-ASCII path or a rename into a protected directory is blocked", () => {
  const repo = mkdtempSync(join(tmpdir(), "merge-guard-numstat-"));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
    const git = (...args: string[]): string =>
      execFileSync("git", ["-c", "core.quotePath=true", ...args], { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const write = (rel: string, body: string) => {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), body);
    };
    const commit = (): string => {
      git("add", "-A");
      git("commit", "-qm", "step");
      return git("rev-parse", "HEAD").trim();
    };
    git("init", "-q");
    write("src/x/mv.ts", "export const moved = 1;\n");
    write("src/x/mvé.ts", "export const accented = 1;\n");
    const base = commit();
    write(`${PROTECTED_DIR}café.ts`, "export const added = 1;\n");
    const added = commit();
    git("mv", "src/x/mv.ts", `${PROTECTED_DIR}mv.ts`);
    const braceRename = commit();
    git("mv", "src/x/mvé.ts", `${PROTECTED_DIR}mvé.ts`);
    const quotedRename = commit();

    const cases = [
      { what: "a quoted non-ASCII add", out: git("diff", "--numstat", "--no-renames", base, added), shape: '"' },
      { what: "a brace-compacted rename", out: git("diff", "--numstat", added, braceRename), shape: "{" },
      { what: "a quoted rename", out: git("diff", "--numstat", braceRename, quotedRename), shape: '" => "' },
    ];
    for (const { what, out, shape } of cases) {
      assert.ok(out.includes(shape), `git printed ${what} as ${JSON.stringify(out)}`);
      assert.equal(assessChange(parseNumstat(out)).ok, false, `${what} must be blocked: ${JSON.stringify(out)}`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("parseNumstat decodes a C-quoted non-ASCII path, so a change under a protected directory is blocked", () => {
  const stat = parseNumstat(`1\t0\t"${PROTECTED_DIR}caf\\303\\251.ts"\n`);
  assert.deepEqual(stat.files, [`${PROTECTED_DIR}café.ts`]);
  assert.equal(assessChange(stat).ok, false);
});

test("parseNumstat decodes the escapes git quotes a path for", () => {
  const out = ['1\t0\t"src/x/q\\"uote.ts"', '1\t0\t"src/x/tab\\tname.ts"', '1\t0\t"src/x/back\\\\slash.ts"'].join("\n");
  assert.deepEqual(parseNumstat(out).files, ['src/x/q"uote.ts', "src/x/tab\tname.ts", "src/x/back\\slash.ts"]);
});

test("a quoted path holding the rename arrow is one path, and a quoted old side ends at its closing quote", () => {
  assert.deepEqual(parseNumstat('1\t0\t"docs/a => b\\303\\251.md"').files, ["docs/a => bé.md"]);
  assert.deepEqual(parseNumstat('0\t0\t"docs/\\303\\251.md" => notes/a => b.md').files, ["docs/é.md", "notes/a => b.md"]);
});

test("parseNumstat keeps a bare path with spaces as one file", () => {
  const stat = parseNumstat("1\t0\twe ird/sp ace.ts\n");
  assert.deepEqual(stat.files, ["we ird/sp ace.ts"]);
  assert.equal(assessChange(stat).ok, true);
});

test("a quoted rename into a protected directory names both paths and is blocked", () => {
  const stat = parseNumstat(`0\t0\t"src/x/mv\\303\\251.ts" => "${PROTECTED_DIR}mv\\303\\251.ts"\n`);
  assert.deepEqual(stat.files, ["src/x/mvé.ts", `${PROTECTED_DIR}mvé.ts`]);
  assert.equal(assessChange(stat).ok, false);
});

test("a rename mixing a quoted and a bare side names both paths", () => {
  assert.deepEqual(parseNumstat(`0\t0\t"${PROTECTED_DIR}caf\\303\\251.ts" => docs/cafe.ts`).files, [`${PROTECTED_DIR}café.ts`, "docs/cafe.ts"]);
  const intoProtected = parseNumstat(`0\t0\tsrc/plain.ts => "${PROTECTED_DIR}caf\\303\\251.ts"`);
  assert.deepEqual(intoProtected.files, ["src/plain.ts", `${PROTECTED_DIR}café.ts`]);
  assert.equal(assessChange(intoProtected).ok, false);
});

test("a rename with no shared directory names both paths, so a rename onto a protected file is blocked", () => {
  const stat = parseNumstat("0\t0\tnotes.ts => src/server/merge-guard.ts\n");
  assert.deepEqual(stat.files, ["notes.ts", "src/server/merge-guard.ts"]);
  assert.equal(assessChange(stat).ok, false);
});

test("a brace-compacted rename into a protected directory is blocked", () => {
  const stat = parseNumstat(`0\t0\t{src/x => ${PROTECTED_DIR.slice(0, -1)}}/mv.ts\n`);
  assert.ok(stat.files.includes("src/x/mv.ts"), JSON.stringify(stat.files));
  assert.ok(stat.files.includes(`${PROTECTED_DIR}mv.ts`), JSON.stringify(stat.files));
  assert.equal(assessChange(stat).ok, false);
});

test("a brace-compacted rename names the real old and new paths, including a move into a new subdirectory", () => {
  const stat = parseNumstat(["0\t0\tsrc/x/{plain.ts => plain2.ts}", "0\t0\tsrc/{ => sub}/a.ts"].join("\n"));
  for (const path of ["src/x/plain.ts", "src/x/plain2.ts", "src/a.ts", "src/sub/a.ts"]) {
    assert.ok(stat.files.includes(path), `${path} in ${JSON.stringify(stat.files)}`);
  }
  assert.equal(assessChange(stat).ok, true);
});

/* A brace-shaped field is also a valid plain rename of two brace-named files; both readings are
   checked, so a protected new path hidden behind a brace-named old path is still caught. */
test("a brace-shaped rename is also checked as a plain rename of brace-named files", () => {
  const stat = parseNumstat(`0\t0\ta/{b => ${PROTECTED_DIR}evil}\n`);
  assert.ok(stat.files.includes(`${PROTECTED_DIR}evil}`), JSON.stringify(stat.files));
  assert.equal(assessChange(stat).ok, false);
});

test("a rename with a brace on one side only is a plain rename of its two paths", () => {
  assert.deepEqual(parseNumstat("0\t0\tx{1}.ts => y.ts").files, ["x{1}.ts", "y.ts"]);
  assert.deepEqual(parseNumstat("0\t0\tx.ts => y}.ts").files, ["x.ts", "y}.ts"]);
});

test("a numstat row git never prints blocks an otherwise allowed change and is named in the reason", () => {
  const rows = [
    "not a numstat row",
    "x1\t0\tsrc/a.ts",
    "1\t0\t",
    "1\t0\tsrc/a.ts\r",
    '1\t0\t"',
    '1\t0\tsrc/a.ts"',
    "1\t0\tsrc\\a.ts",
    "1\t0\tsrc/a.ts\tsrc/b.ts",
    '1\t0\t"src/a.ts',
    '1\t0\t"src/a.ts"x',
    '1\t0\t"src/\\q.ts"',
    '0\t0\t"src/a.ts" => "src/b.ts',
    '0\t0\t"src/a.ts" => "src/b.ts"x',
    "0\t0\ta.ts => b.ts => c.ts",
    "0\t0\tsrc/{a{b => c}/d.ts",
    "0\t0\tsrc/{a => b}}/d.ts",
  ];
  assert.equal(assessChange(parseNumstat("1\t0\tsrc/server/queue.ts\n")).ok, true, "the allowed row alone passes");
  for (const row of rows) {
    const r = assessChange(parseNumstat(`1\t0\tsrc/server/queue.ts\n${row}\n`));
    assert.equal(r.ok, false, `${JSON.stringify(row)} must block`);
    assert.ok(r.reasons.some((x) => x.includes(row)), `${JSON.stringify(row)} named in ${JSON.stringify(r.reasons)}`);
  }
});

test("assessRate blocks a burst (window) and back-to-back deploys (cooldown)", () => {
  const now = 1_000_000_000_000;
  const burst = [now - 1000, now - 2000, now - 3000];
  assert.equal(assessRate(burst, now).ok, false);

  const recent = [now - 1000];
  const r = assessRate(recent, now);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes("cooldown")));
});

/* The reasons are what an operator reads when an autonomous deploy is refused: they must carry the
   window, the time since the last deploy and the cooldown in the units they name. */
test("assessRate's reasons name the window in minutes and the elapsed time and cooldown in seconds", () => {
  const now = 1_000_000_000_000;
  const limits = { maxInWindow: 2, windowMs: 90 * 60_000, cooldownMs: 240_000 };
  const r = assessRate([now - 30_000, now - 600_000], now, limits);
  const window = r.reasons.find((x) => /min\b/.test(x)) ?? "";
  const cooldown = r.reasons.find((x) => x.includes("cooldown")) ?? "";
  assert.match(window, /\b90\s*min\b/);
  assert.match(cooldown, /\b30\s*s\b/);
  assert.match(cooldown, /\b240\s*s\b/);
});

test("assessRate allows a deploy after the cooldown with few recent deploys", () => {
  const now = 1_000_000_000_000;
  const old = [now - DEFAULT_RATE_LIMITS.cooldownMs - 1000];
  assert.deepEqual(assessRate(old, now), { ok: true, reasons: [] });
  assert.equal(assessRate([], now).ok, true);
});

test("deploy ledger persists timestamps and round-trips", () => {
  const store = new Map<string, string>();
  const fs: LedgerFs = {
    read: (p) => store.get(p) ?? null,
    write: (p, s) => void store.set(p, s),
  };
  const path = "/data/maintainer-deploys.json";
  assert.deepEqual(readDeployHistory(path, fs), []);
  recordDeploy(path, 100, fs);
  recordDeploy(path, 200, fs);
  assert.deepEqual(readDeployHistory(path, fs), [100, 200]);
});

test("readDeployHistory tolerates corrupt/missing ledger files", () => {
  const fs: LedgerFs = { read: () => "not json", write: () => {} };
  assert.deepEqual(readDeployHistory("/x", fs), []);
  const none: LedgerFs = { read: () => null, write: () => {} };
  assert.deepEqual(readDeployHistory("/x", none), []);
});

test("isProtectedPath protects every image build and dependency manifest", () => {
  for (const file of ["agents/Dockerfile", "docker-compose.override.yml", "package.json", "package-lock.json"]) {
    assert.equal(isProtectedPath(file), true, `${file} must require human review`);
  }
});

test("assessChange allows exactly the file and line limits and blocks one past either", () => {
  const { maxFiles, maxLines } = DEFAULT_CHANGE_LIMITS;
  const files = (n: number) => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
  assert.equal(assessChange({ files: files(maxFiles), additions: 1, deletions: 0 }).ok, true);
  assert.equal(assessChange({ files: files(maxFiles + 1), additions: 1, deletions: 0 }).ok, false);
  assert.equal(assessChange({ files: ["src/a.ts"], additions: maxLines, deletions: 0 }).ok, true);
  assert.equal(assessChange({ files: ["src/a.ts"], additions: maxLines, deletions: 1 }).ok, false);
});

test("assessChange counts deleted lines toward the line limit", () => {
  assert.equal(assessChange({ files: ["src/a.ts"], additions: 0, deletions: DEFAULT_CHANGE_LIMITS.maxLines + 1 }).ok, false);
});

test("a line that is not a numstat row names no changed file and blocks the change", () => {
  const stat = parseNumstat("not a numstat row\n");
  assert.deepEqual(stat.files, []);
  assert.equal(assessChange(stat).ok, false);
});

test("every reason a gate blocks with is a non-empty explanation", () => {
  const now = 1_000_000_000_000;
  const { maxInWindow, cooldownMs } = DEFAULT_RATE_LIMITS;
  const blocked = [
    assessChange({ files: [], additions: 0, deletions: 0 }),
    assessChange({ files: ["boot-guard.mjs"], additions: 1, deletions: 0 }),
    assessRate(Array.from({ length: maxInWindow }, (_, i) => now - cooldownMs - (i + 1) * 1000), now),
    assessRate([now - 1000], now),
  ];
  for (const r of blocked) {
    assert.equal(r.ok, false);
    assert.ok(r.reasons.length > 0 && r.reasons.every((x) => x.trim().length > 0), JSON.stringify(r.reasons));
  }
});

/* Deploy timestamps placed after the cooldown but inside the window isolate the window limit. */
test("assessRate blocks maxInWindow deploys inside the window even once the cooldown has passed", () => {
  const now = 1_000_000_000_000;
  const { maxInWindow, cooldownMs } = DEFAULT_RATE_LIMITS;
  const history = Array.from({ length: maxInWindow }, (_, i) => now - cooldownMs - (i + 1) * 1000);
  const r = assessRate(history, now);
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 1, "only the window limit is hit");
  assert.equal(assessRate(history.slice(1), now).ok, true, "one deploy fewer is allowed");
});

test("assessRate: a deploy exactly windowMs ago no longer counts toward the window", () => {
  const now = 1_000_000_000_000;
  const { maxInWindow, cooldownMs, windowMs } = DEFAULT_RATE_LIMITS;
  const inside = Array.from({ length: maxInWindow - 1 }, (_, i) => now - cooldownMs - (i + 1) * 1000);
  assert.deepEqual(assessRate([...inside, now - windowMs], now), { ok: true, reasons: [] });
});

test("assessRate: a deploy recorded at this instant counts toward the window; a future-dated one (clock skew) does not", () => {
  const now = 1_000_000_000_000;
  const { maxInWindow, cooldownMs } = DEFAULT_RATE_LIMITS;
  const earlier = Array.from({ length: maxInWindow - 1 }, (_, i) => now - cooldownMs - (i + 1) * 1000);
  assert.equal(assessRate([...earlier, now], now).reasons.length, 2, "window and cooldown");
  const future = assessRate([...earlier, now + 1000], now);
  assert.equal(future.ok, false);
  assert.equal(future.reasons.length, 1, "cooldown only");
});

test("assessRate: the cooldown runs from the most recent deploy, whatever the ledger order", () => {
  const now = 1_000_000_000_000;
  assert.equal(assessRate([now - 1000, now - DEFAULT_RATE_LIMITS.windowMs * 2], now).ok, false);
});

test("assessRate: a deploy exactly cooldownMs ago is past the cooldown", () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(assessRate([now - DEFAULT_RATE_LIMITS.cooldownMs], now), { ok: true, reasons: [] });
});

test("readDeployHistory drops non-numeric ledger entries (they would make the cooldown unmeasurable)", () => {
  const fs: LedgerFs = { read: () => JSON.stringify([100, "200", null, 300]), write: () => {} };
  assert.deepEqual(readDeployHistory("/x", fs), [100, 300]);
});

test("recordDeploy keeps only the newest `keep` timestamps", () => {
  const store = new Map<string, string>();
  const fs: LedgerFs = { read: (p) => store.get(p) ?? null, write: (p, s) => void store.set(p, s) };
  for (const t of [1, 2, 3]) recordDeploy("/ledger.json", t, fs, 2);
  assert.deepEqual(readDeployHistory("/ledger.json", fs), [2, 3]);
});

test("the real ledger store persists deploys on disk across reads, creating its directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "qayaba-deploy-ledger-"));
  try {
    const path = join(dir, "nested", "maintainer-deploys.json");
    recordDeploy(path, 100);
    recordDeploy(path, 200);
    assert.deepEqual(readDeployHistory(path), [100, 200]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
