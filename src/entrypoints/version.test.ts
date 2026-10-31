import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handshake, versionGte, engineVersionOf, revisionOf, ENGINE_VERSION, SERVER_VERSION, MIN_CLIENT_VERSION, WIRE_API_VERSION, CAPABILITIES } from "./version";

test("handshake reports the server version, wire API and capabilities", () => {
  const info = handshake("0.1.0");
  assert.equal(info.serverVersion, SERVER_VERSION);
  assert.equal(info.serverVersion, "0.1.0");
  assert.equal(info.apiVersion, WIRE_API_VERSION);
  assert.equal(info.minClientVersion, MIN_CLIENT_VERSION);
  assert.deepEqual(info.capabilities, [...CAPABILITIES]);
});

test("handshake is compatible for a new-enough client and omits a message", () => {
  const info = handshake("0.1.0");
  assert.equal(info.compatible, true);
  assert.equal(info.message, undefined);
});

test("handshake flags an old client and explains how to fix it", () => {
  const info = handshake("0.0.9");
  assert.equal(info.compatible, false);
  assert.match(info.message ?? "", /Update qayaba/);
});

test("handshake without a client version assumes compatible (cannot judge)", () => {
  assert.equal(handshake().compatible, true);
});

test("handshake advertises the GitHub OAuth client id when configured, omits it otherwise", () => {
  assert.equal(handshake("0.1.0", "Ov23xyz").githubClientId, "Ov23xyz");
  assert.equal(handshake("0.1.0").githubClientId, undefined);
  assert.equal(handshake("0.1.0", "").githubClientId, undefined); /* empty env var ⇒ not advertised */
});

test("versionGte compares major.minor.patch numerically and tolerates a v prefix / pre-release", () => {
  assert.equal(versionGte("1.0.0", "0.9.9"), true);
  assert.equal(versionGte("0.1.0", "0.1.0"), true);
  assert.equal(versionGte("0.2.0", "0.10.0"), false);
  assert.equal(versionGte("v1.2.3-rc1", "1.2.3"), true);
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
function checkout(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "qa-revision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("the engine version is the package version with the revision of the code that runs, so runs of different code are told apart", () => {
  assert.equal(engineVersionOf("0.1.0", SHA), "0.1.0+0123456789ab");
  assert.equal(engineVersionOf("0.1.0", null), "0.1.0+unknown", "no revision known: said so, never the package version alone, which every commit shares");
  assert.ok(ENGINE_VERSION.startsWith(SERVER_VERSION));
});

test("the revision is the one an image build wrote beside the code, else the checkout's HEAD", (t) => {
  const baked = checkout(t);
  writeFileSync(join(baked, "REVISION"), `${SHA}\n`);
  mkdirSync(join(baked, ".git"));
  writeFileSync(join(baked, ".git", "HEAD"), `${"f".repeat(40)}\n`);
  assert.equal(revisionOf(baked), SHA);

  const detached = checkout(t);
  mkdirSync(join(detached, ".git"));
  writeFileSync(join(detached, ".git", "HEAD"), `${SHA}\n`);
  assert.equal(revisionOf(detached), SHA);

  assert.equal(revisionOf(checkout(t)), null, "neither: no revision");
});

test("a checkout on a branch reads the branch's commit, loose or packed", (t) => {
  const loose = checkout(t);
  mkdirSync(join(loose, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(loose, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(loose, ".git", "refs", "heads", "main"), `${SHA}\n`);
  assert.equal(revisionOf(loose), SHA);

  const packed = checkout(t);
  mkdirSync(join(packed, ".git"));
  writeFileSync(join(packed, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(packed, ".git", "packed-refs"), `# pack-refs\n${"a".repeat(40)} refs/heads/other\n${SHA} refs/heads/main\n`);
  assert.equal(revisionOf(packed), SHA);
});

test("a linked worktree (a .git file) reads its own HEAD and the branch from the common directory", (t) => {
  const main = checkout(t);
  mkdirSync(join(main, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
  writeFileSync(join(main, ".git", "refs", "heads", "fix"), `${SHA}\n`);
  writeFileSync(join(main, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/fix\n");
  writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
  const linked = checkout(t);
  writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
  assert.equal(revisionOf(linked), SHA);
});

test("a revision file or HEAD that is not a commit id is no revision", (t) => {
  const root = checkout(t);
  writeFileSync(join(root, "REVISION"), "not-a-sha\n");
  assert.equal(revisionOf(root), null);
});
