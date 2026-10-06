import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");

// The runtime stage is the last one: everything after the final FROM.
const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));

// Values of every ENV instruction of a stage, with line continuations joined.
function envOf(stage) {
  const env = {};
  for (const line of stage.replace(/\\\n/g, " ").split("\n")) {
    if (!/^ENV\s/.test(line)) continue;
    for (const pair of line.replace(/^ENV\s+/, "").split(/\s+/)) {
      const [key, ...value] = pair.split("=");
      env[key] = value.join("=");
    }
  }
  return env;
}

test("every client in the image is pointed at the system bundle that holds the corporate CAs", () => {
  const env = envOf(runtime);
  const bundle = "/etc/ssl/certs/ca-certificates.crt";
  for (const name of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "PIP_CERT"]) assert.equal(env[name], bundle, name);
});

test("git trusts the system bundle for every user of the image", () => {
  assert.match(runtime, /git config --system http\.sslCAInfo \/etc\/ssl\/certs\/ca-certificates\.crt/);
});

test("the Java truststore is fed after the JDK is installed, never before", () => {
  const jdk = runtime.indexOf("openjdk-21-jdk-headless");
  const trust = runtime.indexOf("\nRUN java-trust-ca");
  assert.ok(jdk > 0, "the runtime stage installs the JDK");
  assert.ok(trust > jdk, "java-trust-ca runs after the JDK package");
});

test("Serena does not report usage from the image", () => {
  assert.equal(envOf(runtime).SERENA_USAGE_REPORTING, "false");
});
