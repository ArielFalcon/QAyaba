import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_TEXT_MAX,
  FORM_STATE,
  MAX_RENDERED_REQUESTS,
  renderLoginEvidence,
  scrubSecrets,
  type LoginEvidence,
} from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";
import { PRECONDITION_KIND } from "@contexts/qa-run-orchestration/domain/auth-precondition.ts";

/* Synthetic credentials only. Each password carries something an encoder or a regex would treat specially. */
const USER = "qa.bot+tester@demo.example";
const HOSTILE_PASSWORDS = [
  "p w0rd",
  'q"uote',
  "a&b=c",
  "100%+plus",
  "ünï©ode✓",
  "re.g$ex^(a|b)[c]*?",
  "back\\slash",
  "line\nbreak",
  "it's~(fine)!*",
];

/* Every way a page, a URL, a form body or a JSON body can spell a value back. */
function spellings(secret: string): string[] {
  const percent = encodeURIComponent(secret);
  const form = new URLSearchParams({ k: secret }).toString().slice(2);
  const json = JSON.stringify(secret).slice(1, -1);
  const asciiJson = json.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return [...new Set([secret, percent, form, json, asciiJson])];
}

function evidence(over: Partial<LoginEvidence> = {}): LoginEvidence {
  return {
    ladder: ["/", "/login"],
    form: FORM_STATE.FOUND,
    ladderHadPasswordField: true,
    markers: { captcha: false, secondFactor: false, sso: false },
    challengeVisible: false,
    filled: true,
    submitted: true,
    requests: [{ method: "POST", pathname: "/api/session", status: 401 }],
    inFlightAtDeadline: false,
    pageErrorCount: 0,
    firstPageError: null,
    firstAlert: null,
    submitDisabled: false,
    finalPath: "/login",
    passwordGone: false,
    freshContextPasswordGone: false,
    storageStateWritten: false,
    ...over,
  };
}

test("a secret is removed in its raw, percent-encoded, form-encoded and JSON-escaped spellings, and the text around it stays", () => {
  for (const password of HOSTILE_PASSWORDS) {
    const text = spellings(password).map((spelling, i) => `part${i}=${spelling}`).join(" | ");
    const out = scrubSecrets(text, [password]);
    for (const spelling of spellings(password)) {
      assert.equal(out.includes(spelling), false, `${JSON.stringify(password)} still present as ${JSON.stringify(spelling)}`);
    }
    assert.ok(out.includes("part0="), `${JSON.stringify(password)}: the text around the secret is kept`);
  }
});

test("the user name and the password are both removed from the same text", () => {
  const password = HOSTILE_PASSWORDS[0]!;
  const out = scrubSecrets(`user=${encodeURIComponent(USER)}&pass=${encodeURIComponent(password)} raw ${USER} ${password}`, [USER, password]);
  for (const secret of [USER, password]) {
    for (const spelling of spellings(secret)) assert.equal(out.includes(spelling), false, spelling);
  }
});

test("an empty secret is skipped instead of cutting the text between every character", () => {
  assert.equal(scrubSecrets("nothing to hide", ["", ""]), "nothing to hide");
  const out = scrubSecrets("keep this, hide hunter2", ["", "hunter2"]);
  assert.ok(out.startsWith("keep this, hide "));
  assert.equal(out.includes("hunter2"), false);
});

test("a secret that contains another secret is removed whole, with no fragment of the longer one left", () => {
  const out = scrubSecrets("value: swordfish-2024 end", ["swordfish", "swordfish-2024"]);
  assert.equal(out.includes("2024"), false);
  assert.equal(out.includes("swordfish"), false);
  assert.ok(out.endsWith(" end"));
});

test("a text with no secret in it comes back unchanged", () => {
  assert.equal(scrubSecrets("POST /api/session 401", ["hunter2"]), "POST /api/session 401");
});

test("the note names the kind, the path the login ended on, and each request's method, path and status", () => {
  const out = renderLoginEvidence(
    PRECONDITION_KIND.CREDENTIALS_REJECTED,
    evidence({ requests: [{ method: "POST", pathname: "/api/session", status: 401 }, { method: "PUT", pathname: "/api/profile", status: 500 }], finalPath: "/sign-in" }),
    [USER, "hunter2"],
  );
  for (const part of [PRECONDITION_KIND.CREDENTIALS_REJECTED, "/sign-in", "POST", "/api/session", "401", "PUT", "/api/profile", "500"]) {
    assert.ok(out.includes(part), part);
  }
});

test("a different kind is the one the note names", () => {
  const out = renderLoginEvidence(PRECONDITION_KIND.CAPTCHA_PRESENT, evidence(), []);
  assert.ok(out.includes(PRECONDITION_KIND.CAPTCHA_PRESENT));
  assert.equal(out.includes(PRECONDITION_KIND.CREDENTIALS_REJECTED), false);
});

test("no credential appears in any field of the note, in any spelling, including a request path that embeds the password", () => {
  for (const password of HOSTILE_PASSWORDS) {
    const leaky = (label: string) => `${label} ${spellings(USER)[1]} ${spellings(password)[0]} ${spellings(password)[1]} ${spellings(password)[2]}`;
    const out = renderLoginEvidence(
      PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE,
      evidence({
        firstAlert: leaky("alert"),
        firstPageError: leaky("error"),
        finalPath: `/login/${encodeURIComponent(password)}`,
        ladder: ["/", `/x/${encodeURIComponent(USER)}`],
        requests: [{ method: "POST", pathname: `/api/${encodeURIComponent(password)}/session`, status: 401 }],
      }),
      [USER, password],
    );
    for (const secret of [USER, password]) {
      for (const spelling of spellings(secret)) {
        assert.equal(out.includes(spelling), false, `${JSON.stringify(secret)} leaked as ${JSON.stringify(spelling)}`);
      }
    }
    assert.ok(out.includes("POST"), "the rest of the note is kept");
  }
});

test("a credential that straddles the cut is removed before the text is cut, so no prefix of it is left", () => {
  const password = "Zx9!Qw7#Lm2$";
  const alert = "y".repeat(EVIDENCE_TEXT_MAX - 4) + password + " tail";
  const pageError = "n".repeat(EVIDENCE_TEXT_MAX - 3) + encodeURIComponent(password);
  const out = renderLoginEvidence(PRECONDITION_KIND.CREDENTIALS_REJECTED, evidence({ firstAlert: alert, firstPageError: pageError, pageErrorCount: 1 }), [password]);
  assert.equal(out.includes(password.slice(0, 4)), false, "no prefix of the password survives the cut");
  assert.equal(out.includes(encodeURIComponent(password).slice(0, 4)), false);
});

test("alert and page-error text are bounded, and text within the bound is kept whole", () => {
  const out = renderLoginEvidence(
    PRECONDITION_KIND.CREDENTIALS_REJECTED,
    evidence({ firstAlert: "a".repeat(EVIDENCE_TEXT_MAX + 50), firstPageError: "e".repeat(EVIDENCE_TEXT_MAX), pageErrorCount: 1 }),
    [],
  );
  assert.ok(out.includes("a".repeat(EVIDENCE_TEXT_MAX)));
  assert.equal(out.includes("a".repeat(EVIDENCE_TEXT_MAX + 1)), false);
  assert.ok(out.includes("e".repeat(EVIDENCE_TEXT_MAX)), "text exactly at the bound is not shortened");
});

test("only the first requests up to the cap are rendered", () => {
  const requests = Array.from({ length: MAX_RENDERED_REQUESTS + 5 }, (_, i) => ({ method: "POST", pathname: `/req-${String(i).padStart(2, "0")}-x`, status: 401 }));
  const out = renderLoginEvidence(PRECONDITION_KIND.CREDENTIALS_REJECTED, evidence({ requests }), []);
  assert.ok(out.includes(`/req-${String(MAX_RENDERED_REQUESTS - 1).padStart(2, "0")}-x`), "the last request within the cap is rendered");
  assert.equal(out.includes(`/req-${String(MAX_RENDERED_REQUESTS).padStart(2, "0")}-x`), false, "the first one past the cap is not");
});

test("rendering does not change the evidence it is given", () => {
  const original = evidence({ firstAlert: `bad ${USER}`, requests: [{ method: "POST", pathname: `/a/${USER}`, status: 401 }] });
  const copy = structuredClone(original);
  renderLoginEvidence(PRECONDITION_KIND.CREDENTIALS_REJECTED, original, [USER]);
  assert.deepEqual(original, copy);
});
