/* Fail-closed on an unparseable verdict. Reviewer path forwards blockingCount + parsed so a parse miss is not treated as a rejection. */
import { sep } from "node:path";
import { scanSpecTree } from "../../../shared-infrastructure/spec-path-confinement.ts";
import type { VerdictParserPort, GeneratorDeliverable, ReviewJudgment } from "../application/ports/index.ts";
import type { SpecMeta } from "@kernel/qa-case.ts";
import { GENERATION_NOTE_MAX_CHARS } from "../domain/generation-end.ts";
import { sanitizeText } from "./sanitize-text.ts";

/* Redacted at the earliest point, then cut to the note bound: the reason and the output tail end up persisted on the run, where no later stage redacts them. The reason keeps its start, the output keeps its end. */
function forNote(text: string, keep: "start" | "end"): string {
  const redacted = sanitizeText(text, "issue").text;
  return (keep === "start" ? redacted.slice(0, GENERATION_NOTE_MAX_CHARS) : redacted.slice(-GENERATION_NOTE_MAX_CHARS)).trim();
}

/* Every *.spec.ts under specDir as a suite-relative, "/"-separated path — installed packages and dot-directories excluded, as Playwright excludes them. The suite is a directory the agent writes into, so it is walked by the one walk of the specs (spec-path-confinement): no link followed and no more entries looked at than its cap, which a caller that must not miss a spec cannot rely on and one that resolves a name can: what was not walked is not listed. */
export function listSuiteSpecFiles(specDir: string, maxEntries?: number): string[] {
  return scanSpecTree(specDir, maxEntries).specs.map((path) => path.split(sep).join("/"));
}

/* A reported spec as its suite-relative path: a bare file name that is not itself a suite path becomes the one suite spec with that name. A path, an unknown name or a name several specs share is kept as reported. */
function suitePath(reported: string, suite: () => readonly string[]): string {
  if (reported.includes("/") || reported.includes("\\")) return reported;
  const specs = suite();
  if (specs.includes(reported)) return reported;
  const named = specs.filter((path) => path.endsWith(`/${reported}`));
  return named.length === 1 ? named[0]! : reported;
}

interface LegacyVerdict {
  approved?: boolean;
  parsed: boolean;
  specs?: string[];
  note?: string;
  /* The reason the generator gave for writing nothing; approved is never a no-op signal. */
  noopReason?: string;
  /* specMetas drives the deterministic disk-reconciled manifest upsert; parsed (above) is the #1 fail-closed invariant. Both REQUIRED here so parseGenerator can forward them — dropping them would make the use-case misclassify a parse miss and lose the manifest-upsert signal. */
  specMetas?: SpecMeta[];
}
interface LegacyReviewer {
  approved: boolean;
  corrections: string[];
  rationale?: string;
  blockingCount?: number;
  parsed?: boolean;
  valid: boolean;
  issues: string[];
}

export interface VerdictParsers {
  parseVerdict(text: string): LegacyVerdict;
  parseReviewerVerdict(text: string): LegacyReviewer;
}

export class VerdictParserAdapter implements VerdictParserPort {
  constructor(
    private readonly p: VerdictParsers,
    private readonly listSuiteSpecs: (specDir: string) => readonly string[] = listSuiteSpecFiles,
  ) {}

  parseGenerator(text: string, specDir?: string): GeneratorDeliverable {
    const v = this.p.parseVerdict(text);
    /* The suite is listed at most once, and only when a bare name needs resolving. */
    let suite: readonly string[] | undefined;
    const suiteSpecs = (): readonly string[] => (suite ??= specDir === undefined ? [] : this.listSuiteSpecs(specDir));
    const resolve = (reported: string): string => suitePath(reported, suiteSpecs);
    /* specs ?? [] is the fail-closed default (a parse miss leaves specs undefined → never undefined out). parsed forwarded always (the #1 invariant the use-case branches on); specMetas only when present (drives the disk-reconciled manifest upsert — "disk over the agent's word"). */
    const noopReason = v.noopReason ? forNote(v.noopReason, "start") : "";
    const outputTail = forNote(text, "end");
    return {
      specs: (v.specs ?? []).map(resolve),
      ...(v.note ? { note: v.note } : {}),
      ...(noopReason ? { noopReason } : {}),
      ...(outputTail ? { outputTail } : {}),
      ...(v.specMetas ? { specMetas: v.specMetas.map((meta) => ({ ...meta, file: resolve(meta.file) })) } : {}),
      parsed: v.parsed,
    };
  }

  parseReview(text: string): ReviewJudgment {
    const r = this.p.parseReviewerVerdict(text);
    return {
      approved: r.approved,
      corrections: r.corrections,
      ...(r.rationale ? { rationale: r.rationale } : {}),
      ...(r.blockingCount !== undefined ? { blockingCount: r.blockingCount } : {}),
      ...(r.parsed !== undefined ? { parsed: r.parsed } : {}),
      valid: r.valid,
      issues: r.issues,
    };
  }
}
