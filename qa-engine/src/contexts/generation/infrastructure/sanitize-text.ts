/* Prompt-side secret redaction. Twin of src/orchestrator/sanitizer.ts — qa-engine must not import src/; the regex set is duplicated here and sanitize-text-parity.test.ts keeps both in lockstep. Post-redaction fail-loud: if a secret is still detectable, throw SecretLeakError rather than sending it. */

import { REDACTED, SecretLeakError, type RedactionPort } from "@kernel/ports/redaction.port.ts";

export interface SecretDetection {
  redacted: boolean;
  patterns: string[];
  count: number; /* total redactions across all patterns */
}


/** "issue" (default) is the aggressive Issue-bound policy. "model" narrows api-key-assignment to a quoted literal or a high-entropy bare token so a diff→model prompt keeps code shapes like `password: string`. */
export type SanitizeMode = "issue" | "model";

const CODE_KEYWORDS = new Set([
  "string", "number", "boolean", "undefined", "null", "any", "unknown", "never", "void", "object",
  "true", "false",
]);
function looksLikeCallExpression(value: string): boolean {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\(.*\)$/.test(value);
}
function isHighEntropyBareToken(value: string): boolean {
  const trimmed = value.replace(/[;,)]+$/, "");
  if (trimmed.length < 12) return false;
  if (CODE_KEYWORDS.has(trimmed.toLowerCase())) return false;
  if (looksLikeCallExpression(trimmed)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return false;
  const hasDigit = /[0-9]/.test(trimmed);
  const hasUpper = /[A-Z]/.test(trimmed);
  const hasLower = /[a-z]/.test(trimmed);
  return hasDigit && hasUpper && hasLower;
}
const ASSIGNMENT_VALUE_RE = /[\"']?\s*[:=]\s*(\S+)$/;
function isModelModeSecretValue(match: string): boolean {
  const m = ASSIGNMENT_VALUE_RE.exec(match);
  const value = m?.[1] ?? "";
  if (!value) return false;
  if (/^["'`]/.test(value)) return true; /* quoted literal is the deliberate secret shape */
  return isHighEntropyBareToken(value);
}

const NAMED_SECRET_PATTERNS: Array<{ name: string; p: RegExp; skip?: (m: string) => boolean; modelSkip?: (m: string) => boolean }> = [
  { name: "slack-webhook", p: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { name: "stripe-key", p: /\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+\b/g },
  { name: "aws-access-key", p: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-token", p: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "github-token-fg", p: /\bgithub_pat_[A-Za-z0-9_]{36,}\b/g },
  { name: "llm-api-key", p: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "slack-token", p: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "url-credentials", p: /(?<=:\/\/)[^\s:/@]+:[^\s:/@]+(?=@)/g },
  /* Bearer tokens in command output. Bare-value capture is greedy `\S+` so an embedded quote inside the secret is not leaked; redactPreservingTrailingQuote re-emits a trailing quote only when it is unbalanced (belongs to enclosing prose). Quoted branches are escape-aware. Keep in lockstep with src/orchestrator/sanitizer.ts. */
  { name: "bearer-token", p: /(?:Authorization|auth)\s*[:=]\s*Bearer\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi },
  { name: "jwt", p: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: "private-key-pem", p: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g },
  { name: "api-key-query", p: /\b[?&](?:token|key|api_key|api-key|apiKey|secret)=[^&\s]+/gi },
  { name: "generic-credential", p: /(?:credential|auth_token|access_key)[\"']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi },
  { name: "env-credential", p: /\b[A-Z][A-Z0-9_]*(?:PASS|PASSWORD|SECRET|TOKEN|KEY|PWD|CRED|CREDENTIAL)[A-Z0-9_]*[\"']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/g },
  { name: "api-key-assignment", p: /(?:api[_-]?key|token|secret|password|passwd|pwd)[\"']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi, modelSkip: (m) => !isModelModeSecretValue(m) },
  /* base64-encoded secrets (>40 chars), with data-URI filter. skip: a run of pure hex is a git SHA / digest, not a secret. */
  {
    /* Negative lookbehinds exclude lockfile integrity hashes (`sha512-<base64>`): their body is not a secret. skip still drops pure-hex runs (git SHAs). */
    name: "base64-secret",
    p: /(?<![A-Za-z0-9+/=])(?<!sha1-)(?<!sha256-)(?<!sha384-)(?<!sha512-)[A-Za-z0-9+/=]{40,}(?![A-Za-z0-9+/=])/g,
    skip: (m) => /^[0-9a-f]+$/i.test(m) || isPathLikeRun(m),
  },
];

/* A ≥40-char [A-Za-z0-9+/=] run also matches real code (paths with `/`, long camelCase identifiers). Escapes requiring no `+`/`=`: a PATH (≥3 slashes) or a camelCase/PascalCase identifier (word segments ≥2, at least one ≥3). Twin of src/orchestrator/sanitizer.ts — keep in lockstep. */
const MAX_IDENTIFIER_LEN = 64;
const CASE_TRANSITION_RE = /[a-z][A-Z]/;
const WORD_SEGMENT_RE = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g;
function isIdentifierShape(m: string): boolean {
  if (m.length > MAX_IDENTIFIER_LEN) return false;
  if (/[0-9]/.test(m)) return false;
  if (!CASE_TRANSITION_RE.test(m)) return false;
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

/* Greedy `\S+` may swallow a trailing quote that is the secret's own character or that belongs to enclosing prose. If that quote already appears in the body, it is part of the secret; if not, re-emit it so surrounding markup is not corrupted. */
function redactPreservingTrailingQuote(m: string): string {
  const last = m[m.length - 1];
  if (last === '"' || last === "'") {
    const body = m.slice(0, -1);
    if (!body.includes(last)) return REDACTED + last;
  }
  return REDACTED;
}

const INTERNAL_HOST_PATTERNS: RegExp[] = [
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
];

/* PII: email only. Broader patterns (phone numbers) would wreck diffs/code with false positives; an email is distinctive enough to redact safely. */
const PII_PATTERNS: RegExp[] = [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g];

export function sanitizeText(input: string, mode: SanitizeMode = "issue"): { text: string; detection: SecretDetection } {
  if (!input) return { text: input, detection: { redacted: false, patterns: [], count: 0 } };

  let out = input;
  const matchedPatterns: string[] = [];
  let totalRedactions = 0;

  const DATA_URI_RE = /data:[^;]+;base64,[A-Za-z0-9+/=]+/gi;
  const dataUris: string[] = [];
  out = out.replace(DATA_URI_RE, (m) => {
    dataUris.push(m);
    return `__SANITIZER_DATAURI_${dataUris.length - 1}__`;
  });

  for (const { name, p, skip, modelSkip } of NAMED_SECRET_PATTERNS) {
    let redactions = 0;
    out = out.replace(p, (m) => {
      if (skip?.(m)) return m;
      if (mode === "model" && modelSkip?.(m)) return m;
      redactions++;
      return redactPreservingTrailingQuote(m);
    });
    if (redactions > 0) {
      matchedPatterns.push(name);
      totalRedactions += redactions;
    }
  }

  out = out.replace(/__SANITIZER_DATAURI_(\d+)__/g, (_, i) => dataUris[Number(i)] ?? "");

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

/** True when a secret is still detectable. Resets /g lastIndex so repeated calls stay deterministic. Mirrors sanitizeText's skip decision, including model-mode. */
export function containsSecrets(text: string, mode: SanitizeMode = "issue"): boolean {
  if (!text) return false;
  const masked = text.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/gi, "");
  for (const { p, skip, modelSkip } of NAMED_SECRET_PATTERNS) {
    p.lastIndex = 0;
    const hasConditionalSkip = Boolean(skip) || (mode === "model" && Boolean(modelSkip));
    if (hasConditionalSkip) {
      const ms = masked.match(p);
      const isRealSecret = (m: string): boolean => !(skip?.(m) ?? false) && !(mode === "model" && modelSkip?.(m));
      if (ms?.some(isRealSecret)) return true;
    } else if (p.test(masked)) {
      return true;
    }
  }
  return false;
}

/** Post-redaction fail-loud guard. If a secret is still detectable, throw SecretLeakError — never send it. Same kernel error type as the src/orchestrator twin. */
export function assertNoSecretLeak(redactedText: string, mode: SanitizeMode, boundary: string): void {
  if (containsSecrets(redactedText, mode)) {
    console.error(`[sanitizer] ${boundary}: a secret survived redaction — refusing to proceed`);
    throw new SecretLeakError(`${boundary}: a secret survived redaction — refusing to proceed`);
  }
}

/** RedactionPort view of this module. containsSecret reuses sanitizeText's detection pass. Twin of src/orchestrator/sanitizer.ts's adapter. */
export const redactionAdapter: RedactionPort = {
  redact: (text: string): string => sanitizeText(text).text,
  containsSecret: (text: string): boolean => sanitizeText(text).detection.redacted,
};
