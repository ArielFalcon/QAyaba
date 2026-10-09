/* Config-driven EVENT boundary resolver. App-specific patterns come from the injected EventBoundaryProfile — no watched-app literals here. resolveLinks never throws: a per-repo/per-file error skips that unit; an unknown eventPattern.kind fails open to an empty result. Publisher symbols resolve to the enclosing class of the publish call, not the first class in the file. The sources are listed and read through one RepoReader (see repo-walk.ts): a mirror is a directory the agent writes into, so no link is followed, no named pipe is opened and neither the entries looked at nor the size of a file is unbounded; what could not be used is skipped, and said once for the repository.
   DETERMINISM (project invariant #1: stable, deterministic behavior): this resolver's JOIN is first-match-wins (`publishers.find(...)` in resolveLinks) — when two publishers in the scanned pool publish the SAME event name (realistic: nname's dual-transport NATS+Rabbit setup makes a relay/dual-publish of one event plausible), a walk in filesystem order would make the emitted link's `from` symbol depend on it, i.e. non-deterministic across runs/environments. The walk visits the entries in the order of their names. */
import type { ServiceBoundaryResolverPort, ResolveLinksResult } from "../application/ports/index.ts";
import type { RepoRef, ServiceLink, ServiceSymbolRef, EventBoundaryProfile } from "../domain/index.ts";
import { RepoReader } from "../../../shared-infrastructure/repo-reader.ts";
import { EventPatternCatalog, type EventPatternOccurrence } from "./event-pattern-catalog.ts";
import { compileFileGlob } from "./glob-suffix.ts";
import { MAX_TOPOLOGY_SOURCE_BYTES, SKIP_VENDOR_DIRS } from "./repo-walk.ts";

const EXACT_MATCH_CONFIDENCE = 1.0;
const STEM_MATCH_CONFIDENCE = 0.7;

/** Flat resolved occurrence with its ORIGIN repo attached (the catalog is per-file, this resolver is the layer that knows which repo a file came from). */
interface RepoOccurrence {
  repo: RepoRef;
  file: string;
  occurrence: EventPatternOccurrence;
}

/** Returns the name unchanged if it has neither suffix (so e.g. "Foo" stems to "Foo", not dropped). */
function stem(name: string): string {
  if (name.endsWith("Event")) return name.slice(0, -"Event".length);
  if (name.endsWith("Model")) return name.slice(0, -"Model".length);
  return name;
}

export class EventResolver implements ServiceBoundaryResolverPort {
  private readonly isEventFile: (filename: string) => boolean;

  constructor(private readonly profile: EventBoundaryProfile) {
    this.isEventFile = compileFileGlob(profile.files);
  }

  async resolveLinks(system: RepoRef[], front: RepoRef): Promise<ResolveLinksResult> {
    const empty: ResolveLinksResult = { links: [], drift: [], external: [], unresolved: [] };

    const extractor = EventPatternCatalog[this.profile.eventPattern.kind];
    if (!extractor) return empty;

    const seenRepos = new Set<string>();
    const pool: RepoRef[] = [];
    for (const repo of [...system, front]) {
      if (seenRepos.has(repo.repo)) continue;
      seenRepos.add(repo.repo);
      pool.push(repo);
    }

    const occurrences: RepoOccurrence[] = [];
    for (const repo of pool) {
      const reader = new RepoReader(repo.mirrorDir);
      for (const relFile of reader.files((name) => this.isEventFile(name), SKIP_VENDOR_DIRS)) {
        const text = reader.listedText(relFile, MAX_TOPOLOGY_SOURCE_BYTES);
        if (text === undefined) continue;
        for (const occurrence of extractor(text, this.profile.eventPattern)) {
          occurrences.push({ repo, file: relFile, occurrence });
        }
      }
      reader.warn(repo.repo);
    }

    const modelOfBrokerInterface = new Map<string, string>();
    for (const o of occurrences) {
      if (o.occurrence.role === "broker-interface") {
        modelOfBrokerInterface.set(o.occurrence.className, o.occurrence.modelName);
      }
    }

    interface FlatPublisher { repo: RepoRef; file: string; className: string; eventName: string }
    const publishers: FlatPublisher[] = [];
    for (const o of occurrences) {
      if (o.occurrence.role === "broker-impl") {
        const modelName = modelOfBrokerInterface.get(o.occurrence.brokerInterfaceName);
        if (modelName === undefined) continue;
        publishers.push({ repo: o.repo, file: o.file, className: o.occurrence.className, eventName: modelName });
      } else if (o.occurrence.role === "publisher") {
        publishers.push({ repo: o.repo, file: o.file, className: o.occurrence.className, eventName: o.occurrence.eventName });
      }
    }

    interface FlatListener { repo: RepoRef; file: string; className: string; eventName: string }
    const listeners: FlatListener[] = [];
    for (const o of occurrences) {
      if (o.occurrence.role === "listener") {
        listeners.push({ repo: o.repo, file: o.file, className: o.occurrence.className, eventName: o.occurrence.eventName });
      }
    }

    const links: ServiceLink[] = [];
    for (const listener of listeners) {
      const exactMatch = publishers.find((p) => p.eventName === listener.eventName);
      const matched = exactMatch ?? publishers.find((p) => stem(p.eventName) === stem(listener.eventName));
      if (!matched) continue;

      const confidence = exactMatch ? EXACT_MATCH_CONFIDENCE : STEM_MATCH_CONFIDENCE;
      const fromRef: ServiceSymbolRef = { repo: matched.repo.repo, file: matched.file, symbol: matched.className };
      const toRef: ServiceSymbolRef = { repo: listener.repo.repo, file: listener.file, symbol: listener.className };
      links.push({
        from: fromRef,
        to: toRef,
        transport: "event",
        contractRef: matched.eventName,
        confidence,
        source: "event-topic",
      });
    }

    return { links, drift: [], external: [], unresolved: [] };
  }
}
