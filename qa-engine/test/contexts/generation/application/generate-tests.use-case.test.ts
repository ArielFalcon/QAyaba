import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { GenerationPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { ReviewInput } from "@contexts/generation/domain/generation-input.ts";
import type { SpecRoot } from "../../../../src/shared-infrastructure/spec-path-confinement.ts";
import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter.ts";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPromptAssembled,
  buildReviewerPromptAssembled,
  specFileForFlow,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { setAgentsConfigPath } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";
import { rosterFixturePath } from "../../../support/roster-fixture.ts";

/* The roster is an input here: window budgets resolve from the roster fixture, never the deployable agents/opencode.json. */
setAgentsConfigPath(rosterFixturePath());

/* Orchestration sequence through port stubs: render → open session → parse deliverable →
   reconcile manifest. A parse miss without review is fail-closed (empty specs, no phantom names).
 */

test("renders → opens session → parses deliverable → reconciles manifest (sequence)", async () => {
  const calls: string[] = [];
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => {
        calls.push("session");
        return {
          prompt: async () => ({ output: '{"specs":["flows/login.spec.ts"]}' }),
          dispose: () => {},
        };
      },
    },
    rendering: {
      render: () => "",
      renderMain: () => { calls.push("render"); return { text: "PROMPT", sectionSizes: {} }; },
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: (_text) => { calls.push("parse"); return { specs: ["flows/login.spec.ts"], parsed: true }; },
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => { calls.push("reconcile"); return [...e] as ManifestEntry[]; },
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
  };

  const useCase = new GenerateTestsUseCase(ports);
  const out = await useCase.author({
    repo: "org/demo",
    sha: "abc",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
  });

  /* render must come at some point before session fires the prompt */
  assert.ok(calls.includes("render"), "prompt was rendered");
  assert.ok(calls.includes("session"), "session was opened");
  assert.ok(calls.includes("parse"), "deliverable was parsed");
  assert.ok(calls.includes("reconcile"), "manifest was reconciled");
  assert.deepEqual(out.specs, ["flows/login.spec.ts"]);
});

test("the files the rendered prompt already carries are handed to the session with the prompt, and no key is added when it lists none", async () => {
  const seenOpts: Array<Record<string, unknown> | undefined> = [];
  const build = (providedPaths: readonly string[] | undefined): GenerationPorts => ({
    runtime: {
      openSession: async () => ({
        prompt: async (_text, opts) => {
          seenOpts.push(opts as Record<string, unknown> | undefined);
          return { output: '{"specs":["flows/login.spec.ts"]}' };
        },
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "PROMPT", sectionSizes: { task: 6 }, ...(providedPaths ? { providedPaths } : {}) }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: ["flows/login.spec.ts"], parsed: true }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
    budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
  });
  const input: OpencodeRunInput = {
    repo: "org/demo", sha: "abc", diff: "d", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns",
    target: "e2e", mode: "diff", appName: "a",
  };

  await new GenerateTestsUseCase(build(["e2e/.qa/context.json"])).author(input);
  await new GenerateTestsUseCase(build(undefined)).author(input);

  assert.deepEqual(seenOpts[0]?.providedPaths, ["e2e/.qa/context.json"]);
  assert.equal(seenOpts[0]?.sectionSizes !== undefined, true, "the section sizes still travel with it");
  assert.equal("providedPaths" in (seenOpts[1] ?? {}), false);
});

test("code target skips manifest reconciliation entirely and passes specMetas through raw", async () => {
  const calls: string[] = [];
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: '{"specs":["src/foo.test.ts"]}' }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "PROMPT", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({
        specs: ["src/foo.test.ts"],
        specMetas: [{ flow: "foo", file: "src/foo.test.ts", objective: "cover foo", targets: ["src/foo.ts"] }],
        parsed: true,
      }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => { calls.push("reconcile"); return [...e] as ManifestEntry[]; },
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
  };

  const out = await new GenerateTestsUseCase(ports).author({
    repo: "org/demo",
    sha: "abc",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "code",
    mode: "diff",
    appName: "a",
  });

  /* NOTE: the needsReview:false bail-early return deliberately carries no specMetas (pre-existing
     contract) — the load-bearing assertion here is that the e2e manifest is never touched for code.
   */
  assert.ok(!calls.includes("reconcile"), "code target must never touch the e2e manifest (no e2e/ dir exists for code apps)");
  assert.deepEqual(out.specs, ["src/foo.test.ts"]);
});

test("fires exactly ONE bounded repair when checkGenerator returns valid:false", async () => {
  const promptTexts: string[] = [];
  let sessionPromptCount = 0;

  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async (text: string) => {
          promptTexts.push(text);
          sessionPromptCount++;
          if (sessionPromptCount === 1) {
            return { output: '{"note":"oops — forgot specs"}' };
          }
          return { output: '{"specs":["flows/repair.spec.ts"]}' };
        },
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "MAIN_PROMPT", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: (text) => {
        if (text.includes('"specs"')) return { specs: ["flows/repair.spec.ts"], parsed: true };
        return { specs: [], parsed: true }; /* contract miss — no specs key, but JSON present */
      },
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => [...e] as ManifestEntry[],
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
    repair: {
      checkGenerator: (text) => {
        if (text.includes('"specs"')) return { valid: true, issues: [] };
        return { valid: false, issues: ["no closing verdict JSON found (expected a block with a `specs` array)"] };
      },
      instruction: (_kind, issues) => `REPAIR generator: ${issues.join(";")}`,
    },
  };

  let repairCount = 0;
  const useCase = new GenerateTestsUseCase(ports);
  const out = await useCase.author({
    repo: "r",
    sha: "s",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
  }, { onRepair: () => { repairCount++; } });

  assert.equal(sessionPromptCount, 2, "exactly two prompt calls: initial + one bounded repair");
  assert.equal(repairCount, 1, "onRepair notified exactly once");
  /* The repair prompt must reference the contract issues */
  const repairPrompt = promptTexts[1] ?? "";
  assert.match(repairPrompt, /REPAIR generator/, "repair prompt fired for the generator");
  assert.deepEqual(out.specs, ["flows/repair.spec.ts"], "repaired specs in result");
});

/* Fail-closed: parse miss without review.
 */
test("parse miss → empty specs (fail-closed, no phantom spec names)", async () => {
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: "no parseable verdict here" }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "P", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: [], parsed: false }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => [...e] as ManifestEntry[],
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
  };

  const useCase = new GenerateTestsUseCase(ports);
  const out = await useCase.author({
    repo: "r",
    sha: "s",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
  });
  assert.deepEqual(out.specs, [], "parse miss → empty specs");
});

/* manifest.reconcile is ALWAYS called, even with zero specMetas.
   Manifest entries are built EXCLUSIVELY from specMetas (opencode-client.ts), never from the bare
   specs[] list. A deliverable with specs but NO specMetas produces an EMPTY rawEntries array —
   reconcile still fires (so an empty entries array can prune/no-op per the port's own contract),
   but with nothing to upsert.
 */
test("manifest.reconcile is called with [] when the deliverable carries specs but no specMetas", async () => {
  let reconcileArgs: ManifestEntry[] | undefined;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: '{"specs":["flows/checkout.spec.ts"]}' }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "P", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: ["flows/checkout.spec.ts"], parsed: true }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => {
        reconcileArgs = [...e] as ManifestEntry[];
        return reconcileArgs;
      },
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
  };

  const useCase = new GenerateTestsUseCase(ports);
  const out = await useCase.author({
    repo: "r",
    sha: "s",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
  });
  /* reconcile must be called — if it was skipped, reconcileArgs would be undefined */
  assert.ok(reconcileArgs !== undefined, "reconcile was called");
  assert.deepEqual(reconcileArgs, [], "no specMetas -> no manifest entries synthesized from specs[] alone");
  assert.deepEqual(out.specs, ["flows/checkout.spec.ts"]);
});

/* The manifest's files are the names the agent reported, relative to the run's spec directory: they are resolved against the whole root, the mirror that anchors the confinement and the spec directory they are relative to, never against a bare directory. */
test("manifest.reconcile receives the run's spec root: the mirror, and the spec directory the reported files are relative to", async () => {
  const roots: SpecRoot[] = [];
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: '{"specs":["flows/checkout.spec.ts"]}' }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "P", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: ["flows/checkout.spec.ts"], parsed: true }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (root, entries) => {
        roots.push(root);
        return [...entries] as ManifestEntry[];
      },
    },
    budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
  };
  const useCase = new GenerateTestsUseCase(ports);

  for (const [mirrorDir, e2eRelDir] of [["/m", "e2e"], ["/work/app", "tests"]] as const) {
    await useCase.author({ repo: "r", sha: "s", diff: "d", mirrorDir, e2eRelDir, namespace: "ns", target: "e2e", mode: "diff", appName: "a" });
  }

  assert.deepEqual(roots, [
    { mirrorDir: "/m", specDir: "/m/e2e" },
    { mirrorDir: "/work/app", specDir: "/work/app/tests" },
  ]);
});

/* ── manifest-enrichment fix: entries are built from specMetas, stamped with changeRef ─────────
   Live-run root cause: the engine assembled rawEntries from deliverable.specs alone
   (objective:"", no targets/changeRef), which the real manifest schema (src/orchestrator/
   schemas.ts ManifestEntrySchema) always rejects — verdict=invalid on every real run that reached
   the static gate with a non-empty manifest. Entries
   come from specMetas (objective/flow/targets from the agent), changeRef stamped by the
   orchestrator from input.sha + input.intent?.type.
 */
test("manifest entries are built from specMetas with objective/flow/targets + changeRef stamped from input.sha/intent.type", async () => {
  let reconcileArgs: ManifestEntry[] | undefined;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({
          output: JSON.stringify({
            specs: ["flows/checkout.spec.ts"],
            specMetas: [{ file: "flows/checkout.spec.ts", flow: "checkout", objective: "user can checkout", targets: ["CheckoutService.pay"] }],
          }),
        }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "P", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({
        specs: ["flows/checkout.spec.ts"],
        parsed: true,
        specMetas: [{ file: "flows/checkout.spec.ts", flow: "checkout", objective: "user can checkout", targets: ["CheckoutService.pay"] }],
      }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => {
        reconcileArgs = [...e] as ManifestEntry[];
        return reconcileArgs;
      },
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
  };

  const useCase = new GenerateTestsUseCase(ports);
  await useCase.author({
    repo: "r",
    sha: "abc1234",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
    intent: { type: "feat", breaking: false, message: "add checkout", changedFiles: ["src/checkout.ts"] },
  });

  assert.equal(reconcileArgs?.length, 1);
  assert.deepEqual(reconcileArgs?.[0], {
    id: "checkout",
    file: "flows/checkout.spec.ts",
    flow: "checkout",
    objective: "user can checkout",
    targets: ["CheckoutService.pay"],
    changeRef: { sha: "abc1234", type: "feat" },
  });
});

test("manifest entry changeRef.type falls back to 'unknown' when input.intent is absent", async () => {
  let reconcileArgs: ManifestEntry[] | undefined;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: "irrelevant — parseGenerator stub below drives the deliverable" }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "P", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({
        specs: ["flows/login.spec.ts"],
        parsed: true,
        specMetas: [{ file: "flows/login.spec.ts", flow: "login", objective: "user can log in", targets: ["AuthService.login"] }],
      }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => {
        reconcileArgs = [...e] as ManifestEntry[];
        return reconcileArgs;
      },
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
  };

  const useCase = new GenerateTestsUseCase(ports);
  await useCase.author({
    repo: "r",
    sha: "def5678",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "manual",
    appName: "a",
  });

  assert.equal(reconcileArgs?.[0]?.changeRef?.type, "unknown");
  assert.equal(reconcileArgs?.[0]?.changeRef?.sha, "def5678");
});

/* missing-from-specMetas: the manifest-building loop is `verdict.specMetas.map(...)` — it iterates
   specMetas ONLY and never cross-references verdict.specs. A spec file the agent listed in specs[]
   but did NOT describe in specMetas[] gets NO manifest entry — silently, not an error (the spec
   file itself still executes; only its
   metadata entry is skipped). This test pins that a partial specMetas list (2 specs, 1 meta)
   yields exactly 1 manifest entry, not a synthesized default for the second.
 */
test("a spec present in specs[] but ABSENT from specMetas[] gets NO manifest entry", async () => {
  let reconcileArgs: ManifestEntry[] | undefined;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: "irrelevant — parseGenerator stub below drives the deliverable" }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "P", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({
        specs: ["flows/checkout.spec.ts", "flows/login.spec.ts"],
        parsed: true,
        specMetas: [{ file: "flows/checkout.spec.ts", flow: "checkout", objective: "user can checkout", targets: ["CheckoutService.pay"] }],
      }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => {
        reconcileArgs = [...e] as ManifestEntry[];
        return reconcileArgs;
      },
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
  };

  const useCase = new GenerateTestsUseCase(ports);
  const out = await useCase.author({
    repo: "r",
    sha: "sha1",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
  });

  /* Both specs are still reported in the deliverable's specs list (they were written to disk)... */
  assert.deepEqual(out.specs, ["flows/checkout.spec.ts", "flows/login.spec.ts"]);
  assert.equal(reconcileArgs?.length, 1);
  assert.equal(reconcileArgs?.[0]?.flow, "checkout");
});

/* The bounded repair loop threads the agent's own prior-turn output through
   RepairPort.instruction's opts, so a STATELESS repair re-prompt (e.g. a fresh process
   with no session resume) can recover its prior specifics instead of fabricating a new
   verdict. Pinned via a fake RepairPort that captures the opts it receives at each call site.
 */
test("follow-up #27: a malformed generator verdict triggers ONE bounded repair whose instruction carries priorResponseTail (the agent's own prior output)", async () => {
  const capturedOpts: Array<{ kind: string; issues: string[]; opts?: { priorResponseTail?: string } }> = [];
  let sessionPromptCount = 0;

  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => {
          sessionPromptCount++;
          if (sessionPromptCount === 1) {
            /* First call: malformed generator output (no specs field) — the prior turn's text. */
            return { output: '{"note":"oops — forgot specs"}' };
          }
          return { output: '{"specs":["flows/repair.spec.ts"]}' };
        },
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "MAIN_PROMPT", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: (text) => {
        if (text.includes('"specs"')) return { specs: ["flows/repair.spec.ts"], parsed: true };
        return { specs: [], parsed: true };
      },
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => [...e] as ManifestEntry[],
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
    repair: {
      checkGenerator: (text) => {
        if (text.includes('"specs"')) return { valid: true, issues: [] };
        return { valid: false, issues: ["no closing verdict JSON found"] };
      },
      instruction: (kind, issues, opts) => {
        capturedOpts.push({ kind, issues, opts });
        return `REPAIR ${kind}: ${issues.join(";")}`;
      },
    },
  };

  const useCase = new GenerateTestsUseCase(ports);
  await useCase.author({
    repo: "r",
    sha: "s",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
  });

  assert.equal(sessionPromptCount, 2, "exactly two prompt calls: initial + one bounded repair");
  assert.equal(capturedOpts.length, 1, "instruction() called exactly once (bounded repair)");
  assert.equal(capturedOpts[0]?.kind, "generator");
  assert.equal(
    capturedOpts[0]?.opts?.priorResponseTail,
    '{"note":"oops — forgot specs"}',
    "priorResponseTail carries the generator's own prior (malformed) turn output",
  );
});

/* ── manifest schema conformance: assembled entries satisfy the real static-gate schema ─────────
   Cross-checks the assembled entry shape against the ACTUAL ManifestEntrySchema the orchestrator's
   static gate validates (src/orchestrator/schemas.ts) — replicated here (qa-engine does not import
   from src/, per the src/-independence invariant) as the same field/type assertions the schema
   encodes: id/objective/flow non-empty strings, targets a non-empty array, changeRef.sha/type
   non-empty strings. This is the exact shape whose absence produced the live-run "invalid" verdict.
 */
test("assembled manifest entries satisfy the real ManifestEntrySchema shape (objective/flow/targets non-empty, changeRef required)", async () => {
  let reconcileArgs: ManifestEntry[] | undefined;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: "irrelevant" }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "P", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({
        specs: ["flows/checkout.spec.ts"],
        parsed: true,
        specMetas: [{ file: "flows/checkout.spec.ts", flow: "checkout", objective: "user can checkout", targets: ["CheckoutService.pay"] }],
      }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => {
        reconcileArgs = [...e] as ManifestEntry[];
        return reconcileArgs;
      },
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
  };

  const useCase = new GenerateTestsUseCase(ports);
  await useCase.author({
    repo: "r",
    sha: "shaXYZ",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
    intent: { type: "fix", breaking: false, message: "fix checkout bug", changedFiles: ["src/checkout.ts"] },
  });

  const entry = reconcileArgs?.[0];
  assert.ok(entry, "an entry was produced");
  /* Replicates ManifestEntrySchema's field checks (src/orchestrator/schemas.ts:137-148). */
  assert.ok(typeof entry?.id === "string" && entry.id.length > 0, "id: non-empty string");
  assert.ok(typeof entry?.objective === "string" && entry.objective.length > 0, "objective: non-empty string");
  assert.ok(typeof entry?.flow === "string" && entry.flow.length > 0, "flow: non-empty string");
  assert.ok(Array.isArray(entry?.targets) && entry.targets.length > 0, "targets: non-empty array");
  assert.ok(typeof entry?.changeRef === "object" && entry.changeRef !== null, "changeRef: present");
  assert.ok(typeof entry?.changeRef?.sha === "string" && entry.changeRef.sha.length > 0, "changeRef.sha: non-empty string");
  assert.ok(typeof entry?.changeRef?.type === "string" && entry.changeRef.type.length > 0, "changeRef.type: non-empty string");
});

/* The generator reports "login.spec.ts" for the spec it wrote at e2e/flows/login.spec.ts. */
async function reportedSpecsFor(target: "e2e" | "code"): Promise<string[]> {
  const mirrorDir = mkdtempSync(join(tmpdir(), "generate-suite-paths-"));
  try {
    mkdirSync(join(mirrorDir, "e2e", "flows"), { recursive: true });
    writeFileSync(join(mirrorDir, "e2e", "flows", "login.spec.ts"), "export {};\n");
    const ports: GenerationPorts = {
      runtime: { openSession: async () => ({ prompt: async () => ({ output: '{"specs":["login.spec.ts"]}' }), dispose: () => {} }) },
      rendering: {
        render: () => "",
        renderMain: () => ({ text: "PROMPT", sectionSizes: {} }),
        renderReviewer: () => ({ text: "", sectionSizes: {} }),
        specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
      },
      verdicts: new VerdictParserAdapter({
        parseVerdict: () => ({ parsed: true, approved: true, specs: ["login.spec.ts"] }),
        parseReviewerVerdict: () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true, valid: true, issues: [] }),
      }),
      manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
      budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
    };
    const out = await new GenerateTestsUseCase(ports).author({
      repo: "org/demo", sha: "abc", diff: "d", mirrorDir, e2eRelDir: "e2e", namespace: "ns",
      target, mode: "diff", appName: "a",
    });
    return out.specs;
  } finally {
    rmSync(mirrorDir, { recursive: true, force: true });
  }
}

test("an e2e generation reports its specs as suite-relative paths; a code generation keeps the names it was given", async () => {
  assert.deepEqual(await reportedSpecsFor("e2e"), ["flows/login.spec.ts"]);
  assert.deepEqual(await reportedSpecsFor("code"), ["login.spec.ts"]);
});

/* A prompt that states a step limit is sent with that limit as an option, so the turn it starts is classified against the number the prompt stated. The generator's prompt carries its own; a verdict repair says nothing of it but runs in the same session under the same limit, so it is sent with the number of the prompt it repairs. */
type SentOptions = Array<Record<string, unknown> | undefined>;

/* Whether the generator answers its first prompt with no verdict, so that it is asked once more. */
async function optionsSentFor(input: Partial<OpencodeRunInput>, repairing?: "generator"): Promise<{ generator: SentOptions }> {
  const sent: Record<string, SentOptions> = { primary: [] };
  const ports: GenerationPorts = {
    runtime: {
      openSession: async (role) => ({
        prompt: async (_text, opts) => {
          (sent[role] ??= []).push(opts as Record<string, unknown> | undefined);
          return { output: "SESSION_OUTPUT" };
        },
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "GEN_PROMPT", sectionSizes: { task: 10 } }),
      renderReviewer: () => ({ text: "REV_PROMPT", sectionSizes: { "reviewer-specs": 10 } }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: ["flows/a.spec.ts"], parsed: true }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [], parsed: true }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
    budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
    ...(repairing
      ? {
          repair: {
            checkGenerator: () => ({ valid: repairing !== "generator", issues: ["no verdict"] }),
            instruction: () => "REPAIR_PROMPT",
          },
        }
      : {}),
  };
  await new GenerateTestsUseCase(ports).author({
    repo: "r", sha: "s", diff: "d", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns",
    target: "e2e", mode: "diff", appName: "a",
    ...input,
  });
  return { generator: sent["sidekick"] ?? [] };
}

test("the generator's prompt is sent with the limit its input states, beside the options it already carried", async () => {
  const { generator } = await optionsSentFor({ stepLimit: 41 });

  assert.equal(generator.length, 1);
  assert.equal(generator[0]?.stepLimit, 41);
  assert.equal(generator[0]?.finalStepOnly, true, "the options it carried are still there");
  assert.deepEqual(generator[0]?.sectionSizes, { task: 10 });
});

test("a generator prompt whose input states no limit is sent with no limit key", async () => {
  const { generator } = await optionsSentFor({});

  assert.equal(generator.length, 1);
  assert.equal("stepLimit" in (generator[0] ?? {}), false);
});

test("a verdict repair runs in the same session under the same limit, so it is sent with the limit of the prompt it repairs, beside the options it already carried", async () => {
  const { generator } = await optionsSentFor({ stepLimit: 41 }, "generator");

  assert.equal(generator.length, 2, "the prompt and its repair");
  assert.equal(generator[0]?.stepLimit, 41);
  assert.equal(generator[1]?.isRepair, true);
  assert.equal(generator[1]?.stepLimit, 41);
  assert.equal(generator[1]?.finalStepOnly, true, "the options it carried are still there");
});

test("a generator repair whose input states no limit is sent with no limit key either", async () => {
  const { generator } = await optionsSentFor({}, "generator");

  assert.equal(generator.length, 2, "the prompt and its repair");
  assert.equal(generator[1]?.isRepair, true);
  assert.equal("stepLimit" in (generator[1] ?? {}), false);
});

/* The independent review is the `review` sidekick kind the run's review step dispatches: a generation never opens a reviewer session, whatever the mode. */
for (const mode of ["diff", "context"] as const) {
  test(`a ${mode}-mode generation never opens a reviewer session`, async () => {
    const opened: string[] = [];
    const ports: GenerationPorts = {
      runtime: {
        openSession: async (role) => {
          opened.push(role);
          return { prompt: async () => ({ output: '{"specs":["flows/a.spec.ts"]}' }), dispose: () => {} };
        },
      },
      rendering: {
        render: () => "",
        renderMain: () => ({ text: "PROMPT", sectionSizes: {} }),
        renderReviewer: () => ({ text: "REVIEW_PROMPT", sectionSizes: {} }),
        specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
      },
      verdicts: {
        parseGenerator: () => ({ specs: ["flows/a.spec.ts"], parsed: true }),
        parseReview: () => ({ approved: false, corrections: [], valid: true, issues: [], parsed: true }),
      },
      manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
      budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
    };

    const result = await new GenerateTestsUseCase(ports).author({
      repo: "r", sha: "s", diff: "", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns",
      target: "e2e", mode, appName: "a",
    });

    assert.equal(opened.includes("reviewer"), false, "no reviewer session was opened");
    assert.deepEqual(result.specs, ["flows/a.spec.ts"]);
  });
}
