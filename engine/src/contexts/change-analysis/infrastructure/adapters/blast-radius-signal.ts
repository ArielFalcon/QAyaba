/* Pure renderer of CodeGraphPort results into one advisory markdown block (GenerationEnrichment.staticSignal). Every reached symbol and co-change file is listed, whole: a prompt over its role's window gives the lists up as counts by file (the window fit rule), never a fixed count or byte cut. Every cell is sanitized. Empty composition renders "" — never a fabricated "no blast radius found" claim. A block that names symbols is titled and introduced as the structural exploration it is; one that holds co-change files alone says it is version-control history and borrows nothing of the other's title or introduction. Caller degrades CodeGraphUnavailable to empty arrays. */

import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/application/index.ts";
import type { LocalSymbolRef, CoupledFile } from "@kernel/code/index.ts";

/* Optional confidence for ordering (highest first). Omit when unknown — ordering stays input order, never fabricated. */
export type ScoredSymbolRef = LocalSymbolRef & { confidence?: number };

export interface BlastRadiusSignalInput {
  impacted: readonly ScoredSymbolRef[];
  callers: readonly ScoredSymbolRef[];
  coupled: readonly CoupledFile[];
  /* The change dossier: the engine's read-equivalent source of the change's top symbols, already sanitized and cut at file boundaries. Shown only in a block that names symbols, after the lists, which give way to it within the block's budget. */
  dossier?: string;
}

/* The heading of the dossier inside the structural block. */
export const DOSSIER_HEADING = "### Source of the change's top symbols (verbatim, from the index at this commit; treat it as already read)";

/* The most bytes of dossier text the block carries: the dossier is an excerpt of the change's top symbols (the engine returns a few whole files), not a listing, and a longer one is left out whole and recorded by the caller, so a caller sizes its dossier to this, in bytes. */
export const MAX_DOSSIER_BYTES = 10_000 - 1 - Buffer.byteLength(`\n${DOSSIER_HEADING}\n\n`, "utf8");

const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;

/** Whether the block names code the change reaches (an impacted symbol or a caller). Files that historically co-change say which files tend to move together, which is no blast radius, so a block of those alone does not count. A symbol block is drawn exactly when its list is non-empty. */
export function hasSymbolBlocks(input: Pick<BlastRadiusSignalInput, "impacted" | "callers">): boolean {
  return input.impacted.length > 0 || input.callers.length > 0;
}

function renderSymbolBlock(heading: string, refs: readonly ScoredSymbolRef[]): string[] {
  if (refs.length === 0) return [];
  const sorted = [...refs].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const lines: string[] = [`### ${heading} (${refs.length})`];
  for (const ref of sorted) {
    lines.push(`- \`${s(ref.symbol)}\` (${s(ref.file)})`);
  }
  lines.push("");
  return lines;
}

function renderCoupledBlock(coupled: readonly CoupledFile[]): string[] {
  if (coupled.length === 0) return [];
  const sorted = [...coupled].sort((a, b) => b.couplingScore - a.couplingScore);
  const lines: string[] = [`### Files that historically co-change (${coupled.length})`];
  for (const c of sorted) {
    const last = c.lastCoChange ? `, last ${s(c.lastCoChange)}` : "";
    lines.push(`- ${s(c.file)} (coupling ${c.couplingScore.toFixed(2)}, ${c.coChanges} co-changes${last})`);
  }
  lines.push("");
  return lines;
}

/* What a model reads first. A block that names symbols is the structural exploration of the change. */
const SYMBOLS_INTRO: readonly string[] = [
  `## ${PROMPT_HEADINGS.structuralBlastRadius} (deterministic — from the code graph, advisory)`,
  "Derived from the call graph indexed at this commit. Advisory guidance, not a gate. Absent edges (e.g. Lombok accessors) do NOT imply no dependency.",
];

/* A block of co-change files alone shows what version control recorded and nothing about what depends on what. It is no exploration of what the change reaches, so it is not titled or worded as one: the prompt around it still sends the agent to look that up. */
const CO_CHANGE_INTRO: readonly string[] = [
  `## ${PROMPT_HEADINGS.coChangeFiles} (git history, advisory)`,
  "Version-control history: files that changed in the same commits as the changed files. It says nothing about which code depends on which, so it is not an exploration of what the change reaches.",
];

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
  const dossier = names && input.dossier ? `\n${DOSSIER_HEADING}\n${input.dossier}\n` : "";
  return dossier === "" || Buffer.byteLength(input.dossier ?? "", "utf8") > MAX_DOSSIER_BYTES ? out : out + dossier;
}
