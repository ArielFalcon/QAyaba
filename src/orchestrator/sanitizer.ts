import { REDACTED, SecretLeakError, type RedactionMode, type RedactionPort, type SecretDetection } from "../../qa-engine/src/shared-kernel/ports/redaction.port";
import { PatternRedactionAdapter } from "../../qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter";

/*
 * The shell's redaction: the engine's pattern policy (PatternRedactionAdapter) plus the orchestrator's own
 * environment secrets, replaced by value before the patterns look. Mode "issue" (default) is the public
 * egress; "model" is narrower so code-shaped diffs (type annotations, call expressions) are not over-redacted.
 */
export { SecretLeakError };

const patterns = new PatternRedactionAdapter();

export const SECRET_AUDIT = new Map<string, number>();
/*
 * The audit map is an in-memory diagnostic that nothing reads back into a decision, so it must
 * not grow without bound over a long-lived process. Cap it and evict in insertion order.
 */
export const SECRET_AUDIT_MAX = 500;

export function recordAudit(runId: string, detection: SecretDetection): void {
  if (detection.redacted) {
    SECRET_AUDIT.set(runId, detection.count);
    while (SECRET_AUDIT.size > SECRET_AUDIT_MAX) {
      const oldest = SECRET_AUDIT.keys().next().value;
      if (oldest === undefined) break;
      SECRET_AUDIT.delete(oldest);
    }
  }
}


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
export function redactSourceForModel(text: string, env: Record<string, string | undefined> = process.env): string {
  return patterns.redact(stripEnvValues(text, env), "model");
}

export class RedactionPortAdapter implements RedactionPort {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

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


export const MAX_PROMPT_BODY_CHARS = 4_000;


export function capText(text: string, maxChars: number = MAX_PROMPT_BODY_CHARS): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n[…body truncated: ${text.length - maxChars} more chars; read the full message with \`git show <sha>\`.]`
  );
}
