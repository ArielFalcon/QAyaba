/* The entries of a dump a mutant's re-run wrote, put back on the served script's own bytes: the page ran the script with the mutant's edit in it, so its text and every offset after the edit are not the ones the source map, the decisions and the mutation sites describe. The edit is undone in the text and the offsets are moved back, so what the mutant made run lands on the lines and arms of the script the coverage saw. An entry of the mutant's URL whose text is neither the edited script nor the script itself cannot be placed and is left out. */
import { createHash } from "node:crypto";
import type { MutantEdit } from "../domain/coverage-collector.ts";
import type { V8Entry } from "./v8-source-map.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function undoMutant(entries: readonly V8Entry[], mutant: MutantEdit): V8Entry[] {
  const out: V8Entry[] = [];
  for (const entry of entries) {
    if (entry?.url !== mutant.url || typeof entry.source !== "string") {
      out.push(entry);
      continue;
    }
    const undone = undoIn(entry, mutant);
    if (undone) out.push(undone);
  }
  return out;
}

function undoIn(entry: V8Entry, { sha256: servedSha, edit, original }: MutantEdit): V8Entry | undefined {
  const source = entry.source!;
  const { start, end, replacement } = edit;
  const editedEnd = start + replacement.length;
  if (source.slice(start, editedEnd) !== replacement) return sha256(source) === servedSha ? entry : undefined;
  const served = source.slice(0, start) + original + source.slice(editedEnd);
  if (sha256(served) !== servedSha) return sha256(source) === servedSha ? entry : undefined;
  const shift = replacement.length - (end - start);
  /* An offset inside the edit stands for the whole of what it replaced: a range that starts in it starts at the edit, one that ends in it ends after it. */
  const fromStart = (offset: number): number => (offset >= editedEnd ? offset - shift : offset > start ? start : offset);
  const fromEnd = (offset: number): number => (offset >= editedEnd ? offset - shift : offset > start ? end : offset);
  const functions = entry.functions?.map((fn) => ({ ...fn, ranges: fn.ranges?.map((r) => ({ ...r, startOffset: fromStart(r.startOffset), endOffset: fromEnd(r.endOffset) })) }));
  return { ...entry, source: served, ...(functions ? { functions } : {}) };
}
