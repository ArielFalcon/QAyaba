/*
 * The smaller renders a prompt section gives way to when its prompt is over its role's window (the window fit rule of the run's
 * ContextBudget, applied by the assembler). Each names what it leaves out, as references a reader can follow (a page, a file and its
 * lines, a count), and records it as a `window-fit` omission. No fixed byte, line or node count decides any of them: they are used
 * only when the window does not hold the whole section. Never import src/.
 */
import { WINDOW_FIT_REASON, type SectionDegradation } from "@kernel/prompt-sections.ts";
import type { Omission } from "@kernel/telemetry/section-meta.ts";
import { domPageCount, referenceDomPages, referenceSectionFacts, sectionFactCount } from "./pack-pages.ts";
import { PACK_HEADINGS } from "./prompt-headings.ts";
import { advisoryLineIds, itemId } from "@kernel/context-item-ids.ts";

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

/*
 * The Context Pack over the window: its Live DOM gives way page by page (the lowest-ranked page first), then its availability
 * facts, then its API contracts, the last-listed fact first, each named by a count. `liveDom` is the heading of the DOM section.
 */
export function packDegrade(opts: { pack: string; liveDom: string; itemIds?: readonly string[]; omissions?: readonly Omission[] }): (step: number) => SectionDegradation | undefined {
  const pages = domPageCount(opts.pack, { section: opts.liveDom });
  const dom = domPagesDegrade({ dom: opts.pack, wrap: (text) => text, section: opts.liveDom, ...(opts.itemIds ? { itemIds: opts.itemIds } : {}), ...(opts.omissions ? { omissions: opts.omissions } : {}) });
  const facts = sectionFactCount(opts.pack, PACK_HEADINGS.availability);
  const contracts = sectionFactCount(opts.pack, PACK_HEADINGS.contracts);
  return (step) => {
    if (step <= pages) return dom(step);
    const count = step - pages;
    if (count > facts + contracts) return undefined;
    const base = pages > 0 ? dom(pages) : undefined;
    const availability = referenceSectionFacts(base?.content ?? opts.pack, PACK_HEADINGS.availability, Math.min(count, facts), "route");
    const dropContracts = count > facts ? referenceSectionFacts(availability.text, PACK_HEADINGS.contracts, count - facts, "contract") : undefined;
    const ids = base?.itemIds ?? opts.itemIds;
    /* A contract left out is no longer an item the pack supplies. */
    const droppedOps = (dropContracts?.dropped ?? []).flatMap((line) => {
      const name = /^- `([^`]*)`/.exec(line)?.[1];
      return name === undefined ? [] : [itemId.op(name)];
    });
    return {
      content: dropContracts?.text ?? availability.text,
      omissions: [...(base?.omissions ?? opts.omissions ?? []), windowFit(availability.left + (dropContracts?.left ?? 0))],
      ...(ids ? { itemIds: ids.filter((id) => !droppedOps.includes(id)) } : {}),
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

/* A list of an advisory block (a third-level heading with its count, and its `- ` items), and what its items are: reached symbols with their file, or co-change files. */
interface AdvisoryList {
  start: number;
  end: number;
  kind: "symbols" | "files";
  items: string[];
}

/* The heading of one list of an advisory block: the line this reads, never one it writes. */
const LIST_HEADING = /^#{3} /;
const SYMBOL_ITEM = /^- `[^`]*` \((.+)\)$/;
const FILE_ITEM = /^- (\S+) \(coupling /;

function advisoryLists(lines: readonly string[]): AdvisoryList[] {
  const lists: AdvisoryList[] = [];
  for (let at = 0; at < lines.length; at++) {
    if (!LIST_HEADING.test(lines[at]!)) continue;
    let end = at + 1;
    while (end < lines.length && !lines[end]!.startsWith("#")) end++;
    const items = lines.slice(at + 1, end).filter((line) => line.startsWith("- "));
    const kind = items.length === 0 ? undefined : items.every((line) => SYMBOL_ITEM.test(line)) ? "symbols" : items.every((line) => FILE_ITEM.test(line)) ? "files" : undefined;
    if (kind) lists.push({ start: at, end, kind, items });
  }
  return lists;
}

/*
 * The lists of an advisory block (the structural block: impacted symbols, their callers, co-change files) over the window: the last
 * symbol list gives way first, each as the files it names with how many symbols each holds, then the earlier symbol lists, then the
 * co-change files by directory. A list keeps its heading and its total, so the block still says how much it reaches; whatever is not a
 * list (the title, the introduction, the dossier of source) stays as it is.
 */
export function advisoryListsDegrade(block: string): (step: number) => SectionDegradation | undefined {
  const lines = block.split("\n");
  const lists = advisoryLists(lines);
  const order = [...lists.filter((list) => list.kind === "symbols").reverse(), ...lists.filter((list) => list.kind === "files")];
  return (step) => {
    if (step > order.length) return undefined;
    const given = new Map(order.slice(0, step).map((list) => [list.start, list] as const));
    const out: string[] = [];
    for (let at = 0; at < lines.length; at++) {
      const list = given.get(at);
      if (!list) {
        out.push(lines[at]!);
        continue;
      }
      out.push(lines[at]!);
      if (list.kind === "symbols") {
        const byFile = new Map<string, number>();
        for (const item of list.items) {
          const file = SYMBOL_ITEM.exec(item)![1]!;
          byFile.set(file, (byFile.get(file) ?? 0) + 1);
        }
        out.push(...[...byFile].map(([file, count]) => `- ${file}: ${count} symbol(s)`));
      } else out.push(...countByDirectory(list.items.map((item) => FILE_ITEM.exec(item)![1]!)));
      out.push(`(The ${list.kind === "symbols" ? "symbol names" : "files"} are ${NOT_SHOWN}.)`);
      /* The blank line that closes a list stays. */
      if (lines[list.end - 1] === "") out.push("");
      at = list.end - 1;
    }
    const content = out.join("\n");
    return { content, omissions: [windowFit(order.slice(0, step).reduce((n, list) => n + list.items.length, 0))], itemIds: advisoryLineIds(content) };
  };
}
