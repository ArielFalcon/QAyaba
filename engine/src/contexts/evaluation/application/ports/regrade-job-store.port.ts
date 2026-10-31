import type { RegradeJob } from "../../domain/evidence.ts";

export interface RegradeJobStorePort {
  create(job: RegradeJob): void;
  update(job: RegradeJob): void;
  get(jobId: string): RegradeJob | undefined;
}
