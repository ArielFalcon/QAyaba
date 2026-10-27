/*
 * The sections that give a planned run's reviewer the change by flow under review, instead of the whole diff: each flow's slice,
 * every changed file, and in full what no flow under review holds. Nothing is cut: when the prompt does not fit the reviewer's
 * window, whole hunks become references (`path:start-end`) in a fixed order (degradationOrder) and the review is never split.
 * Never import src/.
 */
import { changeFileLine, type ChangeMapFile } from "@kernel/change-map.ts";
import { hunkLineCounts } from "@kernel/diff-hunks.ts";
import { decisionRankOf } from "@kernel/changed-decision.ts";
import type { DiffHunk } from "@kernel/diff-parser/diff-parser.service.ts";
import type { PromptSectionDef, SectionRender } from "./prompt-sections.ts";
import type { HunkReference } from "@kernel/change-slice.ts";
import type { ReviewChangeView } from "../../domain/review-change-view.ts";
import type { ReviewInput } from "../../domain/generation-input.ts";
import { redactedDiffText } from "./prompt-text.ts";
import { reviewsByFlow } from "./review-render.ts";

export const REVIEWER_FLOW_SLICES_SECTION_ID = "reviewer-flow-slices";
export const REVIEWER_CHANGED_FILES_SECTION_ID = "reviewer-changed-files";
export const REVIEWER_UNASSIGNED_CHANGE_SECTION_ID = "reviewer-unassigned-change";

/* What these sections render from: the review's input and the items shown as references because the prompt did not fit. */
export interface ReviewerChangeContext {
  readonly input: ReviewInput;
  readonly degraded: ReadonlySet<string>;
}

/* A part of the change the prompt may show whole or as a reference: a hunk a flow owns, an unassigned hunk, or a hunkless section. */
export interface ChangeItem {
  readonly key: string;
  /* What showing it whole costs over its reference, in bytes: an estimate the assembly then checks. */
  readonly savingBytes: number;
}

const flowKey = (flow: number, index: number): string => `f${flow}:${index}`;
const unassignedKey = (index: number): string => `u${index}`;
const hunklessKey = (position: number): string => `h${position}`;

const isCode = (kind: string): boolean => kind !== "other";
const DEGRADED_WHY = "over the reviewer's window";

function hunkReference(hunk: DiffHunk, kind: string, why: string): string {
  const { added, removed } = hunkLineCounts(hunk);
  return `- ${hunk.file}:${hunk.newStart}-${hunk.newEnd} (+${added} -${removed}, ${kind}, ${why})`;
}

function referenceLine(ref: HunkReference): string {
  return `- ${ref.path}:${ref.start}-${ref.end} (+${ref.added} -${ref.removed}, ${ref.kind}, ${ref.why})`;
}

/* Hunks as one fenced diff, a file header before each run of hunks of the same file, redacted by each file's kind. */
function diffBlock(hunks: readonly DiffHunk[]): string {
  const lines: string[] = [];
  let file: string | undefined;
  for (const hunk of hunks) {
    if (hunk.file !== file) {
      file = hunk.file;
      lines.push(`diff --git a/${file} b/${file}`);
    }
    lines.push(hunk.header, ...hunk.lines);
  }
  return ["```diff", redactedDiffText(lines.join("\n")), "```"].join("\n");
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/*
 * The order parts of the change become references when the prompt does not fit, first to last: non-code before code; among each,
 * the hunkless sections and unassigned hunks (those holding no changed decision before those holding one, each last in the diff
 * first) before what a flow owns; a flow's owned hunks from its lowest rank up (a slice ranks a hunk holding a changed decision
 * first), taken across the flows rank by rank.
 */
export function degradationOrder(view: ReviewChangeView): ChangeItem[] {
  const hunklessItems = view.hunkless.map((h, position) => ({ key: hunklessKey(position), code: false, savingBytes: bytes(h.section) }));
  const decisionRank = decisionRankOf(view.decisions ?? []);
  const lastInDiffFirst = [...view.unassigned].reverse();
  const unassigned = [...lastInDiffFirst.filter((u) => decisionRank(u.hunk) !== 0), ...lastInDiffFirst.filter((u) => decisionRank(u.hunk) === 0)].map((u) => ({
    key: unassignedKey(u.index),
    code: isCode(u.kind),
    savingBytes: bytes(diffBlock([u.hunk])) - bytes(hunkReference(u.hunk, u.kind, DEGRADED_WHY)),
  }));
  const deepest = Math.max(0, ...view.flows.map((flow) => flow.owned.length));
  const owned: Array<ChangeItem & { code: boolean }> = [];
  for (let rank = deepest - 1; rank >= 0; rank--) {
    view.flows.forEach((flow, f) => {
      const hunk = flow.owned[rank];
      if (hunk) owned.push({ key: flowKey(f, hunk.index), code: isCode(hunk.kind), savingBytes: bytes(diffBlock([hunk.hunk])) - bytes(hunkReference(hunk.hunk, hunk.kind, DEGRADED_WHY)) });
    });
  }
  const unowned = [...hunklessItems, ...unassigned];
  return [...unowned.filter((i) => !i.code), ...owned.filter((i) => !i.code), ...unowned.filter((i) => i.code), ...owned.filter((i) => i.code)].map(({ key, savingBytes }) => ({ key, savingBytes }));
}

/* The parts of `what` shown as references, introduced once per owner so that no two sections repeat the line. */
function notShown(what: string, lines: readonly string[]): string[] {
  return lines.length > 0 ? [`Not shown of ${what}; read each from the working copy:`, ...lines] : [];
}

function renderFlowSlices({ input, degraded }: ReviewerChangeContext): SectionRender {
  const view = input.changeView!;
  const flows = view.flows.map((flow, f) => {
    const shown = flow.owned.filter((o) => !degraded.has(flowKey(f, o.index)));
    const referenced = flow.owned.filter((o) => degraded.has(flowKey(f, o.index))).map((o) => hunkReference(o.hunk, o.kind, DEGRADED_WHY));
    return [
      `### Flow of ${flow.specFile} — use cases: ${flow.candidateIds.join(", ") || "(none)"}`,
      ...(shown.length > 0 ? [diffBlock(shown.map((o) => o.hunk))] : []),
      ...(flow.owned.length === 0 ? [`(its slice owns no hunk of the commit)`] : []),
      ...notShown(`the flow of ${flow.specFile}`, referenced),
    ].join("\n");
  });
  return {
    content: [`## The change by flow under review — the part of the commit each spec must exercise`, ...flows].join("\n\n"),
    language: "verbatim",
  };
}

function fileLine(file: ChangeMapFile): string {
  const notes = [file.kind, ...(file.isTest ? ["app test file"] : []), ...(file.fileClass === "generated" || file.fileClass === "low-relevance" ? [file.fileClass] : [])];
  return `${changeFileLine(file)} [${notes.join(", ")}]`;
}

function renderChangedFiles({ input }: ReviewerChangeContext): SectionRender {
  const view = input.changeView!;
  return {
    content: [`## Changed files — every file of the commit`, ...view.files.map(fileLine)].join("\n"),
    language: "verbatim",
  };
}

function renderUnassigned({ input, degraded }: ReviewerChangeContext): SectionRender {
  const view = input.changeView!;
  const sections = view.hunkless.filter((_, i) => !degraded.has(hunklessKey(i))).map((h) => ["```diff", redactedDiffText(h.section).trimEnd(), "```"].join("\n"));
  const hunks = view.unassigned.filter((u) => !degraded.has(unassignedKey(u.index)));
  const referenced = [
    ...view.hunkless.flatMap((h, i) => (degraded.has(hunklessKey(i)) ? [`- ${h.path} (whole file section, ${DEGRADED_WHY})`] : [])),
    ...view.unassigned.filter((u) => degraded.has(unassignedKey(u.index))).map((u) => hunkReference(u.hunk, u.kind, DEGRADED_WHY)),
  ];
  const empty = view.hunkless.length === 0 && view.unassigned.length === 0 && view.referenced.length === 0;
  return {
    content: [
      `## Change assigned to no flow under review — in full`,
      ...(empty ? [`(none: every hunk of the commit is in a flow's slice above)`] : []),
      ...sections,
      ...(hunks.length > 0 ? [diffBlock(hunks.map((u) => u.hunk))] : []),
      ...notShown("the unassigned change", referenced),
      ...(view.referenced.length > 0 ? [`Named only (app test files, generated and low-relevance files):`, ...view.referenced.map(referenceLine)] : []),
    ].join("\n"),
    language: "verbatim",
  };
}

/* After the objective, before the volatile evidence: the change is what every spec is judged against. */
export const REVIEWER_CHANGE_SECTIONS: readonly PromptSectionDef<ReviewerChangeContext>[] = [
  { id: REVIEWER_FLOW_SLICES_SECTION_ID, tier: "semi-stable", priority: 1.1, applies: ({ input }) => reviewsByFlow(input), render: renderFlowSlices },
  { id: REVIEWER_CHANGED_FILES_SECTION_ID, tier: "semi-stable", priority: 1.2, applies: ({ input }) => reviewsByFlow(input), render: renderChangedFiles },
  { id: REVIEWER_UNASSIGNED_CHANGE_SECTION_ID, tier: "semi-stable", priority: 1.3, applies: ({ input }) => reviewsByFlow(input), render: renderUnassigned },
];
