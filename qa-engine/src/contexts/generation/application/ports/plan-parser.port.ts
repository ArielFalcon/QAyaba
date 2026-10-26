import type { PlanObjectiveView } from "../../domain/manifest-repository.ts";

export interface PlanParserPort { parse(text: string): PlanObjectiveView[]; }
