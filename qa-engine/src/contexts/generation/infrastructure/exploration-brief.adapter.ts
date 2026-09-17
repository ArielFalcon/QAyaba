
export interface BlastNode {
  symbol: string;
  file: string;
  role: string;
}

export interface FeBeFact {
  route: string;
  operationId: string;
  via?: string;
}

export interface ContractFact {
  operationId: string;
  method: string;
  path: string;
  fields?: string[];
  errors?: string[];
}

export interface RouteRecon {
  path: string;
  component?: string;
  domLandmarks?: string[];
  verified: boolean;
}

export interface ExplorationBrief {
  builtForSha: string;
  objective: string;
  blastRadius: BlastNode[];
  feBe?: FeBeFact[];
  contracts?: ContractFact[];
  routes?: RouteRecon[];
  risks?: string[];
  notes?: string;
}

export interface BriefFns {
  parseExplorationBrief(text: string): ExplorationBrief | null;
  coerceExplorationBrief(raw: unknown): ExplorationBrief | null;
  renderExplorationBrief(brief: ExplorationBrief, opts?: { suppressFeBe?: boolean }): string;
}

export class ExplorationBriefAdapter {
  constructor(private readonly fns: BriefFns) {}

  parse(text: string): ExplorationBrief | null {
    return this.fns.parseExplorationBrief(text);
  }

  coerce(raw: unknown): ExplorationBrief | null {
    return this.fns.coerceExplorationBrief(raw);
  }

  render(brief: ExplorationBrief, opts?: { suppressFeBe?: boolean }): string {
    return this.fns.renderExplorationBrief(brief, opts);
  }
}
