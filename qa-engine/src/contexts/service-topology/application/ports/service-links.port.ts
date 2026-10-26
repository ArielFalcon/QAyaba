import type { ContractDrift, ServiceLink } from "@kernel/service-links.ts";

/**
 * Advisory cross-repo links. resolve() is no-arg: links are app-static per SHA.
 * Absent: no serviceLinks. Never throws: any error degrades to { links: [], drift: [] }.
 * Advisory only — never a verdict/gate/coverage input.
 */
export interface ServiceLinksPort {
  resolve(): Promise<{ links: ServiceLink[]; drift: ContractDrift[] }>;
}
