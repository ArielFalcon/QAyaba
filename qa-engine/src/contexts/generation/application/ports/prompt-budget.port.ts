/** capDiff/capText prompt-budget capping — a generation concern, NOT redaction. budgetForRole resolves the per-role byte budget (model → window → bytes) from the catalog; the adapter FORWARDS roleWindowBytes(role) — the port carries no threshold, the catalog owns it. */
export interface PromptBudgetPort {
  capDiff(diff: string): string;
  capText(text: string): string;
  budgetForRole(role: string): number;
}
