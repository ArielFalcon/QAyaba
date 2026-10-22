/*
 * The static gate's checks as spans: one `qayaba.validate.check` per check (typecheck, lint, list, manifest), a child of the phase that is open,
 * with whether it passed and how many errors it reported. The checks run in parallel, so each span is opened with an explicit parent and not
 * from the active context. A decorator over the checks: what a check returns is returned as it was.
 */

import { startRunChildSpan } from "../../../shared-infrastructure/telemetry/run-spans.ts";
import type { TelemetryPort } from "../../../shared-kernel/telemetry/telemetry.port.ts";
import type { CheckResult } from "../application/ports/index.ts";
import type { ValidateDeps } from "./static-gate.checks.ts";

export type ValidateCheckName = "typecheck" | "lint" | "list" | "manifest";

const TSC_ERROR = /\berror TS\d+/g;
const ESLINT_SUMMARY = /✖ \d+ problems? \((\d+) errors?/;
const ESLINT_LINE = /^\s*\d+:\d+\s+error\b/gm;
const PLAYWRIGHT_ERROR = /^\s*Error:/gm;

const matches = (re: RegExp, text: string): number => text.match(re)?.length ?? 0;

/* How many errors a failed check reported, from its output; zero for a check that passed. A failure whose output no rule counts is one error. */
export function countCheckErrors(check: ValidateCheckName, result: CheckResult): number {
  if (result.ok) return 0;
  const output = result.output;
  let counted = 0;
  switch (check) {
    case "typecheck":
      counted = matches(TSC_ERROR, output);
      break;
    case "lint": {
      const summary = ESLINT_SUMMARY.exec(output);
      counted = summary ? Number(summary[1]) : matches(ESLINT_LINE, output);
      break;
    }
    case "list":
      counted = matches(PLAYWRIGHT_ERROR, output);
      break;
    case "manifest":
      counted = output.split("\n").filter((line) => line.trim() !== "").length;
      break;
  }
  return counted > 0 ? counted : 1;
}

export function traceValidateDeps(deps: ValidateDeps, telemetry: TelemetryPort): ValidateDeps {
  const traced = (check: ValidateCheckName, run: (specDir: string) => Promise<CheckResult>) => async (specDir: string): Promise<CheckResult> => {
    const span = startRunChildSpan(telemetry, "qayaba.validate.check", { "qayaba.validate.check": check });
    try {
      const result = await run(specDir);
      span.setAttrs({
        "qayaba.validate.ok": result.ok,
        "qayaba.validate.errors": countCheckErrors(check, result),
        ...(result.infra === true ? { "qayaba.validate.infra": true } : {}),
      });
      span.end();
      return result;
    } catch (err) {
      span.recordError(err);
      span.end();
      throw err;
    }
  };
  return {
    typecheck: traced("typecheck", deps.typecheck),
    lint: traced("lint", deps.lint),
    listTests: traced("list", deps.listTests),
    checkManifest: traced("manifest", deps.checkManifest),
  };
}
