/*
 * The commit diff section (COMMIT_DIFF_HEADING) of the lead's planning turn: the change map (one line per changed file: path, added and removed
 * lines, kind, relevance class, whether it is an app test file, the use cases its changed code seeds), then the first `shown`
 * ranked pieces of the diff in one ```diff fence (the judges read the fence back), then every other piece named by its location,
 * size, kind and why. The map and the references are never cut; how many pieces are shown is fitted to the lead's window by the
 * builder, which reads the section's size for any count from `bytes` without rendering it. Every text is redacted before it is
 * measured. Never import src/.
 */
import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { changeFileLine } from "@kernel/change-map.ts";
import { WINDOW_FIT_REASON, type SectionDegradation } from "@kernel/prompt-sections.ts";
import { pieceLocation, planDiff, type PlanDiff, type PlanDiffPiece, type PlanReferenceWhy } from "../../domain/plan-diff.ts";
import { COMMIT_DIFF_HEADING, diffSectionMode, redactedDiffOf } from "./prompt-text.ts";

const WHY_TEXT: Readonly<Record<PlanReferenceWhy, string>> = {
  "test-file": "an app test file",
  generated: "a generated file",
  "low-relevance": "a file whose diff says little",
  window: "past what the lead's context window holds",
};

const MAP_INTRO = "Changed files, each once (path (+added -removed) | kind | relevance class | app test file | the use cases its changed code seeds):";
const REFERENCES_INTRO = "Parts of the diff not shown above; read each in the working copy (location (+added -removed, kind, why)):";
const FENCE_OPEN = "```diff";
const FENCE_CLOSE = "```";

const forPrompt = (text: string): string => sanitizeText(text, "issue").text;
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

function referenceLine(piece: PlanDiffPiece, why: PlanReferenceWhy): string {
  return `- ${forPrompt(pieceLocation(piece))} (+${piece.added} -${piece.removed}, ${piece.kind}, ${WHY_TEXT[why]})`;
}

export class PlanDiffSection {
  private readonly fixed: string[];
  private readonly blocks: string[];
  private readonly windowReferences: string[];
  private readonly otherReferences: string[];

  constructor(plan: PlanDiff) {
    this.fixed = [
      COMMIT_DIFF_HEADING,
      MAP_INTRO,
      ...plan.map.files.map((file) =>
        [
          changeFileLine({ ...file, path: forPrompt(file.path) }),
          file.kind,
          file.fileClass,
          ...(file.isTest ? ["app test file"] : []),
          ...(file.seededBy.length > 0 ? [`seeds ${file.seededBy.join(", ")}`] : []),
        ].join(" | "),
      ),
    ];
    /* With no file header anywhere the text keeps the code-aware mode; text before the first header gets the default. */
    const headerless = plan.map.files.length === 0;
    this.blocks = plan.ranked.map((piece, i) => {
      if (piece.path === "") return redactedDiffOf(piece.text, headerless ? "model" : "issue");
      const header = plan.ranked[i - 1]?.path === piece.path ? "" : `diff --git a/${piece.path} b/${piece.path}\n`;
      return redactedDiffOf(`${header}${piece.text}`, diffSectionMode(piece.path));
    });
    this.windowReferences = plan.ranked.map((piece) => referenceLine(piece, "window"));
    this.otherReferences = plan.referenceOnly.map((piece) => referenceLine(piece, piece.why));
  }

  /* How many ranked pieces there are to show. */
  get pieces(): number {
    return this.blocks.length;
  }

  render(shown: number): string {
    return this.parts(shown).join("\n");
  }

  /* The bytes `render(shown)` would have, from the parts' sizes measured once: the parts' bytes plus one newline between two parts. */
  bytes(shown: number): number {
    const k = this.clamp(shown);
    const sizes = this.sizes();
    const references = this.blocks.length - k + this.otherReferences.length;
    const windowReferences = sizes.windowReferences[this.blocks.length]! - sizes.windowReferences[k]!;
    const partBytes =
      sizes.fixed +
      (k > 0 ? bytesOf(FENCE_OPEN) + sizes.blocks[k]! + bytesOf(FENCE_CLOSE) : 0) +
      (references > 0 ? bytesOf(REFERENCES_INTRO) + windowReferences + sizes.otherReferences : 0);
    const partCount = this.fixed.length + (k > 0 ? k + 2 : 0) + (references > 0 ? references + 1 : 0);
    return partBytes + partCount - 1;
  }

  private measured?: { fixed: number; blocks: number[]; windowReferences: number[]; otherReferences: number };

  /* Prefix sums of the parts' bytes: `blocks[k]` is the bytes of the first k blocks. */
  private sizes(): NonNullable<PlanDiffSection["measured"]> {
    const prefix = (parts: readonly string[]): number[] => {
      const sums = [0];
      for (const part of parts) sums.push(sums[sums.length - 1]! + bytesOf(part));
      return sums;
    };
    this.measured ??= {
      fixed: this.fixed.reduce((sum, part) => sum + bytesOf(part), 0),
      blocks: prefix(this.blocks),
      windowReferences: prefix(this.windowReferences),
      otherReferences: this.otherReferences.reduce((sum, part) => sum + bytesOf(part), 0),
    };
    return this.measured;
  }

  private clamp(shown: number): number {
    return Math.max(0, Math.min(shown, this.blocks.length));
  }

  private parts(shown: number): string[] {
    const k = this.clamp(shown);
    const references = [...this.windowReferences.slice(k), ...this.otherReferences];
    return [
      ...this.fixed,
      ...(k > 0 ? [FENCE_OPEN, ...this.blocks.slice(0, k), FENCE_CLOSE] : []),
      ...(references.length > 0 ? [REFERENCES_INTRO, ...references] : []),
    ];
  }
}

/* The most steps the window fit rule takes through a diff's ranked pieces: a diff of more pieces gives up several at a step, so a very large one is fitted in a bounded number of renders. */
const MAX_DIFF_STEPS = 64;

/*
 * The smaller renders of a commit diff for a prompt over its role's window (`Section.degrade`): the change map of every changed file,
 * the ranked pieces still shown and every other piece named by `path:start-end`, the lowest-ranked piece first. The first step
 * already names the app's test files, generated files and low-relevance files instead of showing them. `within` puts the section
 * back into the text that carries it (the identity when the diff section is the whole text). Planned lazily: a prompt that fits
 * never parses its diff.
 */
export function diffWindowDegrade(diff: string, within: (section: string) => string = (section) => section): (step: number) => SectionDegradation | undefined {
  let planned: { section: PlanDiffSection; references: number } | undefined;
  return (step) => {
    if (!planned) {
      const plan = planDiff(diff, []);
      planned = { section: new PlanDiffSection(plan), references: plan.referenceOnly.length };
    }
    const { section, references } = planned;
    /* With nothing set apart by kind, showing every piece beside the change map would only add to the whole diff. */
    const first = references > 0 ? section.pieces : section.pieces - 1;
    if (first < 0) return undefined;
    const perStep = Math.max(1, Math.floor(section.pieces / MAX_DIFF_STEPS));
    if (step > Math.ceil(first / perStep) + 1) return undefined;
    const shown = Math.max(0, first - (step - 1) * perStep);
    return { content: within(section.render(shown)), omissions: [{ class: "truncation", reason: WINDOW_FIT_REASON, count: section.pieces - shown + references }] };
  };
}
