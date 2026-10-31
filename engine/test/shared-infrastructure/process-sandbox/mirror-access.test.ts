/* The sandbox uid reaches one mirror at a time, for the length of a run. The file operations are recorded, not performed, so the rules are checked without being root. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeMirror, mirrorTopDir, openMirrorForSandbox, sealMirrors, type MirrorFsOps } from "../../../src/shared-infrastructure/process-sandbox/mirror-access.ts";

const SB = { uid: 1002, gid: 1002, home: "/home/sandbox" };

function recording(entries: Record<string, { dir: boolean; uid: number }>): { ops: MirrorFsOps; log: string[] } {
  const log: string[] = [];
  return {
    log,
    ops: {
      lstat: (path) => {
        const entry = entries[path];
        if (!entry) throw new Error(`ENOENT ${path}`);
        return { isDirectory: () => entry.dir, uid: entry.uid };
      },
      readdir: (path) => Object.keys(entries).filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/")).map((p) => p.slice(path.length + 1)),
      chown: (path, uid, gid) => { log.push(`chown ${path} ${uid}:${gid}`); },
      chmod: (path, mode) => { log.push(`chmod ${path} ${mode.toString(8)}`); },
    },
  };
}

test("the mirror a command runs in is found from its cwd, whatever depth it is at", () => {
  assert.equal(mirrorTopDir("/app/.mirrors", "/app/.mirrors/org__app/e2e"), "/app/.mirrors/org__app");
  assert.equal(mirrorTopDir("/app/.mirrors", "/app/.mirrors/org__app"), "/app/.mirrors/org__app");
  assert.equal(mirrorTopDir("/app/.mirrors", "/app/.mirrors"), undefined);
  assert.equal(mirrorTopDir("/app/.mirrors", "/app/.mirrors-evil/x"), undefined);
  assert.equal(mirrorTopDir("/app/.mirrors", "/tmp/elsewhere"), undefined);
});

test("sealing closes every mirror to all but root and leaves the root traversable, not listable", () => {
  const { ops, log } = recording({
    "/m/a": { dir: true, uid: 1002 },
    "/m/b": { dir: true, uid: 0 },
    "/m/file": { dir: false, uid: 0 },
  });
  sealMirrors("/m", ops);
  assert.ok(log.includes("chmod /m 711"));
  for (const mirror of ["/m/a", "/m/b"]) {
    assert.ok(log.includes(`chown ${mirror} 0:0`), mirror);
    assert.ok(log.includes(`chmod ${mirror} 750`), mirror);
  }
  assert.equal(log.some((line) => line.includes("/m/file")), false, "a plain file is left alone");
});

test("opening a mirror gives the sandbox's group traversal and says it did", () => {
  const { ops, log } = recording({ "/m/a": { dir: true, uid: 0 } });
  assert.equal(openMirrorForSandbox("/m/a", SB, ops), true);
  assert.deepEqual(log, ["chown /m/a 0:1002", "chmod /m/a 750"]);
});

test("a mirror the sandbox already owns, a non-directory and an absent sandbox are left as they are", () => {
  const owned = recording({ "/m/a": { dir: true, uid: 1002 } });
  assert.equal(openMirrorForSandbox("/m/a", SB, owned.ops), false);
  const file = recording({ "/m/a": { dir: false, uid: 0 } });
  assert.equal(openMirrorForSandbox("/m/a", SB, file.ops), false);
  const none = recording({ "/m/a": { dir: true, uid: 0 } });
  assert.equal(openMirrorForSandbox("/m/a", null, none.ops), false);
  assert.deepEqual([...owned.log, ...file.log, ...none.log], []);
});

test("closing a mirror returns it to root alone", () => {
  const { ops, log } = recording({ "/m/a": { dir: true, uid: 0 } });
  closeMirror("/m/a", ops);
  assert.deepEqual(log, ["chown /m/a 0:0", "chmod /m/a 750"]);
});
