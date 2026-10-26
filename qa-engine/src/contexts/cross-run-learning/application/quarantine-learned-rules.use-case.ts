/*
 * One-shot, idempotent quarantine of the rules an app learned since a date. Marks them, never deletes them: a
 * quarantined rule stays in the ledger (an operator can read it) but is never retrieved into a prompt and never
 * credited with an outcome. A dry run reports what would be marked and writes nothing.
 */
import type { LearningQuarantinePort } from "./ports/learning-quarantine.port.ts";
import type { LearningRule } from "../domain/learning-repository.ts";
import { parseQuarantineSince, selectForQuarantine } from "../domain/quarantine.ts";

/** The most rules one command scans. A ledger holds hundreds; a result that fills this is truncated, and the command stops rather than quarantine part of a ledger. */
export const QUARANTINE_SCAN_LIMIT = 100_000;

export interface QuarantineRequest {
  app: string;
  /** The date from which learned rules are quarantined, as the operator typed it. */
  since: string;
  dryRun: boolean;
}

export interface QuarantineReport {
  app: string;
  /** The date as the store reads it (UTC ISO). */
  since: string;
  dryRun: boolean;
  /** The rules this run matched: the ones it marked, or in a dry run the ones it would mark. */
  matched: LearningRule[];
  /** Rules from the same window that were already quarantined by an earlier run. */
  alreadyQuarantined: number;
  /** How many rules this run newly marked; always 0 in a dry run. */
  marked: number;
}

export class QuarantineLearnedRulesUseCase {
  constructor(
    private readonly repo: LearningQuarantinePort,
    private readonly now: () => Date,
  ) {}

  async execute(request: QuarantineRequest): Promise<QuarantineReport> {
    const app = request.app.trim();
    if (app === "") throw new Error("--app is required: a quarantine is always scoped to one app");
    const since = parseQuarantineSince(request.since);

    const rules = await this.repo.listAll(app, QUARANTINE_SCAN_LIMIT);
    if (rules.length >= QUARANTINE_SCAN_LIMIT) {
      throw new Error(`the ledger of ${app} holds ${QUARANTINE_SCAN_LIMIT} rules or more: a scan that may have missed some would quarantine only part of it`);
    }
    const { toQuarantine, alreadyQuarantined } = selectForQuarantine(rules, since);

    const base = { app, since, dryRun: request.dryRun, matched: toQuarantine, alreadyQuarantined: alreadyQuarantined.length };
    if (request.dryRun || toQuarantine.length === 0) return { ...base, marked: 0 };
    const marked = await this.repo.quarantine(app, toQuarantine.map((r) => r.id), this.now().toISOString());
    return { ...base, marked };
  }
}
