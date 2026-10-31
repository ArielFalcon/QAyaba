import { test } from "node:test";
import assert from "node:assert/strict";
import { RESERVED_MIRROR_DIR_NAMES } from "./mirror-prune";
import { DELEGATIONS_DIR, EXPERIMENT_COPIES_DIR, WARM_SNAPSHOTS_DIR } from "../paths";

test("the mirrors root reserves every directory of it that is not a repo's mirror", () => {
  assert.deepEqual([...RESERVED_MIRROR_DIR_NAMES].sort(), [DELEGATIONS_DIR, EXPERIMENT_COPIES_DIR, WARM_SNAPSHOTS_DIR].sort());
});
