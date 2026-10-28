/* ProviderDocumentsPort. The document a link points at (`to.repo`, `to.file`) is read from that service's mirror through the RepoReader the link resolver reads it with (no link followed, bounded bytes), once however many links point at it, and parsed. Only the declared services' documents and only HTTP links are read. Fail-open, logged: what cannot be read or parsed is left out. */
import { parse as parseYaml } from "yaml";
import { engineLog } from "@kernel/ports/process-logger.ts";
import type { MirrorRegistryPort } from "@kernel/ports/mirror-registry.port.ts";
import type { ServiceLink } from "@kernel/service-links.ts";
import type { ProviderDocumentsPort } from "../../application/ports/provider-documents.port.ts";
import { MAX_TOPOLOGY_OPENAPI_BYTES } from "../repo-walk.ts";
import { RepoReader } from "../../../../shared-infrastructure/repo-reader.ts";

export class ProviderDocumentsPortAdapter implements ProviderDocumentsPort {
  constructor(
    private readonly mirrors: MirrorRegistryPort,
    private readonly services: readonly { repo: string }[],
  ) {}

  async read(links: readonly ServiceLink[]): Promise<unknown[]> {
    try {
      const wanted = new Map<string, { repo: string; file: string }>();
      for (const link of links) {
        if (link.transport !== "http" || !this.services.some((service) => service.repo === link.to.repo)) continue;
        wanted.set(`${link.to.repo}\0${link.to.file}`, { repo: link.to.repo, file: link.to.file });
      }
      const documents: unknown[] = [];
      for (const { repo, file } of wanted.values()) {
        const reader = new RepoReader(await this.mirrors.mirrorDir(repo));
        const text = reader.optionalText(file, MAX_TOPOLOGY_OPENAPI_BYTES);
        reader.warn(repo);
        if (text === undefined) continue;
        try {
          documents.push(parseYaml(text));
        } catch {
          /* a document that does not parse declares nothing; its text is never quoted */
        }
      }
      return documents;
    } catch (err) {
      engineLog.error("[qa] WARNING: the provider documents were not read (non-blocking; the contract classes are lost):", { error: err });
      return [];
    }
  }
}
