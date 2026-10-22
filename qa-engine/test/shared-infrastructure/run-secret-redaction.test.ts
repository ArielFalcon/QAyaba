/* The secrets of a run's test account are known by value, so they are taken out of any text on its way to a model by what they are, not by how they look: a plain password a spec printed matches no pattern. */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import {
  MAX_OPAQUE_BYTES,
  MAX_SECRET_VALUE_CHARS,
  MIN_ACCOUNT_SECRET_CHARS,
  MIN_SESSION_VALUE_CHARS,
  activeRunSecretScope,
  createRunSecretScope,
  redactByValue,
  registerSessionSecretsFromStorageState,
  withRunSecretScope,
} from "../../src/shared-infrastructure/run-secret-redaction.ts";

const PASSWORD = "Tr0ub4dor&3-horse";

function withAuthDir(run: (authDir: string, outside: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "qa-run-secrets-"));
  const authDir = join(tmp, "auth");
  mkdirSync(authDir);
  mkdirSync(join(tmp, "outside"));
  try {
    run(authDir, join(tmp, "outside"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function captureWarnings(run: () => void): string[] {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
  try {
    run();
  } finally {
    warn.mock.restore();
  }
  return warnings;
}

const STATE = {
  cookies: [
    { name: "sid", value: "s3ssion-cookie-value" },
    { name: "lang", value: "en" },
    { name: "short7", value: "1234567" },
    { name: "edge8", value: "12345678" },
  ],
  origins: [{ origin: "https://dev.example", localStorage: [{ name: "token", value: "ls-token-value-xyz" }, { name: "flag", value: "true" }] }],
};

test("outside a run's scope, a text is returned as it is", () => {
  assert.equal(activeRunSecretScope(), undefined);
  assert.equal(redactByValue(`password ${PASSWORD}`), `password ${PASSWORD}`);
});

test("within a scope, an account secret is replaced wherever it stands, however often", () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([PASSWORD, undefined, ""]);
  const out = withRunSecretScope(scope, () => redactByValue(`<input value="${PASSWORD}"> Error: expected ${PASSWORD} got ${PASSWORD}`));
  assert.equal(out, `<input value="${REDACTED}"> Error: expected ${REDACTED} got ${REDACTED}`);
  assert.equal(activeRunSecretScope(), undefined, "the scope ends with the call");
});

test("the scope follows the run through its async calls and two runs never see each other's secrets", async () => {
  const a = createRunSecretScope();
  a.addAccountSecrets(["secret-of-run-a"]);
  const b = createRunSecretScope();
  b.addAccountSecrets(["secret-of-run-b"]);
  const text = "secret-of-run-a secret-of-run-b";
  const [fromA, fromB] = await Promise.all([
    withRunSecretScope(a, async () => { await new Promise((r) => setTimeout(r, 5)); return redactByValue(text); }),
    withRunSecretScope(b, async () => { await new Promise((r) => setTimeout(r, 1)); return redactByValue(text); }),
  ]);
  assert.equal(fromA, `${REDACTED} secret-of-run-b`);
  assert.equal(fromB, `secret-of-run-a ${REDACTED}`);
});

test("a longer secret that contains a shorter one is replaced whole", () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets(["hunter22", "hunter22-extended"]);
  assert.equal(withRunSecretScope(scope, () => redactByValue("x hunter22-extended y hunter22")), `x ${REDACTED} y ${REDACTED}`);
});

test("a secret is also found as a page, a JSON string or a URL spells it", () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets(['p&ss"w<rd>\\1']);
  const out = withRunSecretScope(scope, () =>
    redactByValue([
      'html: p&amp;ss&quot;w&lt;rd&gt;\\1',
      'json: "p&ss\\"w<rd>\\\\1"',
      `url: ${encodeURIComponent('p&ss"w<rd>\\1')}`,
      'raw: p&ss"w<rd>\\1',
    ].join("\n")),
  );
  assert.equal(out, [`html: ${REDACTED}`, `json: "${REDACTED}"`, `url: ${REDACTED}`, `raw: ${REDACTED}`].join("\n"));
});

test("an account secret shorter than the floor is ignored, and so is one longer than the cap", () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets(["a".repeat(MIN_ACCOUNT_SECRET_CHARS - 1), "b".repeat(MAX_SECRET_VALUE_CHARS + 1)]);
  const text = `${"a".repeat(MIN_ACCOUNT_SECRET_CHARS - 1)} ${"b".repeat(MAX_SECRET_VALUE_CHARS + 1)}`;
  assert.equal(withRunSecretScope(scope, () => redactByValue(text)), text);
});

test("a session value is replaced from the minimum length on, and a shorter one is left alone", () => {
  const scope = createRunSecretScope();
  scope.addSessionValues(["1234567", "12345678"]);
  assert.equal("1234567".length, MIN_SESSION_VALUE_CHARS - 1);
  assert.equal(withRunSecretScope(scope, () => redactByValue("a 1234567 b 12345678")), `a 1234567 b ${REDACTED}`);
});

test("cookie and localStorage values of the run's storageState are registered, the short ones are not", () => {
  withAuthDir((authDir) => {
    writeFileSync(join(authDir, "user.json"), JSON.stringify(STATE));
    const scope = createRunSecretScope();
    const warnings = captureWarnings(() => withRunSecretScope(scope, () => registerSessionSecretsFromStorageState(authDir, "user.json")));
    assert.deepEqual(warnings, []);
    const text = "sid=s3ssion-cookie-value lang=en short=1234567 edge=12345678 ls=ls-token-value-xyz flag=true";
    assert.equal(withRunSecretScope(scope, () => redactByValue(text)), `sid=${REDACTED} lang=en short=1234567 edge=${REDACTED} ls=${REDACTED} flag=true`);
  });
});

test("a storageState that cannot be read strictly redacts nothing extra and warns without quoting it", () => {
  withAuthDir((authDir, outside) => {
    const leak = "leaky-cookie-value-9999";
    writeFileSync(join(outside, "state.json"), JSON.stringify({ cookies: [{ name: "n", value: leak }] }));
    symlinkSync(join(outside, "state.json"), join(authDir, "user.json"));
    const scope = createRunSecretScope();
    const warnings = captureWarnings(() => withRunSecretScope(scope, () => registerSessionSecretsFromStorageState(authDir, "user.json")));
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0]!.includes(leak) && !warnings[0]!.includes(outside));
    assert.equal(withRunSecretScope(scope, () => redactByValue(leak)), leak);
  });
});

test("an absent, malformed or oddly shaped storageState registers nothing and never throws", () => {
  withAuthDir((authDir) => {
    const scope = createRunSecretScope();
    captureWarnings(() => {
      withRunSecretScope(scope, () => {
        registerSessionSecretsFromStorageState(authDir, "user.json");
        for (const body of ["{not json", "[]", "null", JSON.stringify({ cookies: "x", origins: 3 }), JSON.stringify({ cookies: [null, 4, { value: 7 }], origins: [null, { localStorage: [{ value: {} }] }] })]) {
          writeFileSync(join(authDir, "user.json"), body);
          registerSessionSecretsFromStorageState(authDir, "user.json");
        }
      });
    });
    assert.equal(withRunSecretScope(scope, () => redactByValue("{not json 12345678")), "{not json 12345678");
  });
});

test("nothing the scope logs carries a secret", () => {
  withAuthDir((authDir) => {
    writeFileSync(join(authDir, "user.json"), `{"cookies":[{"value":"${PASSWORD}"}`);
    const scope = createRunSecretScope();
    scope.addAccountSecrets([PASSWORD]);
    const log: string[] = [];
    const methods = (["log", "warn", "error", "info", "debug"] as const).map((m) => mock.method(console, m, (...args: unknown[]) => void log.push(args.map(String).join(" "))));
    try {
      withRunSecretScope(scope, () => {
        registerSessionSecretsFromStorageState(authDir, "user.json");
        redactByValue(`x ${PASSWORD}`);
      });
    } finally {
      for (const m of methods) m.mock.restore();
    }
    assert.ok(log.every((line) => !line.includes(PASSWORD)));
  });
});

test("a secret is also taken out when the spec printed it base64, base64url or hex encoded", () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([PASSWORD]);
  const bytes = Buffer.from(PASSWORD);
  for (const encoded of [bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex"), bytes.toString("hex").toUpperCase(), bytes.toString("base64").replaceAll("=", "")]) {
    assert.equal(scope.redact(`leaked: ${encoded} end`), `leaked: ${REDACTED} end`, encoded);
  }
});

test("a secret embedded in a longer base64 string is found at each of the three alignments", () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([PASSWORD]);
  for (const prefix of ["", "a", "ab"]) {
    const encoded = Buffer.from(`${prefix}${PASSWORD}-tail`).toString("base64");
    const out = scope.redact(encoded);
    assert.notEqual(out, encoded, `prefix ${JSON.stringify(prefix)}`);
    assert.match(out, new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")));
  }
});

test("the encodings of a short secret are left alone: a few characters of base64 or hex say nothing and would eat ordinary words", () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets(["abcd"]);
  const text = `${Buffer.from("abcd").toString("base64")} ${Buffer.from("abcd").toString("hex")}`;
  assert.equal(scope.redact(text), text);
  assert.equal(scope.redact("abcd"), REDACTED);
});

test("opaque bytes (a client certificate, a session file) are taken out in the encodings a spec could print them in", () => {
  const scope = createRunSecretScope();
  const blob = Buffer.from("PKCS12-not-really-but-binary-\u0000\u0001\u0002-material-0123456789", "utf8");
  scope.addOpaqueBytes([blob]);
  for (const encoded of [blob.toString("base64"), blob.toString("base64url"), blob.toString("hex"), blob.toString("utf8")]) {
    assert.equal(scope.redact(`x ${encoded} y`), `x ${REDACTED} y`, encoded.slice(0, 20));
  }
});

test("opaque bytes that are empty or too large to match on are not registered", () => {
  const scope = createRunSecretScope();
  scope.addOpaqueBytes([Buffer.alloc(0), Buffer.alloc(MAX_OPAQUE_BYTES + 1, 7)]);
  assert.equal(scope.redact("anything at all"), "anything at all");
});
