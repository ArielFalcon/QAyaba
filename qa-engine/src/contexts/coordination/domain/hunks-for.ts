/*
 * The hunks of a diff that overlap the lines of the symbols a change touched, bounded for a brief: the part of the change a flow
 * must exercise, without the rest of the diff. Pure.
 */
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { hunksOverlapping } from "@kernel/diff-hunks.ts";
import type { ChangedSymbol } from "@kernel/change-reach.ts";

/* The most hunks returned for one candidate, and the most lines kept of one. */
export const MAX_HUNKS = 3;
export const MAX_HUNK_LINES = 40;

const parser = new DiffParserService();

/* Each hunk as `file`, its header and its lines, cut at `MAX_HUNK_LINES` with the count left out; a hunk shared by several seeds appears once, in diff order. */
export function hunksFor(diff: string, seeds: readonly ChangedSymbol[]): string[] {
  if (diff === "" || seeds.length === 0) return [];
  return hunksOverlapping(parser.hunks(diff), seeds)
    .slice(0, MAX_HUNKS)
    .map((hunk) => {
      const kept = hunk.lines.slice(0, MAX_HUNK_LINES);
      const left = hunk.lines.length - kept.length;
      return [hunk.file, hunk.header, ...kept, ...(left > 0 ? [`... ${left} more line(s)`] : [])].join("\n");
    });
}
