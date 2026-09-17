/* ProcessAuditPort adapter. This context never imports src/ directly. This adapter trusts that gate and does not re-check the current outcome's own verdict/class. (2) INTERNAL streak-input gate — THIS adapter filters the recent-outcomes read (layer 2, below) to exclude flaky/infra-class entries BEFORE they ever reach auditProcess's streak calculation, so a recurring-engine-defect streak can never be polluted/broken by infra noise. Fault isolation (mirrors ReflectorPortAdapter's own documented contract on the sibling port): a throwing read, a throwing sink, or a hang past the configured timeout budget is caught/bounded INLINE and never re-thrown — the run's already-made verdict/ledger writes are made BEFORE this call and are structurally unaffected by anything that happens inside audit(). */
import { auditProcess, applyAudit, type ProcessFinding, type RuleView } from "../domain/process-audit.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

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
    const log = this.deps.log ?? ((line: string) => console.log(line));
    const reportError = this.deps.onAuditError ?? ((e: unknown) => console.error("[ProcessAuditPortAdapter] audit failed (off-path, swallowed):", e));
    const budget = timeoutMs ?? PROCESS_AUDIT_TIMEOUT_MS;

    const run = async (): Promise<void> => {
      const [rawRecent, rules] = await Promise.all([
        Promise.resolve(readRecentOutcomes(app, RECENT_LIMIT)),
        Promise.resolve(readRules(app, RULES_LIMIT)),
      ]);
      const recent = rawRecent.filter(
        (r) => r.verdict !== "flaky" && r.errorClass !== "E-INFRA" && r.errorClass !== "E-FLAKY",
      );
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
