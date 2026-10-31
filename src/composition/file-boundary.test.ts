/* What the boot check tries at the composition root's layout: the status files the service trusts must be unwritable, and so must the directory they sit in. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileBoundaryLayout, fileBoundaryStatusFile } from "./file-boundary";

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
