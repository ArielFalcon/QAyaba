

import type { SpecMeta } from "../types";
import { readNoopKind, type NoopKind } from "@kernel/noop-kind";
import { jsonObjectsIn, lastJsonObjectWhere } from "@kernel/last-json-object";

export interface FinalVerdict {
  approved: boolean;
  specs: string[];
  specMetas?: SpecMeta[];
  note?: string;
  /** The reason the generator gave for writing nothing (`noop.reason`); absent unless it declared a no-op with a reason. `approved` is never a no-op signal. */
  noopReason?: string;
  /** The reason it gave, as the contract names it (`noop.kind`): recorded as `unspecified` when the verdict names none. Present exactly when `noopReason` is. */
  noopKind?: NoopKind;
  /** The plan a lead emitted when its turn asked for one: the raw object, untrusted and read by the orchestrator's admission alone. Absent unless the verdict carried a `plan` object. */
  plan?: Record<string, unknown>;
  /** The questions a lead asked the explore sidekicks instead of planning: the raw array, untrusted and read by the orchestrator's admission alone. Absent unless the verdict carried an `explore` array. */
  explore?: unknown[];
  /** The generator's typed claim that the test is correct; a claim, never evidence. Absent unless it carried a valid cause and a non-blank reason. */
  testCorrect?: { cause: "env" | "app"; reason: string };
  /** The findings the generator disputes instead of correcting, each with the basis the orchestrator must check. Absent unless it carried at least one well-formed entry. */
  rebuttals?: { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[];
  /** false when no verdict JSON was found (fail-closed). Distinguishes parse miss from rejection. */
  parsed: boolean;
}

/*
 * Every top-level JSON object of free-form agent text, in document order; callers take the last
 * one matching their shape. The scanner is the kernel's (`@kernel/last-json-object`), the repo's
 * one reader of an agent's closing JSON: an unbalanced brace in narration never hides it.
 */
export function extractJsonObjects(text: string): unknown[] {
  return jsonObjectsIn(text);
}

/* Returns the LAST extracted JSON object for which `pred` holds, or undefined. */
export function lastJsonMatching<T = Record<string, unknown>>(text: string, pred: (o: Record<string, unknown>) => boolean): T | undefined {
  return lastJsonObjectWhere(text, pred) as T | undefined;
}

/* Discriminator: the generator's closing JSON carries a `specs` array, a `noop` decision, a `testCorrect` claim, `rebuttals`, a `plan`, an `explore` request or a boolean `approved`. */
export function isClosingVerdict(o: Record<string, unknown>): boolean {
  return Array.isArray(o.specs) || "noop" in o || "testCorrect" in o || "rebuttals" in o || "plan" in o || "explore" in o || typeof o.approved === "boolean";
}

/* A plan is an object; anything else under the key is no plan. */
function planOf(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

/* The trimmed reason of a `noop` decision; undefined for anything that is not an object with a non-blank text `reason`. */
function noopReasonOf(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const reason = (raw as Record<string, unknown>).reason;
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return trimmed === "" ? undefined : trimmed;
}

/* A typed test-correct claim only when it names one of the two causes and carries a non-blank reason; anything else is no claim (fail-closed). */
function testCorrectOf(raw: unknown): { cause: "env" | "app"; reason: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const cause = record.cause;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if ((cause !== "env" && cause !== "app") || reason === "") return undefined;
  return { cause, reason };
}

/* A rebuttal only when it names the finding, a basis the orchestrator can check, the reference it must check and a reason; anything else is no rebuttal (fail-closed, it can withdraw nothing). */
function rebuttalsOf(raw: unknown): { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rebuttals: { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const finding = typeof record.finding === "string" ? record.finding.trim() : "";
    const basis = record.basis;
    const ref = typeof record.ref === "string" ? record.ref.trim() : "";
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (finding === "" || ref === "" || reason === "" || (basis !== "execution" && basis !== "contract")) continue;
    rebuttals.push({ finding, basis, ref, reason });
  }
  return rebuttals.length > 0 ? rebuttals : undefined;
}
/* The decision of a `noop` block: its reason and the kind it names, both only when it gives a reason. */
function noopOf(raw: unknown): { noopReason?: string; noopKind?: NoopKind } {
  const reason = noopReasonOf(raw);
  return reason === undefined ? {} : { noopReason: reason, noopKind: readNoopKind((raw as Record<string, unknown>).kind) };
}

/*
 * Last balanced object with `specs`, `noop`, `testCorrect` or `approved`. A missing `approved` is
 * not a rejection (the reviewer is the gate); no parseable block — or one listing a spec that is
 * not a path string — is fail-closed with parsed:false. Whether writing no specs was a decision is
 * read from `noop.reason` or a valid `testCorrect`, never from `approved`.
 */
export function parseVerdict(text: string): FinalVerdict {
  const o = lastJsonMatching(text, isClosingVerdict);
  const specs: unknown[] = Array.isArray(o?.specs) ? o.specs : [];
  if (specs.some((spec) => typeof spec !== "string")) {
    return { approved: false, specs: [], note: "the agent's verdict lists a spec that is not a path string", parsed: false };
  }
  if (o) {
    const testCorrect = testCorrectOf(o.testCorrect);
    const rebuttals = rebuttalsOf(o.rebuttals);
    return {
      approved: typeof o.approved === "boolean" ? o.approved : true,
      specs: specs as string[],
      specMetas: parseSpecMetas(o.specMetas),
      note: typeof o.note === "string" ? o.note : undefined,
      ...noopOf(o.noop),
      ...(testCorrect ? { testCorrect } : {}),
      ...(rebuttals ? { rebuttals } : {}),
      ...(planOf(o.plan) ? { plan: planOf(o.plan) } : {}),
      ...(Array.isArray(o.explore) ? { explore: o.explore } : {}),
      parsed: true,
    };
  }
  return { approved: false, specs: [], note: "the agent emitted no parseable verdict", parsed: false };
}

function parseSpecMetas(raw: unknown): SpecMeta[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const metas: SpecMeta[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const file = typeof e.file === "string" ? e.file.trim() : "";
    const flow = typeof e.flow === "string" ? e.flow.trim() : "";
    const objective = typeof e.objective === "string" ? e.objective.trim() : "";
    const targets = Array.isArray(e.targets) ? e.targets.filter((t): t is string => typeof t === "string") : [];
    if (file && flow && objective) {
      metas.push({ file, flow, objective, targets });
    }
  }
  return metas.length > 0 ? metas : undefined;
}
