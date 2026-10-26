/* What an explore sidekick reports and what the orchestrator makes of it: the shapes only; admission, verification and rendering are in their own modules. */

export const EXPLORE_FINDING_KIND = { PAGE: "page", ELEMENT: "element", SYMBOL: "symbol", DATA_STATE: "data-state" } as const;
export type ExploreFindingKind = (typeof EXPLORE_FINDING_KIND)[keyof typeof EXPLORE_FINDING_KIND];

export const EXPLORE_STATUS = { ANSWERED: "answered", UNANSWERED: "unanswered" } as const;
export type ExploreStatus = (typeof EXPLORE_STATUS)[keyof typeof EXPLORE_STATUS];

export const MAX_FINDINGS = 12;
export const MAX_FINDING_CHARS = 400;
export const MAX_REF_CHARS = 300;

/* One observation of an explore sidekick: the claim, what it is about (`ref`) and what the sidekick says it read or saw. */
export interface ExploreFinding {
  readonly claim: string;
  readonly kind: ExploreFindingKind;
  readonly ref: string;
  readonly evidence: string;
}

/* A sidekick's answer to one question. */
export interface Exploration {
  readonly id: string;
  readonly status: ExploreStatus;
  readonly findings: readonly ExploreFinding[];
}
