import type { LearningRule } from "../../domain/learning-repository.ts";

/** What the quarantine command needs of the learning store: every rule of the app (retired ones included) and a way to set some aside. */
export interface LearningQuarantinePort {
  listAll(app: string, limit: number): Promise<LearningRule[]>;
  /** Marks the app's rules by id as quarantined at `at`; those already quarantined are left as they are. Returns how many it newly marked. */
  quarantine(app: string, ids: readonly string[], at: string): Promise<number>;
}
