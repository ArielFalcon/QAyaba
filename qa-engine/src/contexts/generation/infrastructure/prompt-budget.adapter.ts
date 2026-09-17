import type { PromptBudgetPort } from "../application/ports/index.ts";

type RoleWindowBytes = (role: string) => number;
type Cap = (s: string) => string;

export class PromptBudgetAdapter implements PromptBudgetPort {
  constructor(
    private readonly roleWindowBytesFn: RoleWindowBytes,
    private readonly _capDiff: Cap,
    private readonly _capText: Cap,
  ) {}

  budgetForRole(role: string): number {
    return this.roleWindowBytesFn(role);
  }

  capDiff(diff: string): string {
    return this._capDiff(diff);
  }

  capText(text: string): string {
    return this._capText(text);
  }
}
