/* Folds a finished run's outcome into the learning ledger: the oracle scorecard, then the score onto each retrieved rule that could have shaped the run. Off-path: a failure is logged and never gates or fails the run it learns from. */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { attributableRules, preventionOutcome } from "../domain/rule-fold.ts";
import type { LearningStorePort } from "./ports/learning-store.port.ts";

export class FoldRunOutcome {
  /* `redaction` cleans the failure text before it is logged; without it only the error kind is logged, so no message text reaches the log unredacted. */
  constructor(
    private readonly store: LearningStorePort,
    private readonly redaction?: RedactionPort,
  ) {}

  execute(outcome: RunOutcome): void {
    try {
      const { rulesRetrieved, gateSignals, errorClass } = outcome;
      /* Persist the per-run oracle scorecard even when no rules were retrieved. */
      this.store.saveScorecardEntry({
        runId: outcome.runId,
        app: outcome.app,
        sha: outcome.sha,
        target: outcome.target,
        valueScore: gateSignals.valueScore,
        /* Real counts when the value-oracle measured this run; null ("not measured") otherwise — never a hardcoded 0, which would be indistinguishable from a genuine measured zero. */
        mutantCount: gateSignals.mutantCount ?? null,
        killedCount: gateSignals.killedCount ?? null,
        at: outcome.at,
      });
      if (rulesRetrieved.length === 0) return; /* nothing retrieved -> nothing to fold onto rules */
      const { valueScore, coverageRatio } = gateSignals;
      const coverageMeasured = coverageRatio !== null;
      const coverageCreditConfirmed = coverageMeasured ? coverageRatio > 0 : null;
      /*
       * Attribution: credit only the retrieved rules that could have shaped this run — untagged
       * rules, or rules tagged with one of the diff's structural shapes. A suite-level score says
       * nothing about a rule written for an unrelated kind of change. No known shapes (non-diff
       * modes) keeps every rule. Rules are looked up directly by id within this app, never via a
       * capped bulk list, so ledger size cannot drop a fold; a rule deleted since retrieval, or
       * another app's id, carries no signal. A rule retired after retrieval (human veto, process
       * audit) is skipped by the store itself.
       */
      const retrieved = rulesRetrieved
        .map((id) => this.store.findRule(id))
        .filter((rule): rule is NonNullable<typeof rule> => rule !== undefined);
      const attributable = attributableRules(retrieved, { diffArchetypes: outcome.diffArchetypes ?? [] });

      if (valueScore !== null) {
        /* Oracle path: isOracleScore=true so candidate→active requires this evidence. */
        for (const rule of attributable) {
          this.store.recordRuleOutcome(rule.id, valueScore, coverageCreditConfirmed, true);
        }
      } else {
        /* Prevention path: no oracle score — derived credit must not advance oracleOutcomeCount or by itself promote candidate → active. */
        for (const rule of attributable) {
          const score = preventionOutcome(rule.errorClass, errorClass);
          if (score !== null) this.store.recordRuleOutcome(rule.id, score, coverageCreditConfirmed);
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const shown = this.redaction ? this.redaction.redact(detail) : err instanceof Error ? err.name : "non-error value";
      console.warn(`[qa] the learning fold failed and the run goes on unfolded: ${shown}`);
    }
  }
}
