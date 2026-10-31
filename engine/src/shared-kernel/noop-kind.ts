/* The two reasons a generator may have for writing no spec, as its verdict names them, and what a verdict that names neither is recorded as. Observe-only: the kind is recorded with the run and read by nothing that decides it. */
export const NOOP_KIND = {
  /* Nothing in the change is worth an E2E test. */
  NOT_WORTH: "not-worth",
  /* The changed behaviour cannot be observed on DEV in its current state; its reason names the element and the evidence relied on. */
  UNOBSERVABLE: "unobservable",
  /* A no-op whose verdict names no kind, or one the contract does not know: every verdict written before the kind existed. */
  UNSPECIFIED: "unspecified",
} as const;

export type NoopKind = (typeof NOOP_KIND)[keyof typeof NOOP_KIND];

export function readNoopKind(raw: unknown): NoopKind {
  return raw === NOOP_KIND.NOT_WORTH || raw === NOOP_KIND.UNOBSERVABLE ? raw : NOOP_KIND.UNSPECIFIED;
}
