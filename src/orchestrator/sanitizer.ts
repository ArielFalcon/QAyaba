
import { REDACTED, SecretLeakError, type RedactionPort } from "../../qa-engine/src/shared-kernel/ports/redaction.port";

/*
 * Sanitize data leaving the system — execution logs → Issue. Secrets are injected at
 * runtime by Doppler, never committed. Mode "issue" (default) is the public egress;
 * "model" is narrower so code-shaped diffs (type annotations, call expressions) are not over-redacted.
 */
export { SecretLeakError };

export interface SecretDetection {
  redacted: boolean;
  patterns: string[];  /* which named patterns matched */
  count: number;  /* total redactions across all patterns */
}

/*
 * Two-tier policy: Issue bodies get maximum scrubbing; "model" narrows only api-key-assignment
 * to quoted literals or high-entropy bare tokens so ordinary code is not mangled.
 */
export type SanitizeMode = "issue" | "model";

/*
 * A bare (unquoted) value is "high-entropy" enough to treat as a real secret in "model" mode when it
 * looks nothing like ordinary code: mixed case AND at least one digit, length >= 12, and not one of
 * the common type/literal keywords a type annotation or default value would use. This deliberately
 * does NOT try to be a general-purpose entropy estimator — it only needs to separate "getToken()"/
 * "string"/"undefined" (code) from "aZ9kP2mQ7xR4tL6vB8nH1cJ3s" (a real-looking secret blob).
 */
const CODE_KEYWORDS = new Set([
  "string", "number", "boolean", "undefined", "null", "any", "unknown", "never", "void", "object",
  "true", "false",
]);
function looksLikeCallExpression(value: string): boolean {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\(.*\)$/.test(value);
}
function isHighEntropyBareToken(value: string): boolean {
  const trimmed = value.replace(/[;,)]+$/, "");  /* strip trailing statement/call punctuation */
  if (trimmed.length < 12) return false;
  if (CODE_KEYWORDS.has(trimmed.toLowerCase())) return false;
  if (looksLikeCallExpression(trimmed)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return false;  /* not a bare identifier/token shape at all */
  const hasDigit = /[0-9]/.test(trimmed);
  const hasUpper = /[A-Z]/.test(trimmed);
  const hasLower = /[a-z]/.test(trimmed);
  return hasDigit && hasUpper && hasLower;
}
/*
 * The model-mode replacer for the api-key-assignment pattern: only redact when the captured value
 * (everything after the `key`/`token`/`password`=... separator) is a quoted literal or a high-entropy
 * bare token — never a type annotation or a bare call expression. Re-parses the match instead of
 * widening the regex itself, so the aggressive "issue" pattern stays untouched (single shared pattern
 * object below; only the skip/keep decision differs by mode).
 */
const ASSIGNMENT_VALUE_RE = /[\"']?\s*[:=]\s*(\S+)$/;
function isModelModeSecretValue(match: string): boolean {
  const m = ASSIGNMENT_VALUE_RE.exec(match);
  const value = m?.[1] ?? "";
  if (!value) return false;
  if (/^["'`]/.test(value)) return true; /* a quoted literal is the deliberate secret shape */
  return isHighEntropyBareToken(value);
}

/* Named secret patterns. More specific first. modelSkip applies only in "model" mode. */
const NAMED_SECRET_PATTERNS: Array<{ name: string; p: RegExp; skip?: (m: string) => boolean; modelSkip?: (m: string) => boolean }> = [
  /* Slack webhook URLs — very specific; match before generic URL patterns */
  { name: "slack-webhook", p: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  /* Stripe keys: sk_/pk_ prefixed, test or live */
  { name: "stripe-key", p: /\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+\b/g },
  /* AWS access key id — AKIA + 16 uppercase alphanumeric */
  { name: "aws-access-key", p: /\bAKIA[0-9A-Z]{16}\b/g },
  /* GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ with 36+ chars */
  { name: "github-token", p: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  /* GitHub fine-grained tokens: github_pat_ with 36+ chars */
  { name: "github-token-fg", p: /\bgithub_pat_[A-Za-z0-9_]{36,}\b/g },
  /*
   * LLM-provider keys: OpenAI/Anthropic `sk-...` (sk-proj-…, sk-ant-api03-…). Bare-value
   * form (no adjacent credential keyword), which the assignment patterns below miss. The
   * {20,} body keeps it off short hyphenated identifiers while every real key is far longer.
   */
  { name: "llm-api-key", p: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  /* Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xoxs- */
  { name: "slack-token", p: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  /*
   * Credentials embedded in a connection string / URL: scheme://user:password@host. Match
   * only the user:password span (lookbehind ://, lookahead @) so the host stays readable;
   * requires the inner ':' so a bare scheme://host@ (no password) is left intact.
   */
  { name: "url-credentials", p: /(?<=:\/\/)[^\s:/@]+:[^\s:/@]+(?=@)/g },
  { name: "bearer-token", p: /(?:Authorization|auth)\s*[:=]\s*Bearer\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi },
  /* JWT: three base64url segments separated by dots */
  { name: "jwt", p: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  /* PEM private key blocks */
  { name: "private-key-pem", p: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g },
  /* API keys in query strings */
  { name: "api-key-query", p: /\b[?&](?:token|key|api_key|api-key|apiKey|secret)=[^&\s]+/gi },
  /* credential/auth_token/access_key assignments; [\"']? covers JSON "password": "…" */
  { name: "generic-credential", p: /(?:credential|auth_token|access_key)[\"']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi },
  /* UPPER_SNAKE env names ending in a credential word — the catch-all below misses PASS/KEY as a suffix */
  { name: "env-credential", p: /\b[A-Z][A-Z0-9_]*(?:PASS|PASSWORD|SECRET|TOKEN|KEY|PWD|CRED|CREDENTIAL)[A-Z0-9_]*[\"']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/g },
  /* Catch-all last. modelSkip: skip type annotations and call expressions (password: string, token = getToken()). */
  { name: "api-key-assignment", p: /(?:api[_-]?key|token|secret|password|passwd|pwd)[\"']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi, modelSkip: (m) => !isModelModeSecretValue(m) },
  {
    /*
     * The negative lookbehinds exclude lockfile INTEGRITY hashes (npm/yarn `sha512-<base64>`,
     * `sha1-`, …): their base64 body is not a secret, and redacting it corrupts the diff the
     * model reads. The skip still drops pure-hex runs (git SHAs / digests).
     */
    name: "base64-secret",
    p: /(?<![A-Za-z0-9+/=])(?<!sha1-)(?<!sha256-)(?<!sha384-)(?<!sha512-)[A-Za-z0-9+/=]{40,}(?![A-Za-z0-9+/=])/g,
    skip: (m) => /^[0-9a-f]+$/i.test(m) || isPathLikeRun(m),
  },
];


const MAX_IDENTIFIER_LEN = 64;
const CASE_TRANSITION_RE = /[a-z][A-Z]/;
const WORD_SEGMENT_RE = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g;
function isIdentifierShape(m: string): boolean {
  if (m.length > MAX_IDENTIFIER_LEN) return false;
  if (/[0-9]/.test(m)) return false;  /* digits present — a random secret blob commonly carries them; */
  /* this narrow escape only needs to cover the pure-letter camelCase/PascalCase shape. */
  if (!CASE_TRANSITION_RE.test(m)) return false;  /* uniform case run — no words, not an identifier */
  const segments = m.match(WORD_SEGMENT_RE) ?? [];
  return segments.length > 0 && segments.every((s) => s.length >= 2) && segments.some((s) => s.length >= 3);
}
function isPathLikeRun(m: string): boolean {
  if (m.includes("+") || m.includes("=")) return false;
  if (!m.includes("/")) return isIdentifierShape(m);
  const segments = m.split("/");
  if (segments.length < 4) return false;
  return segments.every((s) => s.length >= 1 && s.length <= 80);
}


function redactPreservingTrailingQuote(m: string): string {
  const last = m[m.length - 1];
  if (last === '"' || last === "'") {
    const body = m.slice(0, -1);
    if (!body.includes(last)) return REDACTED + last;
  }
  return REDACTED;
}

const INTERNAL_HOST_PATTERNS: RegExp[] = [
  /* Private IPv4 ranges (10/8, 192.168/16, 172.16/12) */
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
];

/*
 * PII: email only. Broader patterns (phone numbers) would wreck diffs/code with
 * false positives; an email is distinctive enough to redact safely.
 */
const PII_PATTERNS: RegExp[] = [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g];

export function sanitizeText(input: string, mode: SanitizeMode = "issue"): { text: string; detection: SecretDetection } {
  if (!input) return { text: input, detection: { redacted: false, patterns: [], count: 0 } };

  let out = input;
  const matchedPatterns: string[] = [];
  let totalRedactions = 0;

  /* pre‑filter: mask data URIs to avoid base64 false positives */
  const DATA_URI_RE = /data:[^;]+;base64,[A-Za-z0-9+/=]+/gi;
  const dataUris: string[] = [];
  out = out.replace(DATA_URI_RE, (m) => {
    dataUris.push(m);
    return `__SANITIZER_DATAURI_${dataUris.length - 1}__`;
  });

  /* secret patterns */
  for (const { name, p, skip, modelSkip } of NAMED_SECRET_PATTERNS) {
    let redactions = 0;
    out = out.replace(p, (m) => {
      if (skip?.(m)) return m;  /* a recognised non-secret (e.g. a git SHA) — leave it intact */
      if (mode === "model" && modelSkip?.(m)) return m;  /* model-mode-only: not a real secret shape */
      redactions++;
      return redactPreservingTrailingQuote(m);
    });
    if (redactions > 0) {
      matchedPatterns.push(name);
      totalRedactions += redactions;
    }
  }

  /* restore data URIs */
  out = out.replace(/__SANITIZER_DATAURI_(\d+)__/g, (_, i) => dataUris[Number(i)] ?? "");

  /* host / PII */
  for (const p of INTERNAL_HOST_PATTERNS) out = out.replace(p, REDACTED);
  for (const p of PII_PATTERNS) out = out.replace(p, REDACTED);

  return {
    text: out,
    detection: {
      redacted: totalRedactions > 0,
      patterns: matchedPatterns,
      count: totalRedactions,
    },
  };
}


export function containsSecrets(text: string, mode: SanitizeMode = "issue"): boolean {
  if (!text) return false;
  const masked = text.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/gi, "");
  for (const { p, skip, modelSkip } of NAMED_SECRET_PATTERNS) {
    /*
     * These are module-level /g regexes; .test()/.exec() advance and persist lastIndex,
     * which would make repeated calls alternate — reset so detection is deterministic.
     */
    p.lastIndex = 0;
    const hasConditionalSkip = Boolean(skip) || (mode === "model" && Boolean(modelSkip));
    if (hasConditionalSkip) {
      /*
       * Only a match that neither `skip` (a recognised non-secret, e.g. a git SHA) nor, in "model"
       * mode, `modelSkip` (an ordinary code shape — a type annotation, a bare call expression)
       * excuses counts as a real secret.
       */
      const ms = masked.match(p);
      const isRealSecret = (m: string): boolean => !(skip?.(m) ?? false) && !(mode === "model" && modelSkip?.(m));
      if (ms?.some(isRealSecret)) return true;
    } else if (p.test(masked)) {
      return true;
    }
  }
  return false;
}


export function assertNoSecretLeak(redactedText: string, mode: SanitizeMode, boundary: string): void {
  if (containsSecrets(redactedText, mode)) {
    console.error(`[sanitizer] ${boundary}: a secret survived redaction — refusing to proceed`);
    throw new SecretLeakError(`${boundary}: a secret survived redaction — refusing to proceed`);
  }
}

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


export class RedactionPortAdapter implements RedactionPort {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  redact(text: string): string {
    return sanitizeText(stripEnvValues(text, this.env)).text;
  }

  
  redactText(text: string): string {
    return this.redact(text);
  }

  redactError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return this.redact(raw);
  }

  containsSecret(text: string): boolean {
    return containsSecrets(text);
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
