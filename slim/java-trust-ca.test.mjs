import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./java-trust-ca.sh", import.meta.url));

// A stand-in for the JDK's keytool, the process boundary of the script under test. A "certificate" is
// a PEM block whose body is its own label; its fingerprint is that label. The keystore is a text file
// with one fingerprint per line. STUB_IMPORT_MODE=ignore makes -importcert report success without
// adding anything, which is the failure the script must catch by re-reading the store.
const KEYTOOL_STUB = `#!/usr/bin/env bash
set -eu
cmd="$1"; shift
file=""; store=""; alias=""
while [ $# -gt 0 ]; do
  case "$1" in
    -file) file="$2"; shift 2 ;;
    -keystore) store="$2"; shift 2 ;;
    -alias) alias="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$cmd" in
  -printcert) printf 'Certificate fingerprints:\\n\\t SHA1: 00\\n\\t SHA256: %s\\n' "$(sed -n 2p "$file")" ;;
  -list) while IFS= read -r fp; do printf 'alias, trustedCertEntry,\\nCertificate fingerprint (SHA-256): %s\\n' "$fp"; done < "$store" ;;
  -importcert)
    echo "import $alias $(sed -n 2p "$file")" >> "$STUB_LOG"
    [ "\${STUB_IMPORT_MODE:-}" = "ignore" ] || sed -n 2p "$file" >> "$store" ;;
  *) echo "unexpected keytool command $cmd" >&2; exit 2 ;;
esac
`;

const pem = (label) => `-----BEGIN CERTIFICATE-----\n${label}\n-----END CERTIFICATE-----\n`;

function scenario({ crts = {}, store = ["SYSTEM-ROOT"], mode = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qayaba-java-trust-"));
  const bin = join(dir, "bin");
  const certs = join(dir, "certs");
  mkdirSync(bin);
  mkdirSync(certs);
  writeFileSync(join(bin, "keytool"), KEYTOOL_STUB);
  chmodSync(join(bin, "keytool"), 0o755);
  writeFileSync(join(certs, "README.md"), "not a certificate\n");
  for (const [name, content] of Object.entries(crts)) writeFileSync(join(certs, name), content);
  const storePath = join(dir, "cacerts");
  if (store) writeFileSync(storePath, store.map((fp) => `${fp}\n`).join(""));
  const log = join(dir, "keytool.log");
  writeFileSync(log, "");
  const run = spawnSync("bash", [script, certs], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, JAVA_CACERTS: storePath, STUB_LOG: log, STUB_IMPORT_MODE: mode },
  });
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : null);
  return { run, store: read(storePath), imports: read(log), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function withScenario(options, check) {
  const s = scenario(options);
  try {
    check(s);
  } finally {
    s.cleanup();
  }
}

test("with no corporate certificate there is nothing to import and the store is left alone", () => {
  withScenario({}, ({ run, store, imports }) => {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(store, ["SYSTEM-ROOT"]);
    assert.deepEqual(imports, []);
  });
});

test("every certificate of a bundle is added to the Java store next to the ones already there", () => {
  withScenario({ crts: { "corporate-ca.crt": pem("CORP-ROOT") + pem("CORP-ISSUING") + pem("CORP-PROXY") } }, ({ run, store }) => {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(store, ["SYSTEM-ROOT", "CORP-ROOT", "CORP-ISSUING", "CORP-PROXY"]);
  });
});

test("certificates from several files are all trusted", () => {
  withScenario({ crts: { "one.crt": pem("CORP-ONE"), "two.crt": pem("CORP-TWO") } }, ({ run, store }) => {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(store, ["SYSTEM-ROOT", "CORP-ONE", "CORP-TWO"]);
  });
});

test("a certificate the store already trusts is not imported again", () => {
  withScenario({ crts: { "corporate-ca.crt": pem("CORP-ROOT") + pem("CORP-NEW") }, store: ["SYSTEM-ROOT", "CORP-ROOT"] }, ({ run, store, imports }) => {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(store, ["SYSTEM-ROOT", "CORP-ROOT", "CORP-NEW"]);
    assert.equal(imports.length, 1);
    assert.match(imports[0], /CORP-NEW$/);
  });
});

test("the build fails and names the certificate when keytool reports success but the store lacks it", () => {
  withScenario({ crts: { "corporate-ca.crt": pem("CORP-ROOT") }, mode: "ignore" }, ({ run }) => {
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /CORP-ROOT/);
  });
});

test("the build fails when a .crt file holds no PEM certificate", () => {
  withScenario({ crts: { "broken.crt": "not a certificate\n" } }, ({ run }) => {
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /broken\.crt/);
  });
});

test("a missing Java store is never created from the corporate certificates alone", () => {
  withScenario({ crts: { "corporate-ca.crt": pem("CORP-ROOT") }, store: null }, ({ run, store }) => {
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /truststore/);
    assert.equal(store, null);
  });
});
