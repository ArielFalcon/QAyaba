/* Pure renderer of CodeGraphPort results into one advisory markdown block (GenerationEnrichment.staticSignal). Per-section MAX_ITEMS, whole-block MAX_LEN truncated at the last newline, every cell sanitized. Empty composition renders "" — never a fabricated "no blast radius found" claim. A block that names symbols is titled and introduced as the structural exploration it is; one that holds co-change files alone says it is version-control history and borrows nothing of the other's title, introduction or truncation marker. Caller degrades CodeGraphUnavailable to empty arrays. */

import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
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

/** Whether the block names code the change reaches (an impacted symbol or a caller). Files that historically co-change say which files tend to move together, which is no blast radius, so a block of those alone does not count. A symbol block is drawn exactly when its list is non-empty. */
export function hasSymbolBlocks(input: Pick<BlastRadiusSignalInput, "impacted" | "callers">): boolean {
  return input.impacted.length > 0 || input.callers.length > 0;
}

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

/* What a model reads first. A block that names symbols is the structural exploration of the change. */
const SYMBOLS_INTRO: readonly string[] = [
  "## Structural blast radius (deterministic — from the code graph, advisory)",
  "Derived from the indexed call graph at confidence >= 0.55. Advisory guidance, not a gate. Absent edges (e.g. Lombok accessors) do NOT imply no dependency.",
];

/* A block of co-change files alone shows what version control recorded and nothing about what depends on what. It is no exploration of what the change reaches, so it is not titled or worded as one: the prompt around it still sends the agent to look that up. */
const CO_CHANGE_INTRO: readonly string[] = [
  `## ${PROMPT_HEADINGS.coChangeFiles} (git history, advisory)`,
  "Version-control history: files that changed in the same commits as the changed files. It says nothing about which code depends on which, so it is not an exploration of what the change reaches.",
];

const SYMBOLS_TRUNCATION_MARKER = "\n…(structural blast radius truncated)";
const CO_CHANGE_TRUNCATION_MARKER = "\n…(co-change list truncated)";

/** Cuts a UTF-8 buffer to at most MAX_LEN bytes (including the truncation marker) at the last newline, so the output never ends in a dangling half-line. */
function truncateToByteBudget(out: string, marker: string): string {
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const buf = Buffer.from(out, "utf8");
  if (buf.length <= MAX_LEN) return out;
  let cut = MAX_LEN - markerBytes - 1;
  while (cut > 0 && buf[cut] !== 0x0a /* '\n' */) cut--;
  const body = buf.subarray(0, cut + 1).toString("utf8");
  return body + marker;
}

/** Advisory block, or "" when there is nothing to say: the "Structural blast radius" section when it names symbols, the co-change files under their own title when it holds nothing else. Pure — no IO, no throws. */
export function renderBlastRadiusSignal(input: BlastRadiusSignalInput): string {
  const has = input.impacted.length > 0 || input.callers.length > 0 || input.coupled.length > 0;
  if (!has) return "";

  const names = hasSymbolBlocks(input);
  const lines: string[] = [...(names ? SYMBOLS_INTRO : CO_CHANGE_INTRO), ""];
  lines.push(...renderSymbolBlock("Impacted symbols", input.impacted));
  lines.push(...renderSymbolBlock("Callers of the changed code", input.callers));
  lines.push(...renderCoupledBlock(input.coupled));

  const out = lines.join("\n");
  return truncateToByteBudget(out, names ? SYMBOLS_TRUNCATION_MARKER : CO_CHANGE_TRUNCATION_MARKER);
}
