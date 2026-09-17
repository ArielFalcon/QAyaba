import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { AppDefect } from "./app-defect.ts";

export const PLAYWRIGHT_INFRA_RE =
  /browserType\.(?:launch|connect)|Executable doesn't exist|Failed to launch|missing dependencies to run browsers|Host system is missing dependencies/i;

export interface AdjudicationResult {
  readonly verdict: RunVerdict;
  readonly appDefect: AppDefect;
}

export class AdjudicateService {
  private allFailuresAreRunnerInfra(cases: readonly QaCase[]): boolean {
    const failed = cases.filter((c) => c.status === "fail");
    return failed.length > 0 && failed.every((c) => PLAYWRIGHT_INFRA_RE.test(c.detail ?? ""));
  }

  adjudicate(verdict: RunVerdict, cases: readonly QaCase[]): AdjudicationResult {
    if (verdict === "fail" && this.allFailuresAreRunnerInfra(cases)) {
      const first = cases.find((c) => c.status === "fail");
      return { verdict: "infra-error", appDefect: AppDefect.fromRunnerInfra(first?.detail ?? "") };
    }
    return { verdict, appDefect: AppDefect.none() };
  }
}
