/* app scopes repo.listAll for the existing-rule set the dedup decision runs against. archetype comes from the use-case (never fabricated here; coalesced to null only when the use-case has none). */
import { engineLog } from "@kernel/ports/process-logger.ts";
import { lastJsonObjectWhere } from "@kernel/last-json-object.ts";
import type { LearningRepositoryPort } from "../application/ports/learning-repository.port.ts";
import type { LearningRule, ReflectionInput, StructuredReflection } from "../domain/learning-repository.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import { capRuleFields, correctionToErrorClass, decideDistill } from "../domain/distill-rule.ts";
/* Default sanitize mode is "issue" — the same as every sibling reviewer/selector-authored field. */
import { sanitizeText } from "../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const DEDUP_SCAN_LIMIT = 200;

function isStructuredReflection(o: Record<string, unknown>): boolean {
  const pr = o.preventiveRule as Record<string, unknown> | undefined;
  return (
    typeof o.goal === "string" &&
    typeof o.decision === "string" &&
    typeof o.assumption === "string" &&
    typeof o.errorClass === "string" &&
    typeof o.gateSignal === "string" &&
    typeof o.evidence === "string" &&
    typeof o.rootCause === "string" &&
    !!pr &&
    typeof pr === "object" &&
    typeof pr.trigger === "string" &&
    typeof pr.action === "string"
  );
}

/* Parse the qa-reflector's StructuredReflection out of its raw output. The role is told to emit "ONLY the JSON object, no markdown", but models do not always comply — they may wrap the object in a ```json fence or surround it with prose, which makes a raw JSON.parse throw. Routing through the shared last-object reader makes reflection parsing robust to fences/prose. Returns null when no complete reflection object is present (never throws). */
function parseStructuredReflection(raw: string): StructuredReflection | null {
  return (lastJsonObjectWhere(raw, isStructuredReflection) as StructuredReflection | undefined) ?? null;
}

/* Classes whose run never produced a suite to measure: the fact is the class itself, and the gate signals (a static gate that never ran reads "FAIL") would mislead the reflector. Deterministic — from the class alone. */
const FACTS_BY_CLASS: Readonly<Record<string, string>> = {
  "E-STEP-BUDGET":
    "step-budget exhaustion: the agent ran out of its step budget before it wrote any spec, so no suite exists to measure — there is no static gate, coverage or value signal to read",
};

function buildReflectionPrompt(input: ReflectionInput): string {
  const classFacts = FACTS_BY_CLASS[input.errorClass];
  const signals = classFacts
    ? [classFacts]
    : [
        `static gate: ${input.gateSignals.static ? "PASS" : "FAIL"}`,
        `coverage ratio: ${input.gateSignals.coverageRatio !== null ? (input.gateSignals.coverageRatio * 100).toFixed(0) + "%" : "unmeasured"}`,
        `value score: ${input.gateSignals.valueScore !== null ? (input.gateSignals.valueScore * 100).toFixed(0) + "%" : "unmeasured"}`,
        `flaky: ${input.gateSignals.flaky}`,
        `retries: ${input.gateSignals.retries}`,
      ];

  if (input.gateSignals.reviewerCorrections.length > 0) {
    signals.push(
      `reviewer corrections:\n${input.gateSignals.reviewerCorrections.map((c) => `  - ${sanitizeText(c).text}`).join("\n")}`,
    );
  }

  return [
    `Reflect on this QA run to produce a preventive rule.`,
    ``,
    `## Run context`,
    `- SHA: ${input.sha}`,
    `- Mode: ${input.mode}`,
    `- Verdict: ${input.verdict}`,
    `- Error class: ${input.errorClass}`,
    ``,
    `## Gate signals (the objective truth)`,
    ...signals,
    ``,
    `## Task`,
    `1. Identify the ROOT CAUSE of why this run failed or produced low-quality tests.`,
    `2. The errorClass "${input.errorClass}" is already determined by the gates — do NOT change it.`,
    `3. Write a preventiveRule that would have caught this BEFORE the run:`,
    `   - trigger: a CONDITION phrased as an "Applies when …" sentence describing the change that should fire this rule (e.g. "Applies when the diff adds a form with onSubmit but no test for invalid input"). Start with "Applies when ".`,
    `   - action: a CONCRETE instruction the agent should follow (e.g. "generate a test that submits the form with invalid data and asserts the error message")`,
    `4. The rule must be RECUPERABLE — specific enough to match future changes, general enough to apply across apps.`,
    `5. Anchor every field to the gate signals above — evidence must reference actual numbers/output.`,
    ``,
    `## Output — ONLY this JSON:`,
    `{"goal":"why the run happened","decision":"what the agent chose","assumption":"what the agent assumed that was wrong","errorClass":"${input.errorClass}","gateSignal":"the specific signal that flagged this","evidence":"the actual assert/lines/output","rootCause":"why the gate caught this","preventiveRule":{"trigger":"Applies when <condition>","action":"instruction"}}`,
  ].join("\n");
}

export const REFLECT_TIMEOUT_MS = 60_000;

export interface ReflectorPortDeps {
  runtime: AgentRuntimePort;
  repo: LearningRepositoryPort;
  backfill: (runId: string, refl: StructuredReflection) => void;
  cwd: string;
  app: string;
  timeoutMs?: number;
  onReflectError?: (e: unknown) => void;
  onSkipDuplicate?: (line: string) => void;
}

export class ReflectorPortAdapter {
  constructor(private readonly deps: ReflectorPortDeps) {}

  async reflect(input: ReflectionInput): Promise<void> {
    const { runtime, repo, backfill, cwd, app, timeoutMs, onReflectError } = this.deps;
    const reportError = onReflectError ?? ((e: unknown) => engineLog.error("[ReflectorPortAdapter] reflect failed (off-path, swallowed):", { error: e }));
    const reportSkip = this.deps.onSkipDuplicate ?? ((line: string) => engineLog.info(line));

    let session: Awaited<ReturnType<AgentRuntimePort["openSession"]>> | undefined;
    try {
      session = await runtime.openSession("reflector", cwd, {
        timeoutMs: timeoutMs ?? REFLECT_TIMEOUT_MS,
        descriptor: { runId: input.runId, role: "reflector" },
      });

      const { output } = await session.prompt(buildReflectionPrompt(input), { textOnly: true });
      const reflection = parseStructuredReflection(output);
      if (!reflection) return;

      const capped = capRuleFields({
        trigger: reflection.preventiveRule.trigger,
        action: reflection.preventiveRule.action,
      });

      const existing = await repo.listAll?.(app, DEDUP_SCAN_LIMIT) ?? [];
      const distilled = decideDistill(capped, existing);

      if (distilled.decision === "skip-duplicate") {
        reportSkip(
          `[ReflectorPortAdapter] skipped duplicate rule (key="${distilled.key}", matches existing id="${distilled.match.id}", status="${distilled.match.status}")`,
        );
        return;
      }

      /* The reviewerCorrections channel is deterministically derived (correctionToErrorClass); absent
         that, the gate-computed input.errorClass is the source of truth — never reflection.errorClass,
         which is only the LLM's own echo of it. The prompt says "do NOT change it", but a model is
         non-deterministic and a disobedient/mangled echo must never silently corrupt the ledger. */
      const derivedErrorClass = input.gateSignals.reviewerCorrections.length > 0
        ? correctionToErrorClass(input.gateSignals.reviewerCorrections[0]!)
        : input.errorClass;

      const rule: LearningRule = {
        id: `rule-${input.runId.slice(-8)}-${Math.random().toString(16).slice(2, 8)}`,
        trigger: capped.trigger,
        action: capped.action,
        errorClass: derivedErrorClass,
        archetype: input.archetype ?? null,
        status: "candidate",
        confidence: "low",
        usageCount: 0,
        outcomeCount: 0,
        oracleOutcomeCount: 0,
        successRate: null,
        lastVerified: null,
        source: input.runId,
        at: new Date().toISOString(),
      };

      await repo.save(rule);
      backfill(input.runId, reflection);
    } catch (e) {
      /* Off-path by contract: never gates publish, never affects the already-made verdict/ledger writes. Logged, not re-thrown — mirrors LearningPortAdapter.fold()'s documented convention on the sibling LearningRepositoryPort. */
      reportError(e);
    } finally {
      await session?.dispose();
    }
  }
}
