/* ProcessAuditPort adapter. This context never imports src/ directly. This adapter trusts that gate and does not re-check the current outcome's own verdict/class. (2) INTERNAL streak-input gate — THIS adapter filters the recent-outcomes read (layer 2, below) to exclude flaky and non-learning-class entries (outages, undecided generations) BEFORE they ever reach auditProcess's streak calculation, so a recurring-engine-defect streak can never be polluted/broken by infra noise. Fault isolation (mirrors ReflectorPortAdapter's own documented contract on the sibling port): a throwing read, a throwing sink, or a hang past the configured timeout budget is caught/bounded INLINE and never re-thrown — the run's already-made verdict/ledger writes are made BEFORE this call and are structurally unaffected by anything that happens inside audit(). */
import { engineLog } from "@kernel/ports/process-logger.ts";
import { auditProcess, applyAudit, type ProcessFinding, type RuleView } from "../domain/process-audit.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { NON_LEARNING, OBSERVED_OPERATING } from "../domain/learning-gates.ts";

const RECENT_LIMIT = 10;
const RULES_LIMIT = 50;

export const PROCESS_AUDIT_TIMEOUT_MS = 10_000;

export interface ProcessAuditPortDeps {
  app: string;
  readRecentOutcomes: (app: string, limit: number) => Promise<RunOutcome[]> | RunOutcome[];
  readRules: (app: string, limit: number) => Promise<RuleView[]> | RuleView[];
  deprecateRule: (ruleId: string, reason: string) => void;
  recordEngineIncident: (finding: ProcessFinding) => void;
  invalidateContext: (reason: string) => boolean;
  log?: (line: string) => void;
  onAuditError?: (e: unknown) => void;
  timeoutMs?: number;
}

export class ProcessAuditPortAdapter {
  constructor(private readonly deps: ProcessAuditPortDeps) {}

  async audit(outcome: RunOutcome): Promise<void> {
    const { app, readRecentOutcomes, readRules, deprecateRule, recordEngineIncident, invalidateContext, timeoutMs } = this.deps;
    const log = this.deps.log ?? ((line: string) => engineLog.info(line));
    const reportError = this.deps.onAuditError ?? ((e: unknown) => engineLog.error("[ProcessAuditPortAdapter] audit failed (off-path, swallowed):", { error: e }));
    const budget = timeoutMs ?? PROCESS_AUDIT_TIMEOUT_MS;

    const run = async (): Promise<void> => {
      const [rawRecent, rules] = await Promise.all([
        Promise.resolve(readRecentOutcomes(app, RECENT_LIMIT)),
        Promise.resolve(readRules(app, RULES_LIMIT)),
      ]);
      /*
       * Only runs that could teach anything belong in a streak: an outage, a flaky run or a generation that decided nothing must neither extend nor break it.
       * The exception is the audit of an operating signal (a run that ended on its time): that streak is made of exactly such runs, so they stay in the
       * window, and only the noise that says nothing about them is left out.
       */
      const observing = outcome.errorClass != null && OBSERVED_OPERATING.has(outcome.errorClass);
      const leftOut = (r: RunOutcome): boolean =>
        r.verdict === "flaky" || (r.errorClass != null && NON_LEARNING.has(r.errorClass) && !(observing && OBSERVED_OPERATING.has(r.errorClass)));
      const recent = rawRecent.filter((r) => !leftOut(r));
      const findings = auditProcess({ outcome, recent, rules });
      if (findings.length === 0) return;
      applyAudit(findings, { log, deprecateRule, recordEngineIncident, invalidateContext });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log(`[audit] process-audit timed out after ${budget}ms (fault-isolated — run continues, never blocks publish)`);
        resolve();
      }, budget);
    });

    try {
      await Promise.race([run(), timeout]);
    } catch (e) {
      /* Off-path by contract: never gates publish, never affects the already-made verdict/ledger writes. Logged, not re-thrown — mirrors ReflectorPortAdapter's documented convention. */
      reportError(e);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
