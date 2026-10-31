import { test } from "node:test";
import assert from "node:assert/strict";
import { RESERVED_MIRROR_DIR_NAMES } from "./mirror-prune";
import { defaultMirrorPruneDeps } from "./wire-app";
import { DELEGATIONS_DIR, EXPERIMENT_COPIES_DIR, WARM_SNAPSHOTS_DIR } from "../paths";

test("the mirrors root reserves every directory of it that is not a repo's mirror", () => {
  assert.deepEqual([...RESERVED_MIRROR_DIR_NAMES].sort(), [DELEGATIONS_DIR, EXPERIMENT_COPIES_DIR, WARM_SNAPSHOTS_DIR].sort());
});

test("the server's prune pass is handed every reserved directory, so a pass never removes a sidekick workspace, a warm snapshot or an experiment copy", () => {
  assert.deepEqual([...defaultMirrorPruneDeps(() => null).reservedDirNames].sort(), [DELEGATIONS_DIR, EXPERIMENT_COPIES_DIR, WARM_SNAPSHOTS_DIR].sort());
});
