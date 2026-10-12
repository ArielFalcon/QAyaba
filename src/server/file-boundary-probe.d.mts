export interface ProbeOps {
  readFile(path: string): void;
  list(path: string): void;
  kind(path: string): "dir" | "file" | "other";
  createIn(dir: string): void;
  openForWrite(path: string): void;
}
export interface Probe {
  kind: "read" | "list" | "write";
  path: string;
}
export interface Observation {
  kind?: "dir" | "file" | "other";
  code: string | null;
}
export declare const realOps: ProbeOps;
export declare function observeProbe(probe: Probe, ops?: ProbeOps): Observation;
export declare function observeProbes(probes: readonly Probe[], ops?: ProbeOps): Observation[];
export declare function parsePlan(text: string): Probe[] | undefined;
