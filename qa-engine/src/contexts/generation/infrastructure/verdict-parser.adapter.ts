/* Fail-closed on an unparseable verdict. Reviewer path forwards blockingCount + parsed so a parse miss is not treated as a rejection. */
import type { VerdictParserPort, GeneratorDeliverable, ReviewJudgment } from "../application/ports/index.ts";
import type { SpecMeta } from "@kernel/qa-case.ts";

interface LegacyVerdict {
  approved?: boolean;
  parsed: boolean;
  specs?: string[];
  note?: string;
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
  constructor(private readonly p: VerdictParsers) {}

  parseGenerator(text: string): GeneratorDeliverable {
    const v = this.p.parseVerdict(text);
    /* specs ?? [] is the GEN-05 fail-closed default (a parse miss leaves specs undefined → never undefined out). parsed forwarded always (the #1 invariant the use-case branches on); specMetas only when present (drives the disk-reconciled manifest upsert — "disk over the agent's word"). */
    return {
      specs: v.specs ?? [],
      ...(v.note ? { note: v.note } : {}),
      ...(v.specMetas ? { specMetas: v.specMetas } : {}),
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
