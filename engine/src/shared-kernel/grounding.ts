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
  fixtures?: {
    file: string;
    exports: readonly string[];
    /** The exported functions as declared, one line each. */
    signatures?: readonly string[];
    /** The fixtures a test receives, as the file's own type declares them, one line each. */
    members?: readonly string[];
  };
  /** What the suite's Playwright config declares. */
  playwright?: {
    testDir?: string;
    testMatch?: string;
    storageState: boolean;
    projects: readonly { name: string; device?: string; viewport?: string; dependencies?: readonly string[]; testMatch?: string }[];
  };
}

/** What a grounding step left out of the context it built, and why. */
export interface GroundingOmission {
  class: "selection" | "truncation";
  reason: string;
  count: number;
}
