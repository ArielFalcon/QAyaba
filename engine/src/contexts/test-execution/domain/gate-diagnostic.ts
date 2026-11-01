export type GateDiagnosticSeverity = "error" | "warning";

/** One problem the linter reported in a file of the suite. */
export interface GateDiagnostic {
  /** The path relative to the suite directory. */
  file: string;
  severity: GateDiagnosticSeverity;
  /** Absent for a problem no rule raised, such as a file the linter could not parse. */
  rule?: string;
  line: number;
  column: number;
  message: string;
}

export const errorDiagnostics = (diagnostics: readonly GateDiagnostic[]): GateDiagnostic[] => diagnostics.filter((d) => d.severity === "error");

export function diagnosticLocation(d: GateDiagnostic): string {
  return `${d.file}:${d.line}:${d.column}`;
}
