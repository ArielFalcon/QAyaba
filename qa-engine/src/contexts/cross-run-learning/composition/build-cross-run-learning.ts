/* Builds the cross-run-learning context: the learning port over the app's rule repository, and the curriculum, reflector and process-audit ports the shell supplies. */

import type { CurriculumPort, LearningPort, LearningRepositoryPort, ProcessAuditPort, ReflectorPort } from "../application/index.ts";
import { LearningPortAdapter } from "../infrastructure/adapters/learning-port.adapter.ts";
import { StubLearningRepository } from "../infrastructure/stub-learning-repository.adapter.ts";

export interface CrossRunLearningDeps {
  appName: string;
  /* The durable rule repository. Absent: a repository that provably does nothing. */
  learningRepo?: LearningRepositoryPort;
  reflector?: ReflectorPort;
  curriculum?: CurriculumPort;
  processAudit?: ProcessAuditPort;
}

export interface CrossRunLearningApi {
  learning: LearningPort;
  /* Each optional port is served only when supplied: never a fabricated no-op stub. */
  reflector?: ReflectorPort;
  curriculum?: CurriculumPort;
  processAudit?: ProcessAuditPort;
}

export function buildCrossRunLearning(deps: CrossRunLearningDeps): CrossRunLearningApi {
  return {
    learning: new LearningPortAdapter(deps.learningRepo ?? new StubLearningRepository(), deps.appName),
    ...(deps.reflector ? { reflector: deps.reflector } : {}),
    ...(deps.curriculum ? { curriculum: deps.curriculum } : {}),
    ...(deps.processAudit ? { processAudit: deps.processAudit } : {}),
  };
}
