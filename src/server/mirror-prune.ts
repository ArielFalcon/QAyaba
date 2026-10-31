/*
 * The directories under the mirrors root that are not a repo's mirror, so the mirror pruning pass (the rule in the
 * workspace-and-publication context) leaves them alone however old they are. The folder names are the platform's
 * (src/paths.ts); the rule takes them as a parameter.
 */

import { DELEGATIONS_DIR, EXPERIMENT_COPIES_DIR, WARM_SNAPSHOTS_DIR } from "../paths";

export const RESERVED_MIRROR_DIR_NAMES: readonly string[] = [EXPERIMENT_COPIES_DIR, WARM_SNAPSHOTS_DIR, DELEGATIONS_DIR];
