/* Whether a run's outcome should feed the learning flywheel's rule-distillation. Suppress distillation when the adjudicator classified the failure as `app_defect` or `dev_not_rendered` (not any other class): a real bug and a change DEV did not render are both bad teachers for a test-defect rule. Every other verdict/class combination (including `invalid`) still feeds learning. The optional argument is an untyped string so this helper never imports the domain AdjudicatorClass union. */
export function shouldDistillLearning(adjudicationClass?: string): boolean {
  return adjudicationClass !== "app_defect" && adjudicationClass !== "dev_not_rendered";
}
