import type { GateDiagnostic } from "../../domain/gate-diagnostic.ts";
import type { ValidationRunInfo } from "../../domain/validation.ts";

export interface ValidationOutcome {
  ok: boolean;
  errors: string[];
  /** Optional: a validation failure may be infrastructure, not a defect of the specs. */
  infra?: boolean;
  /** The linter's problems in typed form, warnings included. Absent: the gate typed none. */
  diagnostics?: GateDiagnostic[];
  /** The entries of `errors` with no typed form. Absent: every entry of `errors`. */
  untypedErrors?: string[];
}

export interface ValidationPort {
  validate(specDir: string, run?: ValidationRunInfo): Promise<ValidationOutcome>;
  /**
   * Applies the linter's own fixes to the delivered specs (`run.deliveredSpecs`) and returns
   * the specs it rewrote. Absent, or a target with no linter fixes: nothing is rewritten.
   */
  autofix?(specDir: string, run: ValidationRunInfo): Promise<string[]>;
}
