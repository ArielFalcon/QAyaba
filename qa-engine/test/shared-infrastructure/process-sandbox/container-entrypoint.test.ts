/* The container's boot closes what the sandbox uid must not read, at every boot, whatever the volumes were created with. The script is run against a stand-in app root under os.tmpdir(), then execs the command it was given. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "..", "bin", "container-entrypoint.sh");
const mode = (path: string): number => statSync(path).mode & 0o777;

function boot(root: string, command: string[] = ["true"], extraEnv: Record<string, string> = {}): string {
  return execFileSync("/bin/sh", [SCRIPT, ...command], {
    env: { PATH: process.env.PATH ?? "", QA_APP_ROOT: root, MIRROR_DIR: join(root, ".mirrors"), QA_EXEC_ROOT: join(root, "exec"), ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("the data and config directories and the API token are closed at boot, whatever mode they had", () => {
  const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
  try {
    mkdirSync(join(root, "data"), { mode: 0o755 });
    mkdirSync(join(root, "config"), { mode: 0o755 });
    writeFileSync(join(root, "config", ".api_token"), "t", { mode: 0o644 });
    chmodSync(join(root, "config", ".api_token"), 0o644);
    boot(root);
    assert.equal(mode(join(root, "data")), 0o700);
    assert.equal(mode(join(root, "config")), 0o750);
    assert.equal(mode(join(root, "config", ".api_token")), 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mirror root is traversable and not listable, and every mirror is closed to all but its owner", () => {
  const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
  try {
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, ".mirrors", "org__a"), { recursive: true, mode: 0o755 });
    mkdirSync(join(root, ".mirrors", "org__b"), { recursive: true, mode: 0o777 });
    chmodSync(join(root, ".mirrors", "org__a"), 0o755);
    chmodSync(join(root, ".mirrors", "org__b"), 0o777);
    boot(root);
    assert.equal(mode(join(root, ".mirrors")), 0o711);
    assert.equal(mode(join(root, ".mirrors", "org__a")), 0o750);
    assert.equal(mode(join(root, ".mirrors", "org__b")), 0o750);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mirror that is a link is not followed", () => {
  const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "entrypoint-elsewhere-"));
  try {
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, ".mirrors"));
    chmodSync(elsewhere, 0o755);
    symlinkSync(elsewhere, join(root, ".mirrors", "link"));
    boot(root);
    assert.equal(mode(elsewhere), 0o755, "the target of the link is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("the per-run work root is created traversable and unlistable, and the command it was given runs", () => {
  const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
  try {
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "config"));
    const out = boot(root, ["echo", "service-started"]);
    assert.match(out, /service-started/);
    assert.equal(mode(join(root, "exec")), 0o711);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the code-graph volume (every indexed repo's structure) is closed at boot like the data directory", () => {
  const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
  try {
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, ".codebase-memory"), { mode: 0o755 });
    chmodSync(join(root, ".codebase-memory"), 0o755);
    boot(root);
    assert.equal(mode(join(root, ".codebase-memory")), 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the code-graph directory is found where CBM_CACHE_DIR says, a link is not followed, and a missing one is not an error", () => {
  const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "entrypoint-elsewhere-"));
  try {
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "graphs"), { mode: 0o755 });
    chmodSync(join(root, "graphs"), 0o755);
    execFileSync("/bin/sh", [SCRIPT, "true"], {
      env: { PATH: process.env.PATH ?? "", QA_APP_ROOT: root, MIRROR_DIR: join(root, ".mirrors"), QA_EXEC_ROOT: join(root, "exec"), CBM_CACHE_DIR: join(root, "graphs") },
      stdio: "ignore",
    });
    assert.equal(mode(join(root, "graphs")), 0o700);
    chmodSync(elsewhere, 0o755);
    symlinkSync(elsewhere, join(root, ".codebase-memory"));
    boot(root);
    assert.equal(mode(elsewhere), 0o755, "the target of the link is untouched");
    unlinkSync(join(root, ".codebase-memory"));
    assert.doesNotThrow(() => boot(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("the API token in the data directory and the root-only parent of the host's config folder are closed at boot", () => {
  const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
  try {
    mkdirSync(join(root, "data"), { mode: 0o755 });
    writeFileSync(join(root, "data", ".api_token"), "t", { mode: 0o644 });
    chmodSync(join(root, "data", ".api_token"), 0o644);
    mkdirSync(join(root, ".host", "config"), { recursive: true, mode: 0o755 });
    chmodSync(join(root, ".host"), 0o755);
    chmodSync(join(root, ".host", "config"), 0o777);
    symlinkSync(".host/config", join(root, "config"));
    boot(root);
    assert.equal(mode(join(root, "data", ".api_token")), 0o600);
    assert.equal(mode(join(root, ".host")), 0o700);
    assert.equal(mode(join(root, ".host", "config")), 0o750);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file-boundary status left by an earlier boot is removed, so a check that does not run leaves none to be trusted", () => {
  const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
  try {
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "config"));
    const status = join(root, "files.status");
    writeFileSync(status, "ok\n");
    execFileSync("/bin/sh", [SCRIPT, "true"], {
      env: { PATH: process.env.PATH ?? "", QA_APP_ROOT: root, MIRROR_DIR: join(root, ".mirrors"), QA_EXEC_ROOT: join(root, "exec"), QA_FILE_BOUNDARY_STATUS_FILE: status },
      stdio: "ignore",
    });
    assert.equal(existsSync(status), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("what the sandbox uid's TypeScript loader cached in the temporary directory is removed at boot, before anything is checked", () => {
  const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
  try {
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "config"));
    const temp = join(root, "tmp");
    mkdirSync(join(temp, "tsx-4242", "deep"), { recursive: true });
    writeFileSync(join(temp, "tsx-4242", "deep", "planted.js"), "forged");
    mkdirSync(join(temp, "tsx-0"));
    writeFileSync(join(temp, "tsx-0", "root-cache"), "kept");
    writeFileSync(join(temp, "unrelated"), "kept");
    boot(root, ["true"], { TMPDIR: temp, CODE_SANDBOX_UID: "4242" });
    assert.equal(existsSync(join(temp, "tsx-4242")), false);
    assert.equal(existsSync(join(temp, "tsx-0", "root-cache")), true, "only the sandbox uid's cache goes");
    assert.equal(existsSync(join(temp, "unrelated")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
