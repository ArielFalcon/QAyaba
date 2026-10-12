/* The file boundary is proven at boot by trying, as the sandbox uid, to do what it must not: these pin which attempts are made, what an outcome means and what the service reads back. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatFileBoundaryStatus,
  judgeFileBoundary,
  mountPointsUnder,
  parseFileBoundaryStatus,
  planFileBoundaryProbes,
  readProbeReport,
  type FileBoundaryLayout,
  type FileBoundaryProbe,
} from "../../../src/shared-infrastructure/process-sandbox/file-boundary.ts";

const MOUNTINFO = [
  "199 180 0:44 / / rw,relatime master:9 - overlay overlay rw,lowerdir=/x",
  "208 199 0:45 /Users/me/repo/web /app/web ro,nosuid,nodev,relatime - fakeowner /run/host_mark/Users rw,fakeowner",
  "209 199 0:45 /Users/me/repo/config /app/.host/config rw,nosuid,nodev,relatime - fakeowner /run/host_mark/Users rw,fakeowner",
  "213 199 254:1 /docker/volumes/mirrors/_data /app/.mirrors rw,relatime master:1 - ext4 /dev/vda1 rw,discard",
  "214 199 254:1 /docker/volumes/data/_data /app/data rw,relatime master:1 - ext4 /dev/vda1 rw,discard",
  "215 199 0:45 /Users/me/my\\040repo/src /app/src rw,nosuid,nodev,relatime - fakeowner /run/host_mark/Users rw,fakeowner",
  "216 199 0:45 /Users/me/repo/package.json /app/package.json ro,nosuid - fakeowner /run/host_mark/Users rw,fakeowner",
  "220 199 0:50 / /app2/elsewhere rw - ext4 /dev/vda1 rw",
  "221 199 0:51 / /etc/hosts rw - ext4 /dev/vda1 rw",
  "",
].join("\n");

const LAYOUT: FileBoundaryLayout = {
  appRoot: "/app",
  secretFiles: ["/proc/1/environ", "/app/data/.api_token"],
  closedDirs: ["/app/data", "/app/data/auth", "/app/config"],
  unwritable: ["/app/config", "/run/qa-file-boundary.status"],
};

test("the mounts under the app root are found in mountinfo, with escaped names decoded, and nothing outside it is taken", () => {
  assert.deepEqual(mountPointsUnder(MOUNTINFO, "/app"), ["/app/web", "/app/.host/config", "/app/.mirrors", "/app/data", "/app/src", "/app/package.json"]);
  assert.deepEqual(mountPointsUnder("garbage line\n\n", "/app"), []);
});

test("the plan tries to read every secret file, list every closed directory, and write the app root, every mount under it and every path that must stay unwritable", () => {
  const plan = planFileBoundaryProbes(LAYOUT, ["/app/src", "/app/data"]);
  const has = (kind: string, path: string): boolean => plan.some((p) => p.kind === kind && p.path === path);
  for (const path of LAYOUT.secretFiles) assert.ok(has("read", path), `read ${path}`);
  for (const path of LAYOUT.closedDirs) assert.ok(has("list", path), `list ${path}`);
  for (const path of ["/app", "/app/src", "/app/data", "/app/config", "/run/qa-file-boundary.status"]) assert.ok(has("write", path), `write ${path}`);
  assert.equal(plan.filter((p) => p.kind === "write" && p.path === "/app/data").length, 1, "a path is tried once per kind");
});

test("the child's raw observations are told apart: refused, missing, allowed, and an error that proves nothing is inconclusive", () => {
  const probes: FileBoundaryProbe[] = [
    { kind: "read", path: "/secret" },
    { kind: "read", path: "/gone" },
    { kind: "list", path: "/open" },
    { kind: "list", path: "/odd" },
    { kind: "write", path: "/ro" },
  ];
  const results = readProbeReport(probes, JSON.stringify([{ code: "EACCES" }, { code: "ENOENT" }, { code: null }, { code: "EIO" }, { code: "EROFS", kind: "dir" }]));
  assert.deepEqual(results.map((r) => r.outcome), ["refused", "absent", "allowed", "inconclusive", "refused"]);
  assert.equal(results[3]!.code, "EIO");
});

test("a write counts by what the child found at the path: a directory or a file it could write is allowed, anything else proves nothing", () => {
  const probes: FileBoundaryProbe[] = [
    { kind: "write", path: "/dir" },
    { kind: "write", path: "/file" },
    { kind: "write", path: "/pipe" },
    { kind: "write", path: "/missing" },
    { kind: "write", path: "/closed" },
  ];
  const results = readProbeReport(probes, JSON.stringify([
    { kind: "dir", code: null },
    { kind: "file", code: null },
    { kind: "other", code: null },
    { code: "ENOENT" },
    { code: "EACCES" },
  ]));
  assert.deepEqual(results.map((r) => r.outcome), ["allowed", "allowed", "inconclusive", "absent", "refused"]);
});

test("the boundary holds only when every attempt was refused or found nothing; each exposure is named", () => {
  const probes: FileBoundaryProbe[] = [
    { kind: "read", path: "/app/data/.api_token" },
    { kind: "list", path: "/app/config" },
    { kind: "write", path: "/app/src" },
    { kind: "write", path: "/app/web" },
    { kind: "read", path: "/proc/1/environ" },
  ];
  const holds = judgeFileBoundary(probes, probes.map((probe) => ({ probe, outcome: probe.path === "/app/web" ? "absent" as const : "refused" as const })));
  assert.deepEqual(holds, { holds: true });

  const open = judgeFileBoundary(probes, [
    { probe: probes[0]!, outcome: "allowed" },
    { probe: probes[1]!, outcome: "allowed" },
    { probe: probes[2]!, outcome: "allowed" },
    { probe: probes[3]!, outcome: "inconclusive", code: "EIO" },
  ]);
  assert.equal(open.holds, false);
  const said = open.holds ? "" : open.exposures.join("\n");
  assert.match(said, /\/app\/data\/\.api_token is readable/);
  assert.match(said, /\/app\/config is listable/);
  assert.match(said, /\/app\/src is writable/);
  assert.match(said, /\/app\/web could not be checked \(EIO\)/);
  assert.match(said, /\/proc\/1\/environ was not checked/, "an attempt with no result is not a pass");
});

test("the status the boot check leaves is read back as it was written, and anything else is a boundary that does not hold", () => {
  assert.deepEqual(parseFileBoundaryStatus(formatFileBoundaryStatus({ holds: true })), { holds: true });
  const written = formatFileBoundaryStatus({ holds: false, exposures: ["/app/src is writable by the sandbox uid", "/app/config is listable by the sandbox uid"] });
  const read = parseFileBoundaryStatus(written);
  assert.equal(read.holds, false);
  assert.match(read.reason ?? "", /\/app\/src is writable.*\/app\/config is listable/);
  for (const text of [undefined, "", "OK", "okay", "garbage"]) {
    const r = parseFileBoundaryStatus(text);
    assert.equal(r.holds, false, JSON.stringify(text));
    assert.ok(r.reason, JSON.stringify(text));
  }
  assert.match(parseFileBoundaryStatus(undefined).reason ?? "", /no boot check result/);
});

test("a long list of exposures is cut in the status, and the cut says how many were left out", () => {
  const exposures = Array.from({ length: 200 }, (_, i) => `/app/mount-${i} is writable by the sandbox uid`);
  const read = parseFileBoundaryStatus(formatFileBoundaryStatus({ holds: false, exposures }));
  assert.equal(read.holds, false);
  assert.ok((read.reason ?? "").length < 2000);
  assert.match(read.reason ?? "", /more/);
});

test("the report of the probing child is believed only where it answers the attempt that was asked, in a shape it may have", () => {
  const probes: FileBoundaryProbe[] = [{ kind: "read", path: "/a" }, { kind: "write", path: "/b" }];
  const good = readProbeReport(probes, JSON.stringify([{ code: "EACCES" }, { kind: "dir", code: "EIO" }]));
  assert.deepEqual(good, [{ probe: probes[0], outcome: "refused" }, { probe: probes[1], outcome: "inconclusive", code: "EIO" }]);
  const unreadable = [
    "",
    "not json",
    "{}",
    JSON.stringify([{ code: "EACCES" }]),
    JSON.stringify([{ code: "EACCES" }, { kind: "dir", code: 5 }]),
    JSON.stringify([{ code: "EACCES" }, null]),
    JSON.stringify([{ outcome: "refused" }, { outcome: "refused" }]),
    JSON.stringify([{ code: null, kind: "dir" }, { kind: "dir", code: null }]),
    JSON.stringify([{ code: "EACCES" }, { code: null }]),
    JSON.stringify([{ code: "EACCES" }, { kind: "socket", code: null }]),
  ];
  for (const text of unreadable) {
    const results = readProbeReport(probes, text);
    assert.equal(judgeFileBoundary(probes, results).holds, false, text);
  }
});
