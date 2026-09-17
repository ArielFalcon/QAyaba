import type { RunVerdict } from "@kernel/run-verdict.ts";

/* Whether a run's outcome should feed the learning flywheel's rule-distillation. A code-mode `fail` means the generated test correctly caught a real bug — distilling a "fix this test" rule would weaken a test that did its job. Suppress distillation for that case, and when the adjudicator classified the failure as `app_defect` (not any other class). Every other verdict/class combination (including `invalid`) still feeds learning. e2e is unaffected by the isCode+fail rule; the app_defect rule applies regardless of isCode/verdict. The optional third arg is untyped string so this helper never imports the domain AdjudicatorClass union. */
export function shouldDistillLearning(isCode: boolean, verdict: RunVerdict, adjudicationClass?: string): boolean {
  return !(isCode && verdict === "fail") && adjudicationClass !== "app_defect";
}
