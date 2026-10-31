/* What the boot check tries on this host's layout: the status files the service trusts must be unwritable, and so must the directory they sit in. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeRootsOf, fileBoundaryLayout } from "./file-boundary-check";
import { fileBoundaryStatusFile } from "../settings/sandbox-status";

test("the directory each status file sits in must refuse a write as well as the files", () => {
  const layout = fileBoundaryLayout({}, "/app");
  for (const file of [fileBoundaryStatusFile({}), "/run/qa-egress.status"]) {
    assert.ok(layout.unwritable.includes(file), file);
    assert.ok(layout.unwritable.includes("/run"), "a file that is absent when the probe runs proves nothing about who may create it");
  }
});

test("the directories follow the paths the status files are configured at", () => {
  const layout = fileBoundaryLayout({ QA_FILE_BOUNDARY_STATUS_FILE: "/state/a/boundary.status", QA_EGRESS_STATUS_FILE: "/other/egress.status" }, "/app");
  assert.ok(layout.unwritable.includes("/state/a"));
  assert.ok(layout.unwritable.includes("/other"));
  assert.ok(layout.unwritable.includes("/state/a/boundary.status"));
});

test("the layout holds every code root unwritable, and the smoke plants into exactly those", () => {
  const layout = fileBoundaryLayout({}, "/app");
  for (const root of ["platform", "engine", "bin", "scripts"]) assert.ok(layout.unwritable.includes(`/app/${root}`), root);
  assert.deepEqual(codeRootsOf(layout).sort(), ["/app/bin", "/app/engine", "/app/platform", "/app/scripts"]);
});

test("a retired code folder is in no code root the smoke plants into", () => {
  assert.ok(!codeRootsOf(fileBoundaryLayout({}, "/app")).includes("/app/src"));
});
