/*
 * The grounding metadata of one prompt section: the items it supplied, as stable ids, and the items it left out. Pure shapes,
 * shared by the assembler (which computes `capped` and the section-cap/shed omissions) and the turn trace (which turns a
 * prompt's surviving sections into delivered spans). A section's id alone names its grounding source; the mapping is here so a
 * caller never re-derives it and a grader can count which items an agent was actually given.
 *
 * Lives in the kernel so `agent-runtime.port.ts` can name these shapes without importing a context. The source-name values are
 * the same literals `context-item-ids.ts` declares as `ContextSource`; they are kept as literals here so this kernel module has
 * no context dependency of its own.
 */

/* One omission: why items are gone (selection: the builder chose not to include them; truncation: a bound cut them) and a
 * closed reason, with the count of items it cost. */
export interface Omission {
  class: "selection" | "truncation";
  reason: string;
  count: number;
  /* The page a DOM truncation happened on, when the omission is page-scoped. */
  route?: string;
}

/* What a surviving section supplied and lost. `capped` is the assembler's own fact: the section's content was cut to a bound, so
 * (conservatively) it delivers no item ids and every one of its declared items is omitted with `section-cap`; a shed section is the
 * same with `section-shed`. */
export interface SectionMeta {
  itemIds: string[];
  omissions: Omission[];
  capped: boolean;
}

/* The grounding source a prompt section supplies, for the delivered span. A section id not here supplies none. */
export const SECTION_SOURCE = {
  "arch-map": "context-map",
  "context-pack": "context-pack",
  "service-links": "service-links",
  "static-signal": "structural-signal",
} as const;
