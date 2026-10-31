import { REDACTED, SecretLeakError, type RedactionMode, type RedactionPort, type SecretDetection } from "../../qa-engine/src/shared-kernel/ports/redaction.port";
import { PatternRedactionAdapter } from "../../qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter";
import { activeEnvironment } from "../settings/active";

/*
 * The shell's redaction: the engine's pattern policy (PatternRedactionAdapter) plus the orchestrator's own
 * environment secrets, replaced by value before the patterns look. Mode "issue" (default) is the public
 * egress; "model" is narrower so code-shaped diffs (type annotations, call expressions) are not over-redacted.
 */
export { SecretLeakError };

const patterns = new PatternRedactionAdapter();

const ENV_SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS)$/;
const MIN_ENV_SECRET_LEN = 6;

function envSecretValues(env: Record<string, string | undefined>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= MIN_ENV_SECRET_LEN && ENV_SECRET_NAME.test(name)) values.push(value);
  }
  /* Longest first so a secret value that is itself a substring of another is fully masked. */
  return values.sort((a, b) => b.length - a.length);
}

function stripEnvValues(text: string, env: Record<string, string | undefined>): string {
  let out = text;
  for (const value of envSecretValues(env)) {
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  return out;
}


/*
 * Source code as the lead's code-graph tool shows it: the orchestrator's environment secrets by value, the run's own secrets by
 * value and real secret literals by pattern, with the same model-mode policy as the change dossier (source shown to a model).
 * The Issue-bound policy would also rewrite code that only names a secret (`const token = this.auth.getToken()`), deforming the
 * very source the tool exists to show.
 */
export function redactSourceForModel(text: string, env: Record<string, string | undefined> = activeEnvironment()): string {
  return patterns.redact(stripEnvValues(text, env), "model");
}

export class RedactionPortAdapter implements RedactionPort {
  constructor(private readonly env: Record<string, string | undefined> = activeEnvironment()) {}

  redact(text: string, mode: RedactionMode = "issue"): string {
    return patterns.redact(stripEnvValues(text, this.env), mode);
  }

  detect(text: string, mode: RedactionMode = "issue"): SecretDetection {
    return patterns.detect(stripEnvValues(text, this.env), mode);
  }


  redactText(text: string): string {
    return this.redact(text);
  }

  redactError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return this.redact(raw);
  }

  containsSecret(text: string, mode: RedactionMode = "issue"): boolean {
    return patterns.containsSecret(text, mode);
  }
}
