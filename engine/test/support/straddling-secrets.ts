/* Synthetic secrets (nothing here is a credential) in the forms redaction must take out whole, and builders that put one across the cut of a bound: the fixture of every test that proves a bound never keeps a prefix or a suffix of a secret. */
import { createRunSecretScope, withRunSecretScope } from "../../src/shared-kernel/run-secret-redaction.ts";

export const RUN_PASS = "violet cobalt meadow seventeen";
export const RUN_SPECIAL = `Gr&en"Lake<42> 'Moon`;

const html = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const json = (v: string) => JSON.stringify(v).slice(1, -1);
const hex = (v: string) => Buffer.from(v, "utf8").toString("hex");

const PEM_BODY = Array.from({ length: 20 }, (_, i) => Buffer.from(Array.from({ length: 48 }, (_, j) => ((i * 48 + j) * 7) % 251)).toString("base64")).join("\n") + "\nQk1zZ3hQcm9iZQ==";
export const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`;

export interface SecretCase {
  name: string;
  text: string;
  /* Pieces of the secret that must not appear in any output. */
  fragments: string[];
}

const grams = (s: string, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  return out;
};

export const CASES: SecretCase[] = [
  { name: "run secret, multi-word", text: RUN_PASS, fragments: ["violet", "cobalt", "meadow", "seventeen", "olet co", "eadow s"] },
  { name: "run secret, html spelling", text: html(RUN_SPECIAL), fragments: grams(html(RUN_SPECIAL), 6) },
  { name: "run secret, json spelling", text: json(RUN_SPECIAL), fragments: grams(json(RUN_SPECIAL), 6) },
  { name: "run secret, url spelling", text: encodeURIComponent(RUN_SPECIAL), fragments: grams(encodeURIComponent(RUN_SPECIAL), 6) },
  { name: "run secret, hex spelling", text: hex(RUN_SPECIAL), fragments: grams(hex(RUN_SPECIAL), 8) },
  { name: "bearer token", text: "Authorization: Bearer Zq9tLm2vRx8kPw4nHy6cBd3fGj7sTu5a", fragments: grams("Zq9tLm2vRx8kPw4nHy6cBd3fGj7sTu5a", 5) },
  { name: "PEM block", text: PEM, fragments: grams(PEM_BODY.replaceAll("\n", ""), 10).filter((_, i) => i % 7 === 0) },
  { name: "quoted password", text: `password="amber falcon river twelve"`, fragments: ["amber", "falcon", "river", "twelve"] },
  { name: "URL userinfo", text: "https://qauser:Pl8inPassw0rdX@dev.example.test/login", fragments: grams("Pl8inPassw0rdX", 5) },
];

export const leaks = (out: string, c: SecretCase): string[] => c.fragments.filter((f) => out.includes(f));

/* Word-like filler: a run of one repeated character trips the entropy redaction and would hide the cut. */
export const filler = (chars: number): string => "the change reworks the page header layout and ".repeat(Math.max(0, Math.ceil(chars / 46) + 1)).slice(0, Math.max(0, chars));

/* Base64 text of `n` characters: what the entropy redaction takes out, and so what shrinks a window. */
export const base64Run = (n: number): string =>
  Buffer.from(Array.from({ length: Math.ceil(n * 0.75) + 3 }, (_, i) => (i * 37 + 11) % 256))
    .toString("base64")
    .replace(/=+$/, "")
    .slice(0, n);

/* `secret` starts `inside` characters before `bound`: a cut-then-redact keeps `inside` characters of it. */
export const headStraddle = (secret: string, bound: number, inside: number, sep = " "): string => `${filler(bound - inside - sep.length)}${sep}${secret} ${filler(400)}`;
/* `secret` ends `inside` characters after the start of a tail of `keep` characters. */
export const tailStraddle = (secret: string, keep: number, inside: number): string => `${filler(400)} ${secret} ${filler(keep - inside - 1)}`;

export const insides = (secret: string): number[] => [...new Set([6, Math.floor(secret.length / 2), secret.length - 3].filter((n) => n > 0 && n < secret.length))];

/* Runs `fn` inside a run scope that holds the two run secrets above. */
export function withRunSecrets<T>(fn: () => T): T {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([RUN_PASS, RUN_SPECIAL]);
  return withRunSecretScope(scope, fn);
}
