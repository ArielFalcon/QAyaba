/* The model-agnostic prompt guard: no prompt names a model. A limit, a tier or a budget comes from the runtime or from a named constant, never from which model runs, so a text that names a model id or a family is a defect wherever it stands. The guard scans the static role and shared layers of both mirrors, the skills and the assembled generator, explorer and reviewer prompts, in three layers:
   - derived: every id and label a declared model source holds (the runtime agent config and its fallbacks, each provider's role defaults, the cataloged windows, the proposer's pin), so a model configured later is caught with no edit here. An id is forbidden anywhere, its family only next to a version chunk;
   - fixed list: well-known vendor and family names, forbidden anywhere. The list only forbids: nothing selects a prompt, a limit or a rule by it;
   - headings: the parenthetical of a role's title holds no version-like token and no letter segment of a declared id.
   Matching is whole-word and blind to case and separators. This file lives under scripts/ because it drives the prompt-contract matrix, whose imports carry `.ts` extensions the root typecheck does not accept. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOGED_MODELS } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog.ts";
import {
  buildExplorerPrompt,
  buildPromptAssembled,
  buildReviewerPromptAssembled,
  renderExecutionResult,
  setExplorationBriefCollaborators,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { ReviewInput } from "@contexts/generation/application/ports/generation-ports.ts";
import { coerceExplorationBrief, parseExplorationBrief, renderExplorationBrief } from "../src/qa/exploration-brief.ts";
import { singleProviderConfig } from "../src/agent-runtime/config.ts";
import { CODEX_MODELS, codexPreambleParts } from "../src/agent-runtime/codex-strategy.ts";
import { OpenCodeRuntimeStrategy } from "../src/agent-runtime/opencode-strategy.ts";
import { AGENT_NAME_FOR_ROLE, type AgentModelInfo, type AgentRole } from "../src/agent-runtime/types.ts";
import { PROPOSER_MODEL } from "../src/server/onboarding/llm-profile-proposer.adapter.ts";
import { DIMENSIONS, allValidSpecs, buildInput, cellName, type CellSpec } from "./prompt-contract-matrix.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ── the scanner ── */

type Layer = "declared-id" | "declared-family" | "vendor" | "heading";

interface Finding {
  /* The file or the prompt the text came from. */
  source: string;
  layer: Layer;
  /* The model reference as it is written in the text: an id, a family or a vendor, or the offending word of a title. */
  token: string;
}

interface ModelTerms {
  /* Declared ids and labels, each spelled as one lowercase run without separators. */
  ids: readonly string[];
  /* The family of each declared id, spelled the same way. */
  families: readonly string[];
  /* The alphabetic words of the declared ids, two letters or more. */
  segments: ReadonlySet<string>;
}

/* The fixed list. It only forbids: nothing selects a prompt, a limit or a rule by it. */
const VENDORS: readonly string[] = [
  "deepseek", "qwen", "glm", "kimi", "minimax", "gpt", "claude", "opus", "sonnet", "haiku",
  "gemini", "gemma", "llama", "mistral", "mixtral", "devstral", "codestral", "grok", "nemotron",
];

/* The words with a digit a title may keep in its parentheses. Case-sensitive, so anything else with a digit reads as a version. */
const KNOWN_ACRONYMS: readonly string[] = ["E2E", "OAuth2"];

/* A family of fewer letters ("o" of "o3") is a letter in prose, not a name. */
const MIN_FAMILY_LETTERS = 3;

interface Token {
  value: string;
  start: number;
  end: number;
}

interface Run {
  start: number;
  end: number;
}

/* The alphabetic and numeric runs of a text, lowercased. The seam between letters and digits is a boundary, so "k2.7" and "k 2 7" read alike. */
function tokenize(text: string): Token[] {
  return [...text.matchAll(/[a-z]+|\d+/gi)].map((m) => ({ value: m[0].toLowerCase(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

const spell = (text: string): string => tokenize(text).map((t) => t.value).join("");

/* The words of an id that name its family: the letter words before its first version segment ("glm-5.3-flash" gives glm). A first segment that fuses name and version ("qwen3.7") gives its letters; a later one ("k2.7" in "kimi-k2.7-code") is the version itself. */
function familyWords(name: string): string[] {
  const words: string[] = [];
  for (const [index, segment] of name.split(/[\s_/-]+/).filter(Boolean).entries()) {
    if (!/\d/.test(segment)) {
      words.push(segment);
      continue;
    }
    const lead = /^[a-z]+/i.exec(segment)?.[0];
    if (index === 0 && lead) words.push(lead);
    break;
  }
  return words;
}

/* What the declared models forbid: each id or label without its provider prefix, its family, and its alphabetic words. */
function deriveModelTerms(declared: readonly string[]): ModelTerms {
  const ids = new Set<string>();
  const families = new Set<string>();
  const segments = new Set<string>();
  for (const model of declared) {
    const name = (model.split("/").pop() ?? "").trim();
    const id = spell(name);
    if (id) ids.add(id);
    const family = spell(familyWords(name).join(" "));
    if (family.length >= MIN_FAMILY_LETTERS) families.add(family);
    for (const { value } of tokenize(name)) if (/^[a-z]{2,}$/.test(value)) segments.add(value);
  }
  return { ids: [...ids], families: [...families], segments };
}

/* Every run of whole tokens whose letters and digits, joined, spell `compact`. */
function runsSpelling(tokens: readonly Token[], compact: string): Run[] {
  const runs: Run[] = [];
  for (let start = 0; start < tokens.length; start++) {
    let spelled = "";
    for (let end = start; end < tokens.length; end++) {
      spelled += tokens[end]!.value;
      if (!compact.startsWith(spelled)) break;
      if (spelled === compact) {
        runs.push({ start, end: end + 1 });
        break;
      }
    }
  }
  return runs;
}

/* A version chunk beside the run: digits ("5.3"), or one letter and digits ("v2", "k2.7"). */
function besideVersion(tokens: readonly Token[], run: Run): boolean {
  const isDigits = (t: Token | undefined): boolean => t !== undefined && /^\d+$/.test(t.value);
  const after = tokens[run.end];
  return isDigits(tokens[run.start - 1]) || isDigits(after) || (after !== undefined && /^[a-z]$/.test(after.value) && isDigits(tokens[run.end + 1]));
}

/* Where two references cover the same words, the earlier layer names them. */
const LAYER_PRIORITY: Record<Exclude<Layer, "heading">, number> = { "declared-id": 0, "declared-family": 1, vendor: 2 };

/* A text names a model through the longest reference that covers it: the whole id, else its family beside a version, else a listed vendor. Findings come in text order. */
function scanText(source: string, text: string, terms: ModelTerms): Finding[] {
  const tokens = tokenize(text);
  const candidates: Array<{ layer: Exclude<Layer, "heading">; run: Run }> = [
    ...terms.ids.flatMap((id) => runsSpelling(tokens, id).map((run) => ({ layer: "declared-id" as const, run }))),
    ...terms.families.flatMap((family) =>
      runsSpelling(tokens, family).filter((run) => besideVersion(tokens, run)).map((run) => ({ layer: "declared-family" as const, run })),
    ),
    ...VENDORS.flatMap((vendor) => runsSpelling(tokens, vendor).map((run) => ({ layer: "vendor" as const, run }))),
  ];
  candidates.sort((a, b) => b.run.end - b.run.start - (a.run.end - a.run.start) || LAYER_PRIORITY[a.layer] - LAYER_PRIORITY[b.layer]);
  const kept: typeof candidates = [];
  for (const candidate of candidates) {
    if (!kept.some(({ run }) => run.start <= candidate.run.start && candidate.run.end <= run.end)) kept.push(candidate);
  }
  const found = new Map<string, Finding>();
  for (const { layer, run } of kept.sort((a, b) => a.run.start - b.run.start)) {
    const token = text.slice(tokens[run.start]!.start, tokens[run.end - 1]!.end);
    found.set(`${layer}|${token}`, { source, layer, token });
  }
  return [...found.values()];
}

/* The first heading is a role's title. Its parentheses may hold acronyms and plain words, never a word with a digit that is not a known acronym, nor a word that is a segment of a declared id. */
function titleFindings(source: string, markdown: string, terms: ModelTerms): Finding[] {
  const title = /^# (.+)$/m.exec(markdown)?.[1] ?? "";
  const findings: Finding[] = [];
  for (const [, inside = ""] of title.matchAll(/\(([^)]*)\)/g)) {
    for (const word of inside.split(/[\s,;:/_-]+/).filter(Boolean)) {
      const versionLike = /\d/.test(word) && !KNOWN_ACRONYMS.includes(word);
      const idSegment = /^[a-z]+$/i.test(word) && terms.segments.has(word.toLowerCase());
      if (versionLike || idSegment) findings.push({ source, layer: "heading", token: word });
    }
  }
  return findings;
}

/* The cells, taken in matrix order, that bring a value of a dimension not yet held: together they hold every value of every dimension. */
function coveringSpecs(specs: readonly CellSpec[]): CellSpec[] {
  const covered = new Set<string>();
  const chosen: CellSpec[] = [];
  for (const spec of specs) {
    const fresh = (Object.keys(DIMENSIONS) as Array<keyof CellSpec>).map((d) => `${d}=${String(spec[d])}`).filter((v) => !covered.has(v));
    if (fresh.length === 0) continue;
    for (const value of fresh) covered.add(value);
    chosen.push(spec);
  }
  return chosen;
}

const describeFindings = (findings: readonly Finding[]): string =>
  findings.map((f) => `${f.source}: ${f.layer} "${f.token}"`).join("\n");

/* ── what the repository declares ── */

async function readDeclaredModelSources(root: string = ROOT): Promise<Record<string, string[]>> {
  const opencode = JSON.parse(readFileSync(join(root, "agents", "opencode.json"), "utf8")) as {
    agent?: Record<string, { model?: unknown }>;
    model_fallback?: Record<string, unknown>;
  };
  const strings = (values: readonly unknown[]): string[] => values.filter((v): v is string => typeof v === "string" && v.length > 0);
  const withLabels = (models: readonly AgentModelInfo[]): string[] => strings(models.flatMap((m) => [m.id, m.label]));
  /* A path nothing creates: the strategy then answers with its built-in fallback list. */
  const absentConfig = join(tmpdir(), "model-agnostic-prompts-no-such-dir", "opencode.json");
  return {
    "agents/opencode.json": strings([
      ...Object.values(opencode.agent ?? {}).map((a) => a.model),
      ...Object.values(opencode.model_fallback ?? {}),
    ]),
    "provider role defaults": (["opencode", "codex"] as const).flatMap((p) =>
      Object.values(singleProviderConfig(p, {}).assignments).map((a) => a.model),
    ),
    "OpenCode fallback list": withLabels(await new OpenCodeRuntimeStrategy({ configPath: absentConfig }).listModels()),
    "Codex model list": withLabels(CODEX_MODELS),
    "proposer pin": [PROPOSER_MODEL],
    "window catalog": [...CATALOGED_MODELS],
  };
}

let declaredOnce: Promise<Record<string, string[]>> | undefined;
const declaredModelSources = (): Promise<Record<string, string[]>> => (declaredOnce ??= readDeclaredModelSources());
const repoTerms = async (): Promise<ModelTerms> => deriveModelTerms(Object.values(await declaredModelSources()).flat());

/* ── the scanner, by behavior ── */

test("a declared model id is caught however it is cased or separated, whichever source declares it", async () => {
  const sources = await declaredModelSources();
  const terms = await repoTerms();
  const respell = (name: string): string[] => {
    const words = name.split(/[\s_-]+/);
    return [words.join("_").toUpperCase(), words.join(" ").toLowerCase(), words.join("")];
  };
  for (const [sourceName, declared] of Object.entries(sources)) {
    assert.ok(declared.length > 0, `${sourceName} declares at least one model`);
    for (const model of declared) {
      for (const spelled of respell(model.split("/").pop()!)) {
        const findings = scanText("fixture.md", `Route the work to ${spelled} first.`, terms);
        assert.deepEqual(
          findings.filter((f) => f.layer === "declared-id"),
          [{ source: "fixture.md", layer: "declared-id", token: spelled }],
          `${sourceName}: ${model} written as ${spelled}`,
        );
      }
    }
  }
});

test("a model configured later is caught with no edit here: its id in the agent config or its fallback map, and its family next to a version", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-agnostic-config-"));
  try {
    mkdirSync(join(root, "agents"));
    writeFileSync(
      join(root, "agents", "opencode.json"),
      JSON.stringify({
        agent: { "qa-generator": { model: "acme-cloud/orion-nova-7.1-turbo" } },
        model_fallback: { "qa-generator": "acme-cloud/zephyr-quill-2-lite" },
      }),
    );
    const before = await repoTerms();
    const after = deriveModelTerms(Object.values(await readDeclaredModelSources(root)).flat());

    assert.deepEqual(scanText("new.md", "Orion-Nova 7.1 Turbo writes the specs.", before), [], "unknown until it is configured");
    assert.deepEqual(scanText("new.md", "Orion-Nova 7.1 Turbo writes the specs.", after), [
      { source: "new.md", layer: "declared-id", token: "Orion-Nova 7.1 Turbo" },
    ]);
    assert.deepEqual(scanText("new.md", "Zephyr_Quill_2_Lite takes over.", after), [
      { source: "new.md", layer: "declared-id", token: "Zephyr_Quill_2_Lite" },
    ]);
    assert.deepEqual(scanText("new.md", "The OrionNova 9 release writes the specs.", after), [
      { source: "new.md", layer: "declared-family", token: "OrionNova" },
    ]);
    assert.deepEqual(scanText("new.md", "The orion nova v3 release writes the specs.", after), [
      { source: "new.md", layer: "declared-family", token: "orion nova" },
    ]);
    assert.deepEqual(scanText("new.md", "The orion nova of the night writes the specs.", after), [], "its family alone names no model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a derived family alone names no model: only a version next to it does", async () => {
  const terms = await repoTerms();
  assert.deepEqual(scanText("p.md", "A muse spark of insight changed the plan.", terms), []);
  assert.deepEqual(scanText("p.md", "Muse Spark 2 changed the plan.", terms), [{ source: "p.md", layer: "declared-family", token: "Muse Spark" }]);
  assert.deepEqual(scanText("p.md", "Muse Spark v2 changed the plan.", terms), [{ source: "p.md", layer: "declared-family", token: "Muse Spark" }]);
  assert.deepEqual(scanText("p.md", "The 1.3 Muse Spark build changed the plan.", terms), [{ source: "p.md", layer: "declared-family", token: "Muse Spark" }]);
});

test("a family of a single letter names no model: only the whole id does", () => {
  const terms = deriveModelTerms(["lab/o3-mini"]);
  assert.deepEqual(scanText("p.md", "Take 3 o 4 samples.", terms), []);
  assert.deepEqual(scanText("p.md", "Take the o3-mini samples.", terms), [{ source: "p.md", layer: "declared-id", token: "o3-mini" }]);
});

test("the words of a declared id are no finding in a body, only in a title", async () => {
  const terms = await repoTerms();
  assert.deepEqual(scanText("p.md", "Keep the code small, mark the flash message as read and add a mini helper.", terms), []);
});

test("a listed vendor is caught wherever it stands, as a whole word only", async () => {
  const terms = deriveModelTerms([]);
  /* The vendors the design lists: the guard may forbid more, never fewer. */
  const listed = [
    "deepseek", "qwen", "glm", "kimi", "minimax", "gpt", "claude", "opus", "sonnet", "haiku",
    "gemini", "gemma", "llama", "mistral", "mixtral", "devstral", "codestral", "grok", "nemotron",
  ];
  for (const vendor of listed) {
    const written = vendor[0]!.toUpperCase() + vendor.slice(1);
    assert.deepEqual(
      scanText("v.md", `Hand this to ${written} for a second opinion.`, terms),
      [{ source: "v.md", layer: "vendor", token: written }],
      vendor,
    );
  }
  assert.deepEqual(scanText("v.md", "Ask gpt5, then DEEP-SEEK.", terms), [
    { source: "v.md", layer: "vendor", token: "gpt" },
    { source: "v.md", layer: "vendor", token: "DEEP-SEEK" },
  ], "findings come in text order, however long each reference is");
  assert.deepEqual(scanText("v.md", "A deepseeker, a gptq file and a glmx key are no model.", terms), []);
});

test("a role title may carry acronyms and plain words in parentheses, never a version-like token or a segment of a declared id", async () => {
  const terms = await repoTerms();
  for (const title of ["# Worker (E2E)", "# Login helper (OAuth2)", "# Assistant (lite model)", "# Explorer", "# Reviewer (E2E, read-only)"]) {
    assert.deepEqual(titleFindings("t.md", `${title}\n\nBody.`, terms), [], title);
  }
  assert.deepEqual(titleFindings("t.md", "# Writer (Alpha V4)\n", terms), [{ source: "t.md", layer: "heading", token: "V4" }]);
  assert.deepEqual(titleFindings("t.md", "# Writer (e2e)\n", terms), [{ source: "t.md", layer: "heading", token: "e2e" }], "acronyms are case-sensitive");
  assert.deepEqual(titleFindings("t.md", "# Writer (Flash)\n", terms), [{ source: "t.md", layer: "heading", token: "Flash" }]);
  assert.deepEqual(titleFindings("t.md", "# Writer (spark-lite)\n", terms), [{ source: "t.md", layer: "heading", token: "spark" }]);
  assert.deepEqual(titleFindings("t.md", "# Writer\n\nA (V4) in the body is not a title.\n", terms), []);
});

/* ── the repository ── */

type PromptText = { source: string; text: string };

/* Every valid combination of the matrix is walked once: it is the slow part of reading the matrix. */
let validOnce: CellSpec[] | undefined;
const validSpecs = (): CellSpec[] => (validOnce ??= allValidSpecs());

const markdownIn = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => `${dir}/${f}`.replaceAll("\\", "/"));
const readAll = (paths: readonly string[]): PromptText[] => paths.map((source) => ({ source, text: readFileSync(join(ROOT, source), "utf8") }));

const rolePromptFiles = (): string[] => ["agents/AGENTS.md", "agent/AGENTS.md", ...markdownIn("agents/agent"), ...markdownIn("agent/roles")];
const skillFiles = (): string[] => [...markdownIn("agents/skill"), ...markdownIn("agent/skills")];

test("the role and shared prompts of both mirrors name no model", async () => {
  const terms = await repoTerms();
  const prompts = readAll(rolePromptFiles());
  const scanned = prompts.map((p) => p.source);
  for (const path of ["agents/AGENTS.md", "agent/AGENTS.md", "agents/agent/qa-generator.md", "agent/roles/qa-generator.md"]) {
    assert.ok(scanned.includes(path), `${path} is scanned`);
  }
  const findings = prompts.flatMap((p) => [...scanText(p.source, p.text, terms), ...titleFindings(p.source, p.text, terms)]);
  assert.equal(findings.length, 0, `model references in the role prompts:\n${describeFindings(findings)}`);
});

test("the skills of both mirrors name no model", async () => {
  const terms = await repoTerms();
  const skills = readAll(skillFiles());
  const scanned = skills.map((s) => s.source);
  for (const path of ["agents/skill/playwright-authoring/SKILL.md", "agent/skills/playwright-authoring/SKILL.md"]) {
    assert.ok(scanned.includes(path), `${path} is scanned`);
  }
  const findings = skills.flatMap((s) => scanText(s.source, s.text, terms));
  assert.equal(findings.length, 0, `model references in the skills:\n${describeFindings(findings)}`);
});

test("the generator cells scanned reach every value of every dimension", () => {
  const cells = coveringSpecs(validSpecs());
  assert.ok(cells.length > 0 && cells.length < validSpecs().length, "a subset of the matrix");
  for (const dimension of Object.keys(DIMENSIONS) as Array<keyof CellSpec>) {
    for (const value of DIMENSIONS[dimension] as readonly unknown[]) {
      assert.ok(cells.some((s) => s[dimension] === value), `${dimension}=${String(value)} is scanned`);
    }
  }
});

/* The reviewer inlines the specs it judges, so its prompts are built over a mirror that holds one. */
function withReviewMirror<T>(run: (review: (over?: Partial<ReviewInput>) => ReviewInput) => T): T {
  const mirror = mkdtempSync(join(tmpdir(), "model-agnostic-review-"));
  try {
    mkdirSync(join(mirror, "e2e"));
    writeFileSync(join(mirror, "e2e", "cart.spec.ts"), "import { test } from '@playwright/test';\ntest('cart shows the total', async ({ page }) => { await page.goto('/cart'); });\n");
    return run((over = {}) => ({
      diff: "diff --git a/src/cart.ts b/src/cart.ts\n+export const total = 1;\n",
      specs: ["cart.spec.ts"],
      mirrorDir: mirror,
      e2eRelDir: "e2e",
      appName: "shop",
      mode: "diff",
      ...over,
    }));
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}

const wireBriefRenderer = (): void => setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });

test("the assembled generator, explorer and reviewer prompts name no model", async () => {
  const terms = await repoTerms();
  wireBriefRenderer();
  const prompts: PromptText[] = [];
  for (const spec of coveringSpecs(validSpecs())) {
    const input = await buildInput(spec);
    prompts.push(
      { source: `generator prompt ${cellName(spec)}`, text: buildPromptAssembled(input, { budgetBytes: 0 }).text },
      { source: `explorer prompt ${cellName(spec)}`, text: buildExplorerPrompt(input) },
    );
  }
  withReviewMirror((review) => {
    const variants: Array<[string, ReviewInput]> = [
      ["diff", review()],
      ["code diff", review({ target: "code" })],
      ["manual", review({ mode: "manual", guidance: "cover the coupon form" })],
      ["complete", review({ mode: "complete" })],
      ["exhaustive", review({ mode: "exhaustive" })],
      [
        "grounded",
        review({
          baseUrl: "http://localhost:3000",
          domSnapshot: "heading: Cart",
          learnedRules: "## Learned rules\n- prefer role locators",
          priorCorrections: ["[fragile-selector] cart.spec.ts: scope the button"],
          executionResult: renderExecutionResult({ verdict: "pass", cases: [{ name: "cart shows the total", httpStatus: 200 }] }),
        }),
      ],
    ];
    for (const [name, input] of variants) prompts.push({ source: `reviewer prompt ${name}`, text: buildReviewerPromptAssembled(input).text });
  });

  assert.ok(prompts.length > 0);
  const findings = prompts.flatMap((p) => scanText(p.source, p.text, terms));
  assert.equal(findings.length, 0, `model references in the assembled prompts:\n${describeFindings(findings)}`);
});

test("the assembled-prompt scan reads what the builders emit: a model named in a fixture is found in the generator, explorer and reviewer prompts", async () => {
  const terms = await repoTerms();
  wireBriefRenderer();
  const cell = coveringSpecs(validSpecs()).find((s) => s.mode === "diff" && s.target === "e2e")!;
  const input = await buildInput(cell);
  const named = { ...input, intent: { ...input.intent!, message: "feat(cart): ask Deepseek for the total" } };
  const found = [{ source: "named", layer: "vendor", token: "Deepseek" }];

  assert.deepEqual(scanText("named", buildPromptAssembled(named, { budgetBytes: 0 }).text, terms), found);
  assert.deepEqual(scanText("named", buildExplorerPrompt(named), terms), found);
  withReviewMirror((review) => {
    const prompt = buildReviewerPromptAssembled(review({ mode: "manual", guidance: "ask Deepseek for the total" })).text;
    assert.deepEqual(scanText("named", prompt, terms), found);
  });
});

test("the Codex preamble of every role names no model", async () => {
  const terms = await repoTerms();
  const roles = Object.keys(AGENT_NAME_FOR_ROLE) as AgentRole[];
  const parts: PromptText[] = roles.flatMap((role) => {
    const preamble = codexPreambleParts(role, join(ROOT, "agent"));
    return [
      { source: `codex preamble ${role} shared`, text: preamble.shared },
      { source: `codex preamble ${role} role prompt`, text: preamble.rolePrompt },
      ...preamble.skills.map((s) => ({ source: `codex preamble ${role} skill ${s.name}`, text: s.body })),
    ];
  });
  for (const role of roles) {
    assert.ok(parts.some((p) => p.source === `codex preamble ${role} role prompt` && p.text.length > 0), `${role} has a role prompt to scan`);
  }
  const findings = parts.flatMap((p) => scanText(p.source, p.text, terms));
  assert.equal(findings.length, 0, `model references in the Codex preambles:\n${describeFindings(findings)}`);
});
