import type { ServiceLink, ContractDrift, ExternalCall, UnresolvedCall } from "./index.ts";

/** Structured outcome from a single resolver run. */
export interface ResolveLinksResult {
  /** Deterministic cross-repo links: front call-site → backend contract operationId. */
  links: ServiceLink[];
  /** FE↔BE contract drift: front calls an endpoint the contract does NOT declare. */
  drift: ContractDrift[];
  /** Calls to services outside the indexed repo set. */
  external: ExternalCall[];
  /** Call-sites whose path argument cannot be statically resolved. */
  unresolved: UnresolvedCall[];
}
