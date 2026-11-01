import type { SpecMeta } from "@kernel/qa-case.ts";
import { readNoopKind, type NoopKind } from "@kernel/noop-kind.ts";

export interface FinalVerdict {
  approved: boolean;
  specs: string[];
  specMetas?: SpecMeta[];
  note?: string;
  /** The reason the generator gave for writing nothing (`noop.reason`); absent unless it declared a no-op with a reason. `approved` is never a no-op signal. */
  noopReason?: string;
  /** The reason it gave, as the contract names it (`noop.kind`): recorded as `unspecified` when the verdict names none. Present exactly when `noopReason` is. */
  noopKind?: NoopKind;
  /** The generator's typed claim that the test is correct; a claim, never evidence. Absent unless it carried a valid cause and a non-blank reason. */
  testCorrect?: { cause: "env" | "app"; reason: string };
  /** The findings the generator disputes instead of correcting, each with the basis the orchestrator must check. Absent unless it carried at least one well-formed entry. */
  rebuttals?: { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[];
  /** false when no submission was accepted (fail-closed). Distinguishes a miss from a rejection. */
  parsed: boolean;
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

/* A rebuttal only when it names the finding (the number the correction turn showed it, read as text), a basis the orchestrator can check, the reference it must check and a reason; anything else is no rebuttal (fail-closed, it can withdraw nothing). */
function rebuttalsOf(raw: unknown): { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rebuttals: { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const finding = typeof record.finding === "string" ? record.finding.trim() : typeof record.finding === "number" && Number.isFinite(record.finding) ? String(record.finding) : "";
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

/* A turn that delivered no accepted submission: fail-closed, with the reason it records. Never a rejection and never a no-op. */
export function missingVerdict(note: string): FinalVerdict {
  return { approved: false, specs: [], note, parsed: false };
}

/*
 * The generator's accepted submission. A missing `approved` is not a rejection (the reviewer is the gate). Whether writing no
 * specs was a decision is read from `noop.reason` or a valid `testCorrect`, never from `approved`.
 */
export function readVerdict(o: Record<string, unknown>): FinalVerdict {
  const specs = Array.isArray(o.specs) ? (o.specs as string[]) : [];
  const testCorrect = testCorrectOf(o.testCorrect);
  const rebuttals = rebuttalsOf(o.rebuttals);
  return {
    approved: typeof o.approved === "boolean" ? o.approved : true,
    specs,
    specMetas: parseSpecMetas(o.specMetas),
    note: typeof o.note === "string" ? o.note : undefined,
    ...noopOf(o.noop),
    ...(testCorrect ? { testCorrect } : {}),
    ...(rebuttals ? { rebuttals } : {}),
    parsed: true,
  };
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
