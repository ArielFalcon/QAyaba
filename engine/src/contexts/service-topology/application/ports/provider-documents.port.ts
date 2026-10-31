import type { ServiceLink } from "@kernel/service-links.ts";

/**
 * The provider documents (the services' OpenAPI documents) the links the run resolved point at, parsed: what a consumer of the links reads
 * of the provider's contract. Read through the same confined reader the link resolver reads them with. Fail-open: a document that cannot
 * be read or parsed is left out, and any fault yields no document. Advisory only.
 */
export interface ProviderDocumentsPort {
  read(links: readonly ServiceLink[]): Promise<unknown[]>;
}
