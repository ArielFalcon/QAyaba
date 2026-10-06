/*
 * Refuses filesystem writes from a test process into the repository's tracked tree. node --test runs
 * test files in parallel, so a file planted under src/ or qa-engine/src/ — even one removed in a
 * finally — is visible to every concurrent test that scans the tree, and a crashed run leaves it
 * behind to be committed. Tests write to os.tmpdir() instead.
 *
 * The guard patches node:fs and node:fs/promises in place and re-syncs their ESM named exports, so
 * `import { writeFileSync } from "node:fs"` in a test module sees the guarded function. It cannot see
 * writes made by child processes (git, npx, a spawned node without this preload).
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/* Untracked directories under the repo root that the code under test may still write: installed
   dependencies only. data/ holds the running service's history, logs, telemetry and login material, so
   a test points those locations at os.tmpdir() instead (test-setup.mjs does it for the history
   database and the logs). */
const RUNTIME_DIRS = new Set(["node_modules"]);

const WRITE_OPEN_BITS =
  fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;

function toPath(p) {
  if (typeof p === "string") return p.startsWith("file:") ? fileURLToPath(p) : p;
  if (p instanceof URL) return fileURLToPath(p);
  if (Buffer.isBuffer(p)) return p.toString();
  return null; /* a file descriptor: the path was already checked when it was opened */
}

function opensForWrite(flags) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === "number") return (flags & WRITE_OPEN_BITS) !== 0;
  return /[wa+]/.test(String(flags));
}

export function installTrackedTreeWriteGuard(root) {
  const guardedRoot = resolve(root);

  function refuse(op, target) {
    const path = toPath(target);
    if (path === null) return;
    const rel = relative(guardedRoot, resolve(path));
    if (rel.startsWith("..") || isAbsolute(rel)) return;
    const top = rel.split(sep)[0];
    if (top && RUNTIME_DIRS.has(top)) return;
    const err = new Error(
      `a test tried to ${op} "${rel || "."}" inside the repository's tracked tree — tests must write under os.tmpdir()`,
    );
    err.code = "ERR_TEST_TRACKED_TREE_WRITE";
    throw err;
  }

  /* [name, indices of path arguments that receive the write] */
  const writers = [
    ["writeFile", [0]],
    ["appendFile", [0]],
    ["mkdir", [0]],
    ["mkdtemp", [0]],
    ["rm", [0]],
    ["rmdir", [0]],
    ["unlink", [0]],
    ["truncate", [0]],
    ["rename", [0, 1]],
    ["copyFile", [1]],
    ["cp", [1]],
    ["symlink", [1]],
    ["link", [1]],
  ];

  function wrapSync(name, indices) {
    const original = fs[name];
    if (typeof original !== "function") return;
    fs[name] = function guarded(...args) {
      for (const i of indices) refuse(name, args[i]);
      return original.apply(this, args);
    };
  }

  function wrapPromise(target, name, indices, label) {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function guarded(...args) {
      try {
        for (const i of indices) refuse(label, args[i]);
      } catch (err) {
        return Promise.reject(err);
      }
      return original.apply(this, args);
    };
  }

  for (const [name, indices] of writers) {
    wrapSync(`${name}Sync`, indices);
    wrapSync(name, indices);
    wrapPromise(fs.promises, name, indices, name);
  }

  const openSync = fs.openSync;
  fs.openSync = function guarded(path, flags, ...rest) {
    if (opensForWrite(flags)) refuse("openSync", path);
    return openSync.call(this, path, flags, ...rest);
  };
  const open = fs.open;
  fs.open = function guarded(path, flags, ...rest) {
    if (typeof flags !== "function" && opensForWrite(flags)) refuse("open", path);
    return open.call(this, path, flags, ...rest);
  };
  const openAsync = fs.promises.open;
  fs.promises.open = function guarded(path, flags, ...rest) {
    try {
      if (opensForWrite(flags)) refuse("open", path);
    } catch (err) {
      return Promise.reject(err);
    }
    return openAsync.call(this, path, flags, ...rest);
  };
  const createWriteStream = fs.createWriteStream;
  fs.createWriteStream = function guarded(path, ...rest) {
    refuse("createWriteStream", path);
    return createWriteStream.call(this, path, ...rest);
  };

  syncBuiltinESMExports();
}
