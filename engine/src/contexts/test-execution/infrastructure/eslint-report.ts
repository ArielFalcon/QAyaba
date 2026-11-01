import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { errorDiagnostics, type GateDiagnostic } from "../domain/gate-diagnostic.ts";

const ESLINT_ERROR_SEVERITY = 2;

/* The linter names files by the directory as its process sees it, which may be the resolved one. */
export function suiteBases(specDir: string): string[] {
  try {
    return [specDir, realpathSync(specDir)];
  } catch {
    return [specDir];
  }
}

function suiteRelative(filePath: string, bases: readonly string[]): string {
  const inside = bases.map((base) => relative(base, filePath).split(sep).join("/")).find((rel) => rel !== "" && !rel.startsWith("../") && rel !== "..");
  return inside ?? filePath;
}

/* The problems of ESLint's JSON report, in the order the tool emits them. Undefined when the output is not a report. */
export function readLintReport(output: string, specDir: string): GateDiagnostic[] | undefined {
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(report)) return undefined;
  const bases = suiteBases(specDir);
  const diagnostics: GateDiagnostic[] = [];
  for (const entry of report) {
    const { filePath, messages } = (entry ?? {}) as { filePath?: unknown; messages?: unknown };
    if (typeof filePath !== "string" || !Array.isArray(messages)) return undefined;
    const file = suiteRelative(filePath, bases);
    for (const raw of messages) {
      const m = (raw ?? {}) as { ruleId?: unknown; severity?: unknown; message?: unknown; line?: unknown; column?: unknown };
      diagnostics.push({
        file,
        severity: m.severity === ESLINT_ERROR_SEVERITY ? "error" : "warning",
        ...(typeof m.ruleId === "string" ? { rule: m.ruleId } : {}),
        line: typeof m.line === "number" ? m.line : 0,
        column: typeof m.column === "number" ? m.column : 0,
        message: typeof m.message === "string" ? m.message : "",
      });
    }
  }
  return diagnostics;
}

/* The text of a report for the agent: one line per problem under its file, then the totals. */
export function renderLintReport(diagnostics: readonly GateDiagnostic[]): string {
  const lines: string[] = [];
  let current: string | undefined;
  for (const d of diagnostics) {
    if (d.file !== current) {
      if (current !== undefined) lines.push("");
      lines.push(d.file);
      current = d.file;
    }
    lines.push(`  ${d.line}:${d.column}  ${d.severity}  ${d.message}${d.rule ? `  ${d.rule}` : ""}`);
  }
  const errors = errorDiagnostics(diagnostics).length;
  const warnings = diagnostics.length - errors;
  lines.push("", `✖ ${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})`);
  return lines.join("\n");
}
