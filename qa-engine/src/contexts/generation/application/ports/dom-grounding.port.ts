import type { Objective } from "@kernel/objective.ts";
import type { DomGrounding } from "../../domain/manifest-repository.ts";

export interface DomGroundingPort {
  ground(objective: Objective): Promise<DomGrounding>;
}
