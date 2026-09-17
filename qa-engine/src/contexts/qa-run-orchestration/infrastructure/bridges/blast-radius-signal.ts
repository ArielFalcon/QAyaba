/* Pure renderer of CodeGraphPort results into one advisory markdown block (GenerationEnrichment.staticSignal). Per-section MAX_ITEMS, whole-block MAX_LEN truncated at the last newline, every cell sanitized. Empty composition renders "" — never a fabricated "no blast radius found" claim. Caller degrades CodeGraphUnavailable to empty arrays. */

import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import type { LocalSymbolRef, CoupledFile } from "@kernel/code/index.ts";

const MAX_ITEMS = 200;
const MAX_LEN = 20_000;

/* Optional confidence for ordering (highest first). Omit when unknown — ordering stays input order, never fabricated. */
export type ScoredSymbolRef = LocalSymbolRef & { confidence?: number };

export interface BlastRadiusSignalInput {
  impacted: readonly ScoredSymbolRef[];
  callers: readonly ScoredSymbolRef[];
  coupled: readonly CoupledFile[];
}

const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;

function renderSymbolBlock(heading: string, refs: readonly ScoredSymbolRef[]): string[] {
  if (refs.length === 0) return [];
  const sorted = [...refs].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const lines: string[] = [`### ${heading} (${refs.length})`];
  for (const ref of sorted.slice(0, MAX_ITEMS)) {
    lines.push(`- \`${s(ref.symbol)}\` (${s(ref.file)})`);
  }
  lines.push("");
  return lines;
}

function renderCoupledBlock(coupled: readonly CoupledFile[]): string[] {
  if (coupled.length === 0) return [];
  const sorted = [...coupled].sort((a, b) => b.couplingScore - a.couplingScore);
  const lines: string[] = [`### Files that historically co-change (${coupled.length})`];
  for (const c of sorted.slice(0, MAX_ITEMS)) {
    const last = c.lastCoChange ? `, last ${s(c.lastCoChange)}` : "";
    lines.push(`- ${s(c.file)} (coupling ${c.couplingScore.toFixed(2)}, ${c.coChanges} co-changes${last})`);
  }
  lines.push("");
  return lines;
}

/** Cuts a UTF-8 buffer to at most MAX_LEN bytes (including the truncation marker) at the last newline, so the output never ends in a dangling half-line. */
function truncateToByteBudget(out: string): string {
  const marker = "\n…(structural blast radius truncated)";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const buf = Buffer.from(out, "utf8");
  if (buf.length <= MAX_LEN) return out;
  let cut = MAX_LEN - markerBytes - 1;
  while (cut > 0 && buf[cut] !== 0x0a /* '\n' */) cut--;
  const body = buf.subarray(0, cut + 1).toString("utf8");
  return body + marker;
}

/** Advisory "Structural blast radius" section, or "" when there is nothing to say. Pure — no IO, no throws. */
export function renderBlastRadiusSignal(input: BlastRadiusSignalInput): string {
  const has = input.impacted.length > 0 || input.callers.length > 0 || input.coupled.length > 0;
  if (!has) return "";

  const lines: string[] = [];
  lines.push("## Structural blast radius (deterministic — from the code graph, advisory)");
  lines.push(
    "Derived from the indexed call graph at confidence >= 0.55. This is generation GUIDANCE, not a gate — verify against the live code. Absent edges (e.g. Lombok accessors) do NOT imply no dependency.",
  );
  lines.push("");
  lines.push(...renderSymbolBlock("Impacted symbols", input.impacted));
  lines.push(...renderSymbolBlock("Callers of the changed code", input.callers));
  lines.push(...renderCoupledBlock(input.coupled));

  const out = lines.join("\n");
  return truncateToByteBudget(out);
}
