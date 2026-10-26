/** The context map as the run ports carry it. Generation's own ArchitectureContext is structurally assignable to this one. */
export interface ArchitectureContext {
  builtAtSha: string;
  routes: Array<{ path: string; name?: string; component?: string; source?: string; implementationFiles?: string[] }>;
  api: Array<{ operationId: string; method: string; path: string; service?: string; spec?: string }>;
  feBe: Array<{ route: string; operationId: string; via?: string }>;
  flows?: Array<{ id: string; routes: string[]; operations?: string[] }>;
}

/** The harness facts as the run ports carry them. Generation's own HarnessFacts is structurally assignable to this one. */
export interface HarnessFacts {
  /** Only when the app declares one: no default is invented. */
  testIdAttribute?: string;
  fixtures?: { file: string; exports: readonly string[] };
}

/** What a grounding step left out of the context it built, and why. */
export interface GroundingOmission {
  class: "selection" | "truncation";
  reason: string;
  count: number;
}
