/* Config-driven EVENT boundary resolver. App-specific patterns come from the injected EventBoundaryProfile — no watched-app literals here. resolveLinks never throws: a per-repo/per-file error skips that unit; an unknown eventPattern.kind fails open to an empty result. Publisher symbols resolve to the enclosing class of the publish call, not the first class in the file. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServiceBoundaryResolverPort, ResolveLinksResult } from "../application/ports/index.ts";
import type { RepoRef, ServiceLink, ServiceSymbolRef, EventBoundaryProfile } from "../domain/index.ts";
import { EventPatternCatalog, type EventPatternOccurrence } from "./event-pattern-catalog.ts";
import { compileFileGlob } from "./glob-suffix.ts";

const EXACT_MATCH_CONFIDENCE = 1.0;
const STEM_MATCH_CONFIDENCE = 0.7;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".cache"]);

/** Recursively walk a directory, collecting files matching the predicate. Mirrors openapi-http-resolver.adapter.ts's `walk()` helper — same recursive-readdir shape, adapted here for the profile's `files` glob (`.java` in nname's real usage, but generic). DETERMINISM (project invariant #1: stable, deterministic behavior): `readdirSync` order is filesystem-dependent (not guaranteed alphabetical on every OS/filesystem). This resolver's JOIN is first-match-wins (`publishers.find(...)` in resolveLinks) — when two publishers in the scanned pool publish the SAME event name (realistic: nname's dual-transport NATS+Rabbit setup makes a relay/dual-publish of one event plausible), an unsorted walk would make the emitted link's `from` symbol depend on raw filesystem order, i.e. non-deterministic across runs/environments. Sorting here fixes the file COLLECTION order deterministically; it is local to this function and does not require the caller to also sort. */
function walk(dir: string, predicate: (name: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir).sort(); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, predicate, out);
    } else if (predicate(entry)) out.push(full);
  }
  return out;
}

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
      const files = walk(repo.mirrorDir, (name) => this.isEventFile(name));
      for (const full of files) {
        let text: string;
        try { text = readFileSync(full, "utf8"); } catch { continue; }
        const relFile = full.slice(repo.mirrorDir.length + 1);
        for (const occurrence of extractor(text, this.profile.eventPattern)) {
          occurrences.push({ repo, file: relFile, occurrence });
        }
      }
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
