/*
 * The smaller renders a prompt section gives way to when its prompt is over its role's window (the window fit rule of the run's
 * ContextBudget, applied by the assembler). Each names what it leaves out, as references a reader can follow (a page, a file and its
 * lines, a count), and records it as a `window-fit` omission. No fixed byte, line or node count decides any of them: they are used
 * only when the window does not hold the whole section. Never import src/.
 */
import { WINDOW_FIT_REASON, type SectionDegradation } from "@kernel/prompt-sections.ts";
import type { Omission } from "@kernel/telemetry/section-meta.ts";
import { domPageCount, referenceDomPages } from "@contexts/generation/domain/pack-pages.ts";

const windowFit = (count: number, route?: string): Omission => ({ class: "truncation", reason: WINDOW_FIT_REASON, count, ...(route !== undefined ? { route } : {}) });

/*
 * A DOM text that gives way page by page, the last (lowest-ranked) page first, each shown as its `route …:` line and how many lines
 * it held. `wrap` puts the DOM back into its section; `itemIds` drops the elements of every page left out from the ids the section
 * supplies; `section` names the heading the pages are under, in a text that holds others.
 */
export function domPagesDegrade(opts: {
  dom: string;
  wrap: (dom: string) => string;
  itemIds?: readonly string[];
  omissions?: readonly Omission[];
  section?: string;
}): (step: number) => SectionDegradation | undefined {
  const scope = opts.section !== undefined ? { section: opts.section } : {};
  const pages = domPageCount(opts.dom, scope);
  return (step) => {
    if (step > pages) return undefined;
    const { text, left } = referenceDomPages(opts.dom, step, scope);
    const leftRoutes = left.map((page) => `dom:${page.route}#`);
    return {
      content: opts.wrap(text),
      omissions: [...(opts.omissions ?? []), ...left.map((page) => windowFit(page.lines, page.route))],
      itemIds: (opts.itemIds ?? []).filter((id) => !leftRoutes.some((prefix) => id.startsWith(prefix))),
    };
  };
}

/* A section whose only smaller render is one line naming what it holds; `items` is what that line leaves out. */
export function referenceDegrade(reference: string, items: number): (step: number) => SectionDegradation | undefined {
  return (step) => (step === 1 ? { content: reference, omissions: [windowFit(items)] } : undefined);
}

/* Steps tried in order: each a whole render of the section and how many items it leaves out. */
export function stepsDegrade(steps: ReadonlyArray<{ content: string; items: number }>): (step: number) => SectionDegradation | undefined {
  return (step) => {
    const next = steps[step - 1];
    return next === undefined ? undefined : { content: next.content, omissions: [windowFit(next.items)] };
  };
}

/* Paths grouped by the directory they are in, each directory once with how many of them it holds, in first-seen order. */
export function countByDirectory(paths: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const at = path.lastIndexOf("/");
    const dir = at === -1 ? "." : path.slice(0, at + 1);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts].map(([dir, count]) => `- ${dir}: ${count} file(s)`);
}

/* The sentence every reference closes on: what it stands for is not in the prompt because the prompt did not fit its window. */
export const NOT_SHOWN = "not shown here, to fit the window";
