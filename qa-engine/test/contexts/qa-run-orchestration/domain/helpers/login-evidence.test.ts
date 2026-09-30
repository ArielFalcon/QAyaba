import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_TEXT_MAX,
  MAX_RENDERED_REQUESTS,
  renderLoginEvidence,
  scrubSecrets,
} from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";
import { scriptedLoginEvidence } from "../../../../support/login-evidence.ts";
import { PRECONDITION_KIND } from "@contexts/qa-run-orchestration/domain/auth-precondition.ts";

/* Synthetic credentials only. Each password carries something an encoder or a regex would treat specially. */
const USER = "qa.bot+tester@demo.example";

/*
 * Every spelling a page, a URL, a form body or a JSON body can echo a value back in, written out by
 * hand: the raw value, percent-encoded, form-encoded (`+` for a space), JSON-escaped, and the hex
 * digits of an escape in either case.
 */
interface Echoed {
  secret: string;
  echoes: readonly string[];
}

const USER_ECHOES: readonly string[] = [USER, "qa.bot%2Btester%40demo.example", "qa.bot%2btester%40demo.example", "QA.BOT+TESTER@DEMO.EXAMPLE"];

const HOSTILE: readonly Echoed[] = [
  { secret: "p w0rd", echoes: ["p w0rd", "p%20w0rd", "p+w0rd"] },
  { secret: 'q"uote', echoes: ['q"uote', "q%22uote", 'q\\"uote'] },
  { secret: "a&b=c", echoes: ["a&b=c", "a%26b%3Dc", "a%26b%3dc"] },
  { secret: "100%+plus", echoes: ["100%+plus", "100%25%2Bplus", "100%25%2bplus"] },
  {
    secret: "ünï©ode✓",
    echoes: ["ünï©ode✓", "%C3%BCn%C3%AF%C2%A9ode%E2%9C%93", "%c3%bcn%c3%af%c2%a9ode%e2%9c%93", "\\u00fcn\\u00ef\\u00a9ode\\u2713", "\\u00FCn\\u00EF\\u00A9ode\\u2713"],
  },
  { secret: "re.g$ex^(a|b)[c]*?", echoes: ["re.g$ex^(a|b)[c]*?", "re.g%24ex%5E(a%7Cb)%5Bc%5D*%3F", "re.g%24ex%5E%28a%7Cb%29%5Bc%5D*%3F"] },
  { secret: "back\\slash", echoes: ["back\\slash", "back%5Cslash", "back%5cslash", "back\\\\slash", "back/slash"] },
  { secret: "a b/c&d", echoes: ["a b/c&d", "a%20b%2Fc%26d", "a%20b/c&d", "a+b%2Fc%26d"] },
  { secret: "p\\q/r", echoes: ["p\\q/r", "p%5Cq%2Fr", "p%5Cq/r", "p/q/r"] },
  { secret: "line\nbreak", echoes: ["line\nbreak", "line%0Abreak", "line%0abreak", "line\\nbreak"] },
  { secret: "it's~(fine)!*", echoes: ["it's~(fine)!*", "it%27s%7E%28fine%29%21*", "it%27s%7e%28fine%29%21*"] },
];

const evidence = scriptedLoginEvidence;

test("a secret is removed in every spelling a page, a URL, a form body or a JSON body echoes it in, and the text around it stays", () => {
  for (const { secret, echoes } of HOSTILE) {
    const text = echoes.map((echo, i) => `part${i}=${echo}`).join(" | ");
    const out = scrubSecrets(text, [secret]);
    for (const echo of echoes) {
      assert.equal(out.includes(echo), false, `${JSON.stringify(secret)} still present as ${JSON.stringify(echo)}`);
    }
    assert.ok(out.includes("part0="), `${JSON.stringify(secret)}: the text around the secret is kept`);
  }
});

test("the user name and the password are both removed from the same text, whatever the case of the user name echoed", () => {
  const { secret: password, echoes } = HOSTILE[0]!;
  const out = scrubSecrets(`user=${USER_ECHOES[1]}&pass=${echoes[1]} raw ${USER} ${password} shout ${USER_ECHOES[3]}`, [USER, password]);
  for (const echo of [...USER_ECHOES, ...echoes]) assert.equal(out.includes(echo), false, echo);
});

test("percent-encoded hex is matched in upper and in lower case", () => {
  const out = scrubSecrets("a%2fb and a%2Fb and p%c3%a9ss and p%C3%A9ss and %E2%9C%93 and %e2%9c%93", ["a/b", "péss", "✓"]);
  for (const fragment of ["a%2f", "a%2F", "p%c3", "p%C3", "%E2%9C", "%e2%9c"]) {
    assert.equal(out.includes(fragment), false, fragment);
  }
  assert.ok(out.includes(" and "), "the text between the echoes is kept");
});

test("a user name echoed back in a different case is removed", () => {
  const out = scrubSecrets("No account for Qa.Bot+Tester@Demo.Example, sorry", [USER]);
  assert.equal(out.toLowerCase().includes("qa.bot"), false);
  assert.equal(out.toLowerCase().includes("tester"), false);
  assert.ok(out.startsWith("No account for "));
  assert.ok(out.endsWith(", sorry"));
});

test("a letter whose lower case is longer than itself does not shift where the secret is cut", () => {
  const out = scrubSecrets("İİİ then Hunter2 and HUNTER2 end", ["hunter2"]);
  assert.ok(out.startsWith("İİİ then "));
  assert.ok(out.endsWith(" end"));
  assert.equal(out.toLowerCase().includes("unter"), false);
});

test("two secrets that overlap in the text are removed as the one stretch they cover, whichever comes first", () => {
  const text = "login xpassword failed";
  const asOne = scrubSecrets(text, ["xpassword"]);
  assert.equal(scrubSecrets(text, ["xpass", "sword"]), asOne);
  assert.equal(scrubSecrets(text, ["sword", "xpass"]), asOne);
  for (const fragment of ["xp", "pas", "ss", "sw", "wo", "rd"]) assert.equal(asOne.includes(fragment), false, fragment);

  const inner = scrubSecrets("zzabcdzz", ["abc", "bcd"]);
  assert.equal(inner, scrubSecrets("zzabcdzz", ["abcd"]));
  for (const fragment of ["ab", "bc", "cd"]) assert.equal(inner.includes(fragment), false, fragment);
  assert.ok(inner.startsWith("zz") && inner.endsWith("zz"));
});

test("a secret inside a longer one is removed with it, whichever is listed first", () => {
  const text = "login xpassword failed";
  const asOne = scrubSecrets(text, ["xpassword"]);
  assert.equal(scrubSecrets(text, ["xpassword", "pass"]), asOne);
  assert.equal(scrubSecrets(text, ["pass", "xpassword"]), asOne);
  assert.equal(scrubSecrets(text, ["xpassword", "sswo"]), asOne);
});

test("two secrets that touch without overlapping are each replaced", () => {
  const each = scrubSecrets("abc", ["abc"]) + scrubSecrets("def", ["def"]);
  assert.equal(scrubSecrets("abcdef", ["abc", "def"]), each);
  assert.equal(scrubSecrets("abcdef", ["def", "abc"]), each);
});

test("a secret that overlaps itself in the text leaves none of it behind", () => {
  const out = scrubSecrets("1zzzz2", ["zzz"]);
  assert.equal(out.includes("z"), false);
  assert.ok(out.startsWith("1") && out.endsWith("2"));
});

test("a secret with a lone surrogate is removed instead of throwing", () => {
  const secret = "ab\ud800cd";
  assert.doesNotThrow(() => scrubSecrets("nothing here", [secret]));
  const out = scrubSecrets(`raw ${secret} and repaired ab�cd`, [secret]);
  assert.equal(out.includes("ab"), false);
  assert.equal(out.includes("cd"), false);
});

test("a secret at the very start or the very end of the text is replaced, with the text beside it kept", () => {
  const atStart = scrubSecrets("hunter2 was tried", ["hunter2"]);
  assert.equal(atStart.includes("hunter2"), false);
  assert.ok(atStart.endsWith(" was tried"));
  assert.ok(atStart.length > " was tried".length, "something stands where the secret was");
  const atEnd = scrubSecrets("tried hunter2", ["hunter2"]);
  assert.equal(atEnd.includes("hunter2"), false);
  assert.ok(atEnd.startsWith("tried "));
  assert.equal(scrubSecrets("hunter2", ["hunter2"]).includes("hunter2"), false);
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

test("removing one secret never assembles another out of the text on either side of it", () => {
  const out = scrubSecrets("paXXssword", ["password", "XX"]);
  assert.equal(out.includes("password"), false);
  assert.equal(out.includes("XX"), false);
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
  for (const { secret, echoes } of HOSTILE) {
    const leaky = (label: string): string => `${label} ${USER_ECHOES.join(" ")} ${echoes.join(" ")}`;
    const out = renderLoginEvidence(
      PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE,
      evidence({
        firstAlert: leaky("alert"),
        firstPageError: leaky("error"),
        finalPath: `/login/${echoes[1]}`,
        ladder: ["/", `/x/${USER_ECHOES[1]}`],
        requests: [{ method: "POST", pathname: `/api/${echoes[1]}/session`, status: 401 }],
      }),
      [USER, secret],
    );
    for (const echo of [...USER_ECHOES, ...echoes]) {
      assert.equal(out.includes(echo), false, `${JSON.stringify(secret)} leaked as ${JSON.stringify(echo)}`);
    }
    assert.ok(out.includes("POST"), "the rest of the note is kept");
  }
});

test("a credential that straddles the cut is removed before the text is cut, so no prefix of it is left", () => {
  const password = "Zx9!Qw7#Lm2$";
  const encoded = "Zx9!Qw7%23Lm2%24";
  const alert = "y".repeat(EVIDENCE_TEXT_MAX - 4) + password + " tail";
  const pageError = "n".repeat(EVIDENCE_TEXT_MAX - 3) + encoded;
  const out = renderLoginEvidence(PRECONDITION_KIND.CREDENTIALS_REJECTED, evidence({ firstAlert: alert, firstPageError: pageError, pageErrorCount: 1 }), [password]);
  assert.equal(out.includes(password.slice(0, 4)), false, "no prefix of the password survives the cut");
  assert.equal(out.includes(encoded.slice(0, 4)), false);
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

test("the note names the first new exception when there is one and leaves that part out when there is none", () => {
  const kind = PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE;
  const named = renderLoginEvidence(kind, evidence({ requests: [], newExceptionAfterSubmit: true, firstNewException: "TypeError: exception-marker" }), []);
  assert.ok(named.includes("exception-marker"));
  const silent = renderLoginEvidence(kind, evidence({ requests: [], newExceptionAfterSubmit: false, firstNewException: null }), []);
  assert.equal(silent.includes("exception-marker"), false);
  assert.doesNotMatch(silent, /:\s*(?:;|$)|;\s*(?:;|$)/, "no part is rendered empty and no separator is left dangling");
});

test("the first new exception is bounded, and a credential in it is removed in every spelling before the cut", () => {
  const kind = PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE;
  const long = renderLoginEvidence(kind, evidence({ newExceptionAfterSubmit: true, firstNewException: "n".repeat(EVIDENCE_TEXT_MAX + 50) }), []);
  assert.ok(long.includes("n".repeat(EVIDENCE_TEXT_MAX)));
  assert.equal(long.includes("n".repeat(EVIDENCE_TEXT_MAX + 1)), false);
  for (const { secret, echoes } of HOSTILE) {
    const out = renderLoginEvidence(kind, evidence({ newExceptionAfterSubmit: true, firstNewException: `exception-marker ${USER_ECHOES.join(" ")} ${echoes.join(" ")}` }), [USER, secret]);
    assert.ok(out.includes("exception-marker"), "the exception is rendered");
    for (const echo of [...USER_ECHOES, ...echoes]) assert.equal(out.includes(echo), false, `${JSON.stringify(secret)} leaked as ${JSON.stringify(echo)}`);
  }
  const password = "Zx9!Qw7#Lm2$";
  const straddling = renderLoginEvidence(kind, evidence({ newExceptionAfterSubmit: true, firstNewException: "y".repeat(EVIDENCE_TEXT_MAX - 4) + password }), [password]);
  assert.ok(straddling.includes("y".repeat(EVIDENCE_TEXT_MAX - 4)), "the exception is rendered");
  assert.equal(straddling.includes(password.slice(0, 4)), false, "no prefix of the password survives the cut");
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

test("the pages tried are each listed apart from the next", () => {
  const out = renderLoginEvidence(PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE, evidence({ ladder: ["/", "/start", "/sign-in"], finalPath: "/done" }), []);
  assert.ok(out.includes("/start"));
  assert.ok(out.includes("/sign-in"));
  assert.equal(out.includes("/start/sign-in"), false, "two paths must not fuse into one");
});

test("the requests are each listed apart from the next, and one with no response yet still shows a value", () => {
  const out = renderLoginEvidence(
    PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE,
    evidence({ requests: [{ method: "POST", pathname: "/api/session", status: 401 }, { method: "PUT", pathname: "/api/profile", status: null }] }),
    [],
  );
  assert.doesNotMatch(out, /\d[A-Z]/, "a status must not fuse with the next method");
  assert.equal(out.includes("null"), false, "a missing status is never printed as null");
  assert.match(out, /PUT \/api\/profile \w/, "a word, not just the next separator, follows the path of a request with no response");
});

test("the page-error count is reported, with the first error only when there is one", () => {
  const counted = renderLoginEvidence(PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE, evidence({ ladder: ["/"], finalPath: "/", requests: [], pageErrorCount: 7 }), []);
  assert.ok(counted.includes("7"));
  const withFirst = renderLoginEvidence(PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE, evidence({ pageErrorCount: 1, firstPageError: "boom-marker" }), []);
  assert.ok(withFirst.includes("boom-marker"));
  assert.equal(counted.includes("boom-marker"), false);
});

test("the note's fields are set apart from the kind and from each other, and none is rendered empty", () => {
  const kind = PRECONDITION_KIND.CREDENTIALS_REJECTED;
  const bare = renderLoginEvidence(kind, evidence({ requests: [], firstAlert: null, firstPageError: null }), []);
  const full = renderLoginEvidence(kind, evidence({ firstAlert: "alert-marker", firstPageError: "error-marker", pageErrorCount: 1 }), []);
  for (const note of [bare, full]) {
    assert.match(note, new RegExp(`^${kind}\\W`), "the kind stands apart from what follows");
    assert.doesNotMatch(note, /:\s*(?:;|$)|;\s*(?:;|$)/, "no field is rendered with an empty value, and no separator is left dangling");
  }
  assert.ok(full.includes("alert-marker"));
  assert.equal(bare.includes("alert-marker"), false);
});
