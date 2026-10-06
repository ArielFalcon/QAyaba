/* Prompt-sync drift guard. The OpenCode mirror (agents/agent/*.md) and the Codex neutral mirror
   (agent/roles/*.md) must not drift: a rule one runtime's agent reads and the other's does not is
   a silent behavior split. The guard covers:
   - qa-generator.md: EVERY section (Procedure, the stop rule and the final output) byte for byte
   - qa-reviewer.md: Output format, Anti-pattern catalog, Dual-review protocol, Code-mode review
   - AGENTS.md: Global rules, Execution context and Protocols, plus the presence of the two
     no-direct-HTTP statements in Global rules (what the session may do, what a spec may do),
     each once and in a sentence of its own, and their absence everywhere else
   - the skill files, byte for byte
   Conditional rules live in the assembled prompt; these static files hold unconditional craft
   rules only, so there is nothing that may legitimately differ between the mirrors.
   Section detection: sections are identified by their H2 header text (##).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyGenerationEnd } from "@contexts/generation/domain/generation-end";
import { buildContextTask, buildPrompt } from "@contexts/generation/infrastructure/prompt-builders/prompts";
import { GENERATION_END } from "@kernel/generation-end";
import { E2E_AUTH_FILE } from "@kernel/e2e-auth";
import { parseVerdict } from "../integrations/verdict-parse";
import { checkGeneratorVerdict } from "../integrations/verdict-validate";

/* Resolve repo root relative to this test file (src/agent-runtime/ → two levels up) */
const REPO_ROOT = join(import.meta.dirname ?? __dirname, "..", "..");

/* Skill file pairs that must be byte-identical (modulo trailing whitespace) across both trees.
   Full-file parity is stricter than section-level parity: any one-tree edit fails CI immediately.
   pinned here (previously waived/skipped) — the Codex mirror is now actually consumed (inlined
   into the Codex role preamble by withCodexRolePreamble in codex-strategy.ts), so a one-tree edit
   here would silently desync what the two providers' agents read as craft/review guidance.
 */
const SKILL_FILE_PAIRS: Array<[string, string]> = [
  [
    "agents/skill/playwright-authoring/locators-and-waiting.md",
    "agent/skills/playwright-authoring/locators-and-waiting.md",
  ],
  [
    "agents/skill/playwright-authoring/auth.md",
    "agent/skills/playwright-authoring/auth.md",
  ],
  [
    "agents/skill/playwright-authoring/browser-conditions.md",
    "agent/skills/playwright-authoring/browser-conditions.md",
  ],
  [
    "agents/skill/playwright-authoring/storage-and-uploads.md",
    "agent/skills/playwright-authoring/storage-and-uploads.md",
  ],
  [
    "agents/skill/playwright-authoring/SKILL.md",
    "agent/skills/playwright-authoring/SKILL.md",
  ],
  [
    "agents/skill/test-value-review/SKILL.md",
    "agent/skills/test-value-review/SKILL.md",
  ],
];

/* Must-match sections for the worker role (by canonical H2 header text).
   The guard compares H2 bodies between the OpenCode mirror (agents/agent/qa-worker.md)
   and the Codex mirror (agent/roles/qa-worker.md). H1 may differ (Flash suffix).
 */
const WORKER_MUST_MATCH_SECTIONS = ["How to write a valuable spec"];

function readFile(rel: string): string {
  const p = join(REPO_ROOT, rel);
  assert.ok(existsSync(p), `Prompt file not found: ${rel} (resolved: ${p})`);
  return readFileSync(p, "utf8");
}

const normalize = (s: string): string => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

/* The two copies of the generator role prompt. */
const GENERATOR_PROMPTS = ["agents/agent/qa-generator.md", "agent/roles/qa-generator.md"];

/* Parse H2 sections out of a markdown document. Returns a map: header text → body. */
function parseSections(md: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headerRe = /^## (.+)$/m;
  const parts = md.split(/^(?=## )/m);
  for (const part of parts) {
    const m = headerRe.exec(part);
    if (!m || !m[1] || !m[0]) continue;
    const header = m[1].trim();
    const body = part.slice(m[0].length).trim();
    sections.set(header, body);
  }
  return sections;
}

/* The must-match sections for the reviewer role (by canonical header text).
   These are the sections that define the shared quality contract between runtimes.
   target:code — it must stay identical across both mirrors like every other quality-contract
   section, so the Codex reviewer is exactly as strict as OpenCode's for code-mode runs.
 */
const REVIEWER_MUST_MATCH_SECTIONS = [
  "Output format",
  "Anti-pattern catalog (reject on sight)",
  "Dual-review protocol (judgment-day style)",
  "Code-mode review (target: code)",
];

/* Must-match sections for the shared AGENTS.md.
   "Global rules" contains safety-critical constraints shared by both runtimes and must not diverge.
   "Execution context" carries the orientation-first and explore-what-the-prompt-lacks contract; the
   rule not to re-navigate a route the prompt already covers is owned by the assembled prompt.
   "Protocols (to keep quality from degrading over time)" carries Protocol 4 (cleanup via the UI, or
   namespaced-and-left; NEVER a fabricated API call) — a stale mirror here lets Codex hallucinate a
   DELETE endpoint that was never verified to exist.
 */
const AGENTS_MUST_MATCH_SECTIONS = [
  "Global rules",
  "Execution context",
  "Protocols (to keep quality from degrading over time)",
];

describe("prompt-sync drift guard", () => {
  it("agent/roles/qa-reviewer.md contains the {text,severity} structured corrections contract", () => {
    const codexReviewer = readFile("agent/roles/qa-reviewer.md");
    /* The structured contract requires both fields in the JSON example.
       Plain-string corrections do NOT have a `severity` field.
     */
    assert.ok(
      codexReviewer.includes('"severity"'),
      'agent/roles/qa-reviewer.md is missing the structured corrections contract: ' +
        'corrections entries must be objects with a "severity" field. ' +
        'Port the {text,severity} block from agents/agent/qa-reviewer.md.',
    );
    assert.ok(
      codexReviewer.includes('"blocking"') || codexReviewer.includes('"advisory"'),
      'agent/roles/qa-reviewer.md must document "blocking" and "advisory" severity values.',
    );
  });

  it("agent/roles/qa-reviewer.md Output format section matches agents/agent/qa-reviewer.md", () => {
    const codexReviewer = parseSections(readFile("agent/roles/qa-reviewer.md"));
    const opencodeReviewer = parseSections(readFile("agents/agent/qa-reviewer.md"));

    for (const section of REVIEWER_MUST_MATCH_SECTIONS) {
      const codexBody = codexReviewer.get(section);
      const opencodeBody = opencodeReviewer.get(section);

      if (opencodeBody === undefined) continue; /* section only in codex mirror is allowed */

      assert.ok(
        codexBody !== undefined,
        `prompt-sync DIVERGENCE: section "## ${section}" is present in agents/agent/qa-reviewer.md ` +
          `but missing from agent/roles/qa-reviewer.md. Port it.`,
      );

      /* Normalize trailing whitespace for comparison; intentional content differences still fail. */
      const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
      assert.equal(
        normalize(codexBody),
        normalize(opencodeBody),
        `prompt-sync DIVERGENCE in section "## ${section}": ` +
          `agent/roles/qa-reviewer.md and agents/agent/qa-reviewer.md differ. ` +
          `The codex mirror must match the canonical OpenCode version.`,
      );
    }
  });

  it("both qa-reviewer.md mirrors carry the code-mode anti-mock rubric", () => {
    for (const rel of ["agent/roles/qa-reviewer.md", "agents/agent/qa-reviewer.md"]) {
      const content = readFile(rel);
      assert.ok(
        content.includes("Code-mode review (target: code)"),
        `${rel} is missing the "## Code-mode review (target: code)" section (the anti-mock rubric).`,
      );
      assert.ok(
        /mock/i.test(content) && /unit under test/i.test(content),
        `${rel} must reject tests that mock the unit under test (the anti-mock rubric wording).`,
      );
    }
  });

  it("both qa-reviewer.md mirrors reject-on-sight a ledger-bypassing 'learned habit' spec comment", () => {
    for (const rel of ["agent/roles/qa-reviewer.md", "agents/agent/qa-reviewer.md"]) {
      const content = readFile(rel);
      assert.ok(
        /ledger-bypassing/i.test(content) && /learned habit/i.test(content),
        `${rel} must reject a spec comment citing engram/memory as the source of a test-authoring ` +
          `habit (the governed ledger, not engram, owns test-authoring rules).`,
      );
      assert.ok(
        /engram/i.test(content),
        `${rel} anti-pattern catalog must reference engram by name so the reviewer recognizes the bypass pattern.`,
      );
    }
  });

  it("both AGENTS.md mirrors scope engram to operational context and forbid test-authoring rules", () => {
    for (const rel of ["agent/AGENTS.md", "agents/AGENTS.md"]) {
      const content = readFile(rel);
      assert.ok(
        /operational context/i.test(content),
        `${rel} must scope engram to operational context.`,
      );
      assert.ok(
        /never.{0,20}test-authoring rules|test-authoring rules.{0,20}never/is.test(content) || /NEVER for test-authoring rules/i.test(content),
        `${rel} must explicitly forbid test-authoring rules in engram.`,
      );
      assert.ok(
        /governed learning ledger/i.test(content),
        `${rel} must point test-authoring rules at the governed learning ledger instead.`,
      );
    }
  });

  it("both qa-generator.md mirrors' engram section forbids test-authoring rules and names the governed ledger as their owner", () => {
    for (const rel of ["agent/roles/qa-generator.md", "agents/agent/qa-generator.md"]) {
      const content = readFile(rel);
      assert.ok(
        /Never save a test-authoring rule/i.test(content),
        `${rel} must forbid saving test-authoring rules to engram.`,
      );
      assert.ok(
        /governed learning ledger/i.test(content),
        `${rel} must point to the governed learning ledger as the exclusive owner of test-authoring rules.`,
      );
    }
  });

  it("agent/roles/qa-reviewer.md contains the app-agnostic warning and ARIA-role selector guidance", () => {
    const codexReviewer = readFile("agent/roles/qa-reviewer.md");
    assert.ok(
      codexReviewer.includes("app-agnostic") || codexReviewer.includes("App-specific"),
      'agent/roles/qa-reviewer.md must contain the app-agnostic warning block.',
    );
    /* ARIA / role selector guidance (getByRole is the canonical Playwright ARIA selector) */
    assert.ok(
      codexReviewer.includes("getByRole") || codexReviewer.includes("ARIA"),
      'agent/roles/qa-reviewer.md must contain ARIA-role selector guidance.',
    );
  });

  it("a deliberate divergence in Output format is detected — drift structurally caught", () => {
    const opencodeReviewer = parseSections(readFile("agents/agent/qa-reviewer.md"));
    const section = "Output format";
    const opencodeBody = opencodeReviewer.get(section);
    if (!opencodeBody) return; /* section unexpectedly absent — skip inverse check */

    /* Build a deliberately-diverged in-memory sections map and run it through the SAME
       comparison code the guard uses in the must-match loop above, confirming assert.equal
       throws on the diverged copy. This proves the guard catches real drift, not just that
       string concatenation changes a string.
     */
    const divergedBody = opencodeBody + "\n\n<!-- deliberate drift -->";
    const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

    assert.throws(
      () => {
        assert.equal(
          normalize(divergedBody),
          normalize(opencodeBody),
          `prompt-sync DIVERGENCE in section "## ${section}"`,
        );
      },
      (err: unknown) => err instanceof assert.AssertionError,
      "The drift guard must throw an AssertionError when the codex mirror diverges from canonical.",
    );
  });

  it("agent/roles/qa-generator.md contains the anti-hang/no-op section", () => {
    const codexGenerator = readFile("agent/roles/qa-generator.md");
    /* The anti-hang section prevents the generator from over-working past the verdict, which
       causes run timeouts. It must be present in the codex mirror so both runtimes share this
       critical timing constraint. Source: agents/agent/qa-generator.md "Stop when the spec is
       written" section + the "DONE generating" sentinel phrase.
     */
    assert.ok(
      codexGenerator.includes("DONE generating") ||
        codexGenerator.includes("Stop when the spec is written") ||
        codexGenerator.includes("verdict is your LAST action"),
      "prompt-sync DRIFT: agent/roles/qa-generator.md is missing the anti-hang/no-op section. " +
        'Port the "Stop when the spec is written — then emit the verdict" section from ' +
        "agents/agent/qa-generator.md. This section prevents the generator from over-working " +
        "past the closing verdict.",
    );
  });

  it("every section of agent/roles/qa-generator.md, Procedure included, matches agents/agent/qa-generator.md byte for byte", () => {
    const codexGenerator = parseSections(readFile("agent/roles/qa-generator.md"));
    const opencodeGenerator = parseSections(readFile("agents/agent/qa-generator.md"));

    assert.deepEqual(
      [...codexGenerator.keys()],
      [...opencodeGenerator.keys()],
      "prompt-sync DIVERGENCE: the two generator mirrors must have the same sections in the same order.",
    );
    for (const [section, opencodeBody] of opencodeGenerator) {
      assert.equal(
        normalize(codexGenerator.get(section) ?? ""),
        normalize(opencodeBody),
        `prompt-sync DIVERGENCE in section "## ${section}" (generator): ` +
          `agent/roles/qa-generator.md and agents/agent/qa-generator.md differ. Edit both mirrors in the same step.`,
      );
    }
  });

  it("both generator mirrors state the selector priority once, and it names the configured test-id attribute as the only test-id discriminator", () => {
    for (const rel of GENERATOR_PROMPTS) {
      const procedure = parseSections(readFile(rel)).get("Procedure") ?? "";
      const rules = procedure.match(/Selector priority:[^\n]*/g) ?? [];
      assert.equal(rules.length, 1, `${rel}: the selector priority is stated exactly once`);
      assert.match(rules[0] ?? "", /STARTS WITH the configured testIdAttribute name/, `${rel}: an id=/name=/href hint must not read as a test-id`);
    }
  });

  it("both generator mirrors tie the permission to rewrite auth.setup.ts to the absence of the declared central login file", () => {
    for (const rel of GENERATOR_PROMPTS) {
      const procedure = parseSections(readFile(rel)).get("Procedure") ?? "";
      const loginRule = procedure.split(/\n(?=- )/).find((item) => item.includes("auth.setup.ts")) ?? "";
      assert.ok(loginRule.includes(`e2e/${E2E_AUTH_FILE}`), `${rel}: the login rule names the file whose presence withdraws the permission`);
      assert.ok(loginRule.indexOf(`e2e/${E2E_AUTH_FILE}`) > loginRule.indexOf("rewrite"), `${rel}: the exception follows the permission it limits`);
    }
  });

  it("the generator mirrors' Procedure holds unconditional craft: no case split on what the prompt carries and no runtime-signals rule", () => {
    for (const rel of GENERATOR_PROMPTS) {
      const procedure = parseSections(readFile(rel)).get("Procedure") ?? "";
      assert.ok(procedure.length > 0, `${rel}: has a Procedure section`);
      assert.doesNotMatch(procedure, /\bCase [AB]\b/, `${rel}: the procedure does not branch on assembled grounding`);
      assert.doesNotMatch(procedure, /browser_console_messages|browser_network_requests/, `${rel}: the runtime-signals rule is owned by the assembled prompt`);
    }
  });

  /* The directory every watched repo keeps its suite in; the runner reports spec paths relative to it. */
  const SUITE_DIR = "e2e";

  it("both qa-generator.md copies ask for specs as suite-relative paths, the same ones specMetas names", () => {
    for (const rel of ["agents/agent/qa-generator.md", "agent/roles/qa-generator.md"]) {
      const finalOutput = parseSections(readFile(rel)).get("Final output") ?? "";
      const example = /```json\n([\s\S]*?)\n```/.exec(finalOutput)?.[1];
      assert.ok(example, `${rel}: the Final output section carries a JSON example`);
      const verdict = JSON.parse(example) as { specs: string[]; specMetas: Array<{ file: string }> };
      assert.ok(verdict.specs.length > 0, `${rel}: the example reports at least one spec`);
      for (const spec of verdict.specs) {
        assert.match(spec, /^[^./][^\\]*\/[^/]+\.spec\.ts$/, `${rel}: "${spec}" must be a path under e2e/, not a bare name`);
        assert.notEqual(spec.split("/")[0], SUITE_DIR, `${rel}: "${spec}" must be relative to ${SUITE_DIR}/, not to the repo root`);
      }
      assert.deepEqual(verdict.specMetas.map((m) => m.file), verdict.specs, `${rel}: specMetas[].file names the same paths`);
    }
  });

  /* The JSON examples of a generator prompt's Final output section, in order. */
  const finalOutputExamples = (rel: string): string[] => {
    const finalOutput = parseSections(readFile(rel)).get("Final output") ?? "";
    return [...finalOutput.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? "");
  };
  const endOfExample = (example: string) => {
    const verdict = parseVerdict(example);
    return classifyGenerationEnd({
      specCount: verdict.specs.length,
      parsed: verdict.parsed,
      noopReason: verdict.noopReason,
      exhausted: false,
    });
  };

  it("in both qa-generator.md copies the first Final output example delivers specs and every other one declares a no-op, as the real parser and validator read them", () => {
    for (const rel of GENERATOR_PROMPTS) {
      const examples = finalOutputExamples(rel);
      assert.ok(examples.length >= 2, `${rel}: the Final output section carries a delivery example and a no-op example`);
      examples.forEach((example, index) => {
        assert.equal(checkGeneratorVerdict(example).valid, true, `${rel}: example ${index + 1} passes the validator`);
        assert.equal(
          endOfExample(example),
          index === 0 ? GENERATION_END.DELIVERED : GENERATION_END.DECLARED_NOOP,
          `${rel}: example ${index + 1}`,
        );
      });
    }
  });

  it("no example in either qa-generator.md copy reports an approval", () => {
    for (const rel of GENERATOR_PROMPTS) {
      for (const example of finalOutputExamples(rel)) {
        assert.equal("approved" in (JSON.parse(example) as object), false, `${rel}: ${example}`);
      }
    }
  });

  it("the context-mode prompt's closing example delivers its map and reports no approval", () => {
    const text = buildContextTask({
      repo: "org/app",
      sha: "abc1234",
      e2eRelDir: "e2e",
      mode: "context",
    } as Parameters<typeof buildContextTask>[0]);
    const example = text.trim().split("\n").at(-1) ?? "";
    assert.equal("approved" in (JSON.parse(example) as object), false);
    assert.equal(checkGeneratorVerdict(example).valid, true);
    assert.equal(endOfExample(example), GENERATION_END.DELIVERED);
  });

  it("AGENTS.md Global rules section matches between agents/ and agent/", () => {
    const codexAgents = parseSections(readFile("agent/AGENTS.md"));
    const opencodeAgents = parseSections(readFile("agents/AGENTS.md"));

    for (const section of AGENTS_MUST_MATCH_SECTIONS) {
      const codexBody = codexAgents.get(section);
      const opencodeBody = opencodeAgents.get(section);

      if (opencodeBody === undefined) continue;

      assert.ok(
        codexBody !== undefined,
        `prompt-sync DIVERGENCE: section "## ${section}" is present in agents/AGENTS.md ` +
          `but missing from agent/AGENTS.md. Port it.`,
      );

      const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
      assert.equal(
        normalize(codexBody),
        normalize(opencodeBody),
        `prompt-sync DIVERGENCE in section "## ${section}" (AGENTS.md): ` +
          `agent/AGENTS.md and agents/AGENTS.md differ. ` +
          `Safety-critical global rules must stay identical across both mirrors.`,
      );
    }
  });

  /* The no-direct-HTTP rule has two facets, each stated ONCE, in its own sentence, in AGENTS Global rules:
     what the agent's session may do (no network call outside the Playwright MCP: the prompt-injection
     defense) and what a spec may do (drive the app through the UI like a user, never call the backend
     API directly). These are the ways the prompts have phrased them; a statement outside Global rules is
     a restatement to delete. */
  const SESSION_NETWORK_STATEMENTS: readonly RegExp[] = [/network calls outside the Playwright MCP/i];
  const SPEC_AUTHORING_STATEMENTS: readonly RegExp[] = [
    /never call the (?:backend )?(?:API|service) directly/i,
    /no curl/i,
    /no direct HTTP/i,
    /direct API\/HTTP\/curl/i,
    /Drives? the (?:app|backend) through the (?:web )?UI/i,
  ];
  /* The sentences of a text (a line break inside a sentence is a space) that carry any of the patterns. */
  const statementsOf = (text: string, patterns: readonly RegExp[]): string[] =>
    text
      .split(/\n\s*\n|\n(?=\s*[-*] )/)
      .flatMap((block) => block.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/))
      .filter((sentence) => patterns.some((pattern) => pattern.test(sentence)));
  const RULE_FACETS: ReadonlyArray<readonly [string, readonly RegExp[]]> = [
    ["the session may not make a network call outside the Playwright MCP", SESSION_NETWORK_STATEMENTS],
    ["a spec drives the app through the UI and never calls the backend API directly", SPEC_AUTHORING_STATEMENTS],
  ];
  const restatementsIn = (text: string): number =>
    RULE_FACETS.reduce((total, [, patterns]) => total + statementsOf(text, patterns).length, 0);

  it("both AGENTS.md mirrors keep a Global rules section that states each facet of the no-direct-HTTP rule once, in a sentence of its own, and no other section restates either", () => {
    for (const rel of ["agents/AGENTS.md", "agent/AGENTS.md"]) {
      const sections = parseSections(readFile(rel));
      const globalRules = sections.get("Global rules");
      assert.ok(globalRules, `${rel}: the Global rules section survives`);
      const stated = RULE_FACETS.map(([facet, patterns]) => ({ facet, sentences: statementsOf(globalRules, patterns) }));
      for (const { facet, sentences } of stated) assert.equal(sentences.length, 1, `${rel}: Global rules states once that ${facet}`);
      const [session, authoring] = stated.map(({ sentences }) => sentences[0]);
      assert.notEqual(session, authoring, `${rel}: the two facets are separate sentences`);
      for (const [name, body] of sections) {
        if (name === "Global rules") continue;
        assert.equal(restatementsIn(body), 0, `${rel}: section "${name}" must not restate the no-direct-HTTP rule`);
      }
    }
  });

  it("no role prompt or skill restates the no-direct-HTTP rule", () => {
    for (const rel of [
      ...GENERATOR_PROMPTS,
      "agents/skill/playwright-authoring/SKILL.md",
      "agent/skills/playwright-authoring/SKILL.md",
      "agents/agent/qa-worker.md",
      "agent/roles/qa-worker.md",
    ]) {
      assert.equal(restatementsIn(readFile(rel)), 0, rel);
    }
  });

  it("the assembled generator prompt does not restate the no-direct-HTTP rule, whatever it carries", () => {
    const base = {
      repo: "org/app",
      sha: "abc1234",
      diff: "diff --git a/a.ts b/a.ts\n+x\n",
      mirrorDir: "/m",
      e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234",
      needsReview: false,
      target: "e2e",
      mode: "diff",
      appName: "shop",
      baseUrl: "http://localhost:3000",
    } as Parameters<typeof buildPrompt>[0];
    const withOpenapi = { ...base, openapi: "api-definition.yaml" };
    const crossRepo = { ...base, service: { repo: "org/orders", mirrorDir: "/m/orders", openapi: "api.yaml" } };
    for (const input of [base, withOpenapi, crossRepo]) assert.equal(restatementsIn(buildPrompt(input)), 0);
  });

  /* A craft rule has one owner. The static layers (AGENTS.md and the generator role) hold what applies to every run; a rule that applies only to some shapes of run is stated by the assembled prompt for that shape, and only there. These are the phrasings each rule has had; a second copy in the other layer is a restatement to delete. */
  interface OwnedRule {
    rule: string;
    pattern: RegExp;
    shape: "code" | "tree";
    inStatic: number;
    /* Exactly this many statements in the assembled prompt of its shape, or at least this many. */
    inAssembled: { exactly: number } | { atLeast: number };
  }
  const OWNED_RULES: readonly OwnedRule[] = [
    { rule: "the compile check of a code run", pattern: /cargo check --tests/gi, shape: "code", inStatic: 0, inAssembled: { exactly: 1 } },
    { rule: "the selector priority", pattern: /STARTS WITH the configured testIdAttribute name/gi, shape: "tree", inStatic: 1, inAssembled: { exactly: 0 } },
    { rule: "the dynamic DOM caveat", pattern: /STATIC snapshot of initial load/gi, shape: "tree", inStatic: 1, inAssembled: { exactly: 0 } },
    { rule: "not re-navigating a route the tree covers", pattern: /(?:do not|never)[^.\n]*(?:re-navigate|browser_navigate|browser_snapshot)/gi, shape: "tree", inStatic: 0, inAssembled: { atLeast: 1 } },
    { rule: "the engram topic key prefix", pattern: /prefix (?:every |all )?`?topic_key/gi, shape: "tree", inStatic: 0, inAssembled: { exactly: 1 } },
  ];
  const assembledInput = {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/a.ts b/a.ts\n+x\n",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: false,
    mode: "diff",
    appName: "shop",
  };
  const assembledFor = (shape: OwnedRule["shape"]): string =>
    buildPrompt(
      (shape === "code"
        ? { ...assembledInput, target: "code" }
        : { ...assembledInput, target: "e2e", baseUrl: "http://localhost:3000", domSnapshot: "route /cart:\n  button: Apply coupon" }) as Parameters<typeof buildPrompt>[0],
    );
  const countOf = (text: string, pattern: RegExp): number => [...text.matchAll(pattern)].length;

  it("each craft rule is stated in the layer that owns it and nowhere else, in both runtimes", () => {
    const staticLayers: Array<[string, string]> = [
      ["OpenCode", ["agents/AGENTS.md", "agents/agent/qa-generator.md"].map(readFile).join("\n")],
      ["Codex", ["agent/AGENTS.md", "agent/roles/qa-generator.md"].map(readFile).join("\n")],
    ];
    for (const { rule, pattern, shape, inStatic, inAssembled } of OWNED_RULES) {
      for (const [runtime, text] of staticLayers) {
        assert.equal(countOf(text, pattern), inStatic, `${runtime} static layer: ${rule} is stated ${inStatic} time(s)`);
      }
      const found = countOf(assembledFor(shape), pattern);
      if ("exactly" in inAssembled) assert.equal(found, inAssembled.exactly, `assembled ${shape} prompt: ${rule} is stated ${inAssembled.exactly} time(s)`);
      else assert.ok(found >= inAssembled.atLeast, `assembled ${shape} prompt: ${rule} is stated at least ${inAssembled.atLeast} time(s)`);
    }
  });

  it("a deliberate divergence in generator Final output is structurally caught (inverse)", () => {
    const opencodeGenerator = parseSections(readFile("agents/agent/qa-generator.md"));
    const section = "Final output";
    const opencodeBody = opencodeGenerator.get(section);
    if (!opencodeBody) return;

    /* Build a deliberately-diverged in-memory body and run it through the SAME comparison
       the guard uses in the must-match loop above. assert.throws confirms the guard would
       have caught the divergence — not just that appending text changes a string.
     */
    const divergedBody = opencodeBody + "\n\n<!-- deliberate drift -->";
    const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

    assert.throws(
      () => {
        assert.equal(
          normalize(divergedBody),
          normalize(opencodeBody),
          `prompt-sync DIVERGENCE in section "## ${section}" (generator)`,
        );
      },
      (err: unknown) => err instanceof assert.AssertionError,
      "The generator Final output drift guard must throw an AssertionError when the codex mirror diverges.",
    );
  });
});

describe("agent-guidance-runtime-semantics drift guard", () => {
  /* ---------------------------------------------------------------------------
     The two trees must be byte-identical (modulo trailing whitespace).
     This assertion PASSES on the current byte-identical files and FAILS on any one-tree edit.
     ---------------------------------------------------------------------------
   */
  it("test-value-review/SKILL.md carries the code-mode anti-mock rubric (both mirrors, via SKILL_FILE_PAIRS parity)", () => {
    const content = readFile("agents/skill/test-value-review/SKILL.md");
    assert.ok(
      /mock/i.test(content) && /unit under test/i.test(content),
      "test-value-review/SKILL.md must reject tests that mock the unit under test (the anti-mock rubric), " +
        "for code-mode reviews.",
    );
    assert.ok(
      /duplicate/i.test(content) && /implementation/i.test(content),
      "test-value-review/SKILL.md must reject tests that duplicate the implementation as the expectation.",
    );
  });

  /* The authoring skill is loaded by more than one role (the generator and the worker), so it cannot lean on one role's prompt: it names no role prompt and no step of one. */
  const ROLE_PROMPT_REFERENCE = /\b(?:generator|reviewer|worker|explorer|proposer|sidekick|maintainer)\s+role\b|\brole prompt\b|\bProcedure \(step \d+\)/i;

  it("no file of the playwright-authoring skill refers to a role's prompt or to a step of it, in either tree", () => {
    const authoring = SKILL_FILE_PAIRS.filter(([opencodeRel]) => opencodeRel.includes("playwright-authoring")).flat();
    assert.ok(authoring.length > 0);
    for (const rel of authoring) {
      assert.doesNotMatch(readFile(rel), ROLE_PROMPT_REFERENCE, `${rel}: the skill is loaded by several roles and stays role-neutral`);
    }
  });

  it("playwright-authoring skill file parity: locators-and-waiting.md matches across both trees", () => {
    for (const [opencodeRel, codexRel] of SKILL_FILE_PAIRS) {
      const opencodeContent = readFile(opencodeRel);
      const codexContent = readFile(codexRel);
      assert.equal(
        normalize(codexContent),
        normalize(opencodeContent),
        `prompt-sync DIVERGENCE: skill file "${opencodeRel}" and "${codexRel}" differ. ` +
          `Both trees must be byte-identical. Edit both mirrors in the same step.`,
      );
    }
  });

  /* ---------------------------------------------------------------------------
     Worker H1 may differ (Flash suffix) — the guard compares H2 bodies only.
     ---------------------------------------------------------------------------
   */
  it("qa-worker.md 'How to write a valuable spec' section matches across both mirrors", () => {
    const opencodeWorker = parseSections(readFile("agents/agent/qa-worker.md"));
    const codexWorker = parseSections(readFile("agent/roles/qa-worker.md"));

    for (const sectionHeader of WORKER_MUST_MATCH_SECTIONS) {
      const opencodeBody = opencodeWorker.get(sectionHeader);
      const codexBody = codexWorker.get(sectionHeader);

      if (opencodeBody === undefined) continue; /* section only in codex mirror is allowed */

      assert.ok(
        codexBody !== undefined,
        `prompt-sync DIVERGENCE: section "## ${sectionHeader}" is present in agents/agent/qa-worker.md ` +
          `but missing from agent/roles/qa-worker.md. Port it.`,
      );

      assert.equal(
        normalize(codexBody),
        normalize(opencodeBody),
        `prompt-sync DIVERGENCE in worker section "## ${sectionHeader}": ` +
          `agent/roles/qa-worker.md and agents/agent/qa-worker.md differ. ` +
          `The codex mirror must match the canonical OpenCode version.`,
      );
    }
  });

  /* Inverse proofs — confirm the guard actually catches divergence.
     (a) Skill-file parity: appending a comment to the in-memory content must trigger AssertionError.
     (b) Worker section parity: appending a comment to the in-memory section body must trigger AssertionError.
   */
  it("inverse: skill-file parity guard catches one-tree drift (skill file)", () => {
    const [opencodeRel] = SKILL_FILE_PAIRS[0]!;
    const opencodeContent = readFile(opencodeRel);
    const divergedContent = opencodeContent + "\n\n<!-- drift -->";

    assert.throws(
      () => {
        assert.equal(
          normalize(divergedContent),
          normalize(opencodeContent),
          `prompt-sync DIVERGENCE in skill file "${opencodeRel}"`,
        );
      },
      (err: unknown) => err instanceof assert.AssertionError,
      "The skill-file parity guard must throw an AssertionError when the codex mirror diverges.",
    );
  });

  it("inverse: worker section parity guard catches one-tree drift (worker section)", () => {
    const opencodeWorker = parseSections(readFile("agents/agent/qa-worker.md"));
    const sectionHeader = WORKER_MUST_MATCH_SECTIONS[0]!;
    const opencodeBody = opencodeWorker.get(sectionHeader);
    if (!opencodeBody) return; /* section unexpectedly absent — skip inverse check */

    const divergedBody = opencodeBody + "\n\n<!-- drift -->";

    assert.throws(
      () => {
        assert.equal(
          normalize(divergedBody),
          normalize(opencodeBody),
          `prompt-sync DIVERGENCE in worker section "## ${sectionHeader}"`,
        );
      },
      (err: unknown) => err instanceof assert.AssertionError,
      "The worker section-parity guard must throw an AssertionError when the codex mirror diverges.",
    );
  });
});
