/* The session file of a run's login is read strictly and its cookie and localStorage values join the run's secrets, so a value a spec prints is taken out by what it is. */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { MIN_SESSION_VALUE_CHARS, activeRunSecretScope, createRunSecretScope, redactByValue, withRunSecretScope } from "../../../src/shared-kernel/run-secret-redaction.ts";
import { registerSessionSecretsFromStorageState } from "../../../src/shared-infrastructure/redaction/session-secrets.ts";

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

