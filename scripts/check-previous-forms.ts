/* The CI gate that keeps retired forms retired: banned terms (a name or sentence that describes a previous form of the system) and dead file references (a path or a `file.ts:LINE` citation that points at nothing). Hits are allowed only through scripts/previous-forms.allow.json, and an allow-list entry that matches nothing fails the run, so the list only shrinks. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BannedRule {
  id: string;
  patterns: RegExp[];
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

export const BANNED_RULES: BannedRule[] = [
  { id: "engine-flag", patterns: [/PIPELINE_ENGINE/i, /pipeline-engine-flag/i, /selectEngine/i] },
  { id: "rewritten-name", patterns: [/Rewritten[A-Z]/, /rewritten-(engine|orchestrator)/i, /rewritten (engine|path|adapters?|orchestrator|publish)/i] },
  { id: "legacy", patterns: [/\blegacy\b/i, /\bLegacy[A-Z]/, /\blegacy[A-Z]/] },
  { id: "bridges", patterns: [/\bbridges?\//i, /wireBridges/i, /bridge adapters?/i, /grounding bridges/i, /the bridges/i] },
  { id: "codex", patterns: [/codex/i] },
  { id: "dual-mode", patterns: [/dual[- ](mode|runtime|agent)/i, /AGENT_RUNTIME_MODE/i, /\bAgentMode\b/i, /SingleAgentFacade/i, /DualAgentFacade/i] },
  { id: "router-kind", patterns: [/"router"/i, /orchestration-router/i, /RETIRED_EXPLORER_ROLE/i, /coordinationMode/i, /qa\.explorer/i] },
  { id: "claude-md", patterns: [/CLAUDE\.md/i] },
  { id: "codebase-memory", patterns: [/codebase-memory/i] },
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
   and the test runner's recorded file costs may name a test file deleted since they were recorded (the runner ignores such an entry). */
const REFERENCE_CHECK_SKIPPED = (path: string): boolean => path.includes("/__fixtures__/") || path === ".gitignore" || path === "scripts/test-timings.json";
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
