import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./probe-gateway.sh", import.meta.url));

// A stand-in for curl, the process boundary of the probe. It records its arguments and answers per
// STUB_CURL_RULES: a comma-separated list of "<url substring>=<exit>:<http status>" (the first rule
// whose substring is in the URL wins); a URL no rule matches answers 200.
const CURL_STUB = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
for last; do :; done
url="$last"
rule=""
for r in $(echo "$STUB_CURL_RULES" | tr ',' ' '); do
  case "$url" in *"\${r%%=*}"*) rule="\${r#*=}"; break ;; esac
done
exit_code="\${rule%%:*}"; status="\${rule#*:}"
[ -n "$rule" ] || { exit_code=0; status=200; }
if [ "$exit_code" = "0" ]; then printf '%s' "$status"; else echo "curl: (\${exit_code}) simulated transport error" >&2; printf '000'; fi
exit "$exit_code"
`;

function probe({ override, rules = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "qayaba-probe-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), CURL_STUB);
    chmodSync(join(bin, "curl"), 0o755);
    const overridePath = join(dir, "override.json");
    if (override !== undefined) writeFileSync(overridePath, JSON.stringify(override));
    const log = join(dir, "curl.log");
    writeFileSync(log, "");
    const run = spawnSync("sh", [script, overridePath], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, STUB_LOG: log, STUB_CURL_RULES: rules },
    });
    return { ...run, output: `${run.stdout}${run.stderr}`, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const gateway = (baseURL, extra = {}) => ({ npm: "@ai-sdk/openai-compatible", options: { baseURL, apiKey: "sk-test-secret", ...extra }, models: {} });

test("each declared gateway is asked for its model list, without sending any credential", () => {
  const result = probe({ override: { provider: { a: gateway("https://llm-a.example.test/v1"), b: gateway("https://llm-b.example.test/api/") } } });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls.map((c) => c.split(" ").pop()), ["https://llm-a.example.test/v1/models", "https://llm-b.example.test/api/models"]);
  for (const call of result.calls) assert.doesNotMatch(call, /(^| )-H|authorization|sk-test-secret|--user|-u /i);
});

test("any HTTP status counts as reachable", () => {
  for (const status of ["200", "401", "403"]) {
    const result = probe({ override: { provider: { a: gateway("https://llm.example.test/v1") } }, rules: `llm.example.test=0:${status}` });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`reachable.*HTTP ${status}`));
  }
});

test("a name that does not resolve is unreachable and points at the DNS the containers use", () => {
  const result = probe({ override: { provider: { a: gateway("https://llm.example.test/v1") } }, rules: "llm.example.test=6:000" });
  assert.equal(result.status, 1);
  assert.match(result.output, /UNREACHABLE \(curl exit 6\)/);
  assert.match(result.output, /DNS/);
  assert.doesNotMatch(result.output, /EXTRA_NO_PROXY|export-ca/, "the advice is specific to a name that does not resolve");
});

test("a connection that is refused or times out points at the proxy and EXTRA_NO_PROXY", () => {
  for (const code of ["7", "28"]) {
    const result = probe({ override: { provider: { a: gateway("https://llm.example.test/v1") } }, rules: `llm.example.test=${code}:000` });
    assert.equal(result.status, 1);
    assert.match(result.output, new RegExp(`UNREACHABLE \\(curl exit ${code}\\)`));
    assert.match(result.output, /proxy/i);
    assert.match(result.output, /EXTRA_NO_PROXY/);
    assert.doesNotMatch(result.output, /export-ca/, "the advice is specific to a filtered connection");
  }
});

test("a TLS verification failure points at exporting the corporate CA", () => {
  const result = probe({ override: { provider: { a: gateway("https://llm.example.test/v1") } }, rules: "llm.example.test=60:000" });
  assert.equal(result.status, 1);
  assert.match(result.output, /export-ca/);
  assert.doesNotMatch(result.output, /EXTRA_NO_PROXY/, "the advice is specific to a TLS failure");
});

test("an unexpected transport error is still unreachable, with the curl exit code", () => {
  const result = probe({ override: { provider: { a: gateway("https://llm.example.test/v1") } }, rules: "llm.example.test=18:000" });
  assert.equal(result.status, 1);
  assert.match(result.output, /UNREACHABLE \(curl exit 18\)/);
});

test("one unreachable gateway does not hide the state of the others", () => {
  const result = probe({
    override: { provider: { a: gateway("https://down.example.test/v1"), b: gateway("https://up.example.test/v1") } },
    rules: "down.example.test=7:000",
  });
  assert.equal(result.status, 1);
  assert.match(result.output, /down\.example\.test.*UNREACHABLE/);
  assert.match(result.output, /up\.example\.test.*reachable \(HTTP 200\)/);
});

test("a provider without a baseURL is skipped and an override without providers has nothing to probe", () => {
  const skipped = probe({ override: { provider: { a: { npm: "x", options: {} } } } });
  assert.equal(skipped.status, 0, skipped.output);
  assert.deepEqual(skipped.calls, []);
  const none = probe({ override: { agent: {} } });
  assert.equal(none.status, 0, none.output);
  assert.deepEqual(none.calls, []);
});

test("without an override file the gateway is not declared and nothing is probed", () => {
  const result = probe({ override: undefined });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /not declared/);
});
