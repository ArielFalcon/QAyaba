import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiTokenPath, discoverApiToken, legacyApiTokenPath, loadOrCreateApiToken, resolveApiToken, retireLegacyApiToken } from "./api-token";

function root(): string {
  return mkdtempSync(join(tmpdir(), "api-token-"));
}

const mode = (path: string): number => statSync(path).mode & 0o777;
const quiet = { log: () => {} };

test("the token lives in the data directory, not with the app configs", () => {
  assert.equal(apiTokenPath("/app"), "/app/data/.api_token");
  assert.equal(legacyApiTokenPath("/app"), "/app/config/.api_token");
});

test("a token is generated into the data directory, owner-only, when there is none", () => {
  const r = root();
  try {
    const token = loadOrCreateApiToken(r, quiet);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(apiTokenPath(r), "utf8"), token);
    assert.equal(mode(apiTokenPath(r)), 0o600);
    assert.equal(mode(join(r, "data")), 0o700);
    assert.equal(loadOrCreateApiToken(r, quiet), token, "the next boot reuses it");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a token left with the app configs is never reused: a fresh one is generated, the old file is removed and the notice does not carry either value", () => {
  const r = root();
  try {
    mkdirSync(join(r, "config"));
    writeFileSync(legacyApiTokenPath(r), "legacy-token\n", { mode: 0o644 });
    const lines: string[] = [];
    const token = loadOrCreateApiToken(r, { log: (line) => lines.push(line) });
    assert.notEqual(token, "legacy-token");
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(legacyApiTokenPath(r)), false);
    assert.equal(readFileSync(apiTokenPath(r), "utf8"), token);
    assert.equal(mode(apiTokenPath(r)), 0o600);
    const said = lines.join("\n");
    assert.ok(said.includes(legacyApiTokenPath(r)), "the notice names the file that went");
    assert.ok(said.includes(apiTokenPath(r)), "the notice says where to find the new token");
    assert.ok(!said.includes("legacy-token") && !said.includes(token), "no token value is logged");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("with a token in both places the data directory's wins and the stale copy is removed", () => {
  const r = root();
  try {
    mkdirSync(join(r, "config"));
    mkdirSync(join(r, "data"));
    writeFileSync(apiTokenPath(r), "current");
    writeFileSync(legacyApiTokenPath(r), "stale");
    assert.equal(loadOrCreateApiToken(r, quiet), "current");
    assert.equal(existsSync(legacyApiTokenPath(r)), false);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a client finds the token where the service keeps it, then where it used to, and the environment wins over both", () => {
  const r = root();
  try {
    assert.equal(discoverApiToken({}, r), undefined);
    mkdirSync(join(r, "config"));
    writeFileSync(legacyApiTokenPath(r), "legacy\n");
    assert.equal(discoverApiToken({}, r), "legacy");
    mkdirSync(join(r, "data"));
    writeFileSync(apiTokenPath(r), "current\n");
    assert.equal(discoverApiToken({}, r), "current");
    assert.equal(discoverApiToken({ QA_API_TOKEN: "pinned" }, r), "pinned");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a token left with the app configs is removed even when QA_API_TOKEN pins the token, and the notice says so", () => {
  const r = root();
  try {
    mkdirSync(join(r, "config"));
    writeFileSync(legacyApiTokenPath(r), "legacy-token\n");
    const lines: string[] = [];
    retireLegacyApiToken(r, { log: (line) => lines.push(line) });
    assert.equal(existsSync(legacyApiTokenPath(r)), false);
    assert.ok(lines.join("\n").includes(legacyApiTokenPath(r)));
    assert.ok(!lines.join("\n").includes("legacy-token"));
    const quietLines: string[] = [];
    retireLegacyApiToken(r, { log: (line) => quietLines.push(line) });
    assert.deepEqual(quietLines, [], "nothing to retire, nothing to say");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a legacy token file that cannot be removed stops the start, naming the file and never the token", () => {
  const r = root();
  try {
    mkdirSync(join(r, "config"));
    writeFileSync(legacyApiTokenPath(r), "legacy-token\n");
    const remove = (): void => {
      throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    };
    assert.throws(
      () => retireLegacyApiToken(r, { log: () => {}, remove }),
      (err: Error) => err.message.includes(legacyApiTokenPath(r)) && err.message.includes("EBUSY") && !err.message.includes("legacy-token"),
    );
    assert.throws(() => loadOrCreateApiToken(r, { log: () => {}, remove }), /could not be removed/);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("the service's token is the pinned one when QA_API_TOKEN is set, and the old file goes either way", () => {
  const r = root();
  try {
    mkdirSync(join(r, "config"));
    writeFileSync(legacyApiTokenPath(r), "legacy-token\n");
    assert.equal(resolveApiToken({ QA_API_TOKEN: "pinned" }, r, quiet), "pinned");
    assert.equal(existsSync(legacyApiTokenPath(r)), false);
    assert.equal(existsSync(apiTokenPath(r)), false, "a pinned token writes no file");

    writeFileSync(legacyApiTokenPath(r), "legacy-token\n");
    const generated = resolveApiToken({}, r, quiet);
    assert.match(generated, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(legacyApiTokenPath(r)), false);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a pinned token does not start the service while the old file cannot be removed", () => {
  const r = root();
  try {
    mkdirSync(join(r, "config"));
    writeFileSync(legacyApiTokenPath(r), "legacy-token\n");
    assert.throws(() => resolveApiToken({ QA_API_TOKEN: "pinned" }, r, { log: () => {}, remove: () => { throw new Error("EBUSY"); } }), /could not be removed/);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});
test("a token file a crashed start left half-written beside the real one is swept at the next start", () => {
  const r = root();
  try {
    mkdirSync(join(r, "data"));
    const stale = [join(r, "data", ".api_token.123.tmp"), join(r, "data", ".api_token.99999.tmp")];
    for (const file of stale) writeFileSync(file, "half");
    writeFileSync(join(r, "data", "other.tmp"), "kept");
    const token = loadOrCreateApiToken(r, quiet);
    for (const file of stale) assert.equal(existsSync(file), false, file);
    assert.equal(existsSync(join(r, "data", "other.tmp")), true);
    assert.equal(readFileSync(apiTokenPath(r), "utf8"), token);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});
