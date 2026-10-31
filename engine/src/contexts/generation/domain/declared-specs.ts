/* What a generator's verdict declares about the specs it delivered: every reported spec, in the order reported and once each, with the flow and the objective its meta states when it has one. The specs decide which entries exist, so a meta that names a spec the verdict did not report adds nothing, and a spec reported without a meta is declared by its path alone. A spec and its meta are the same file however they spell the path. */
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { upsertDeliveredSpec, type DeliveredSpec } from "@kernel/delivered-spec.ts";

export function declareSpecs(specs: readonly string[], metas: readonly DeliveredSpec[] | undefined): DeliveredSpec[] {
  const reported = specs.reduce<DeliveredSpec[]>((entries, spec) => upsertDeliveredSpec(entries, { file: spec }), []);
  const reportedFiles = new Set(reported.map((entry) => entry.file));
  return (metas ?? []).reduce((entries, meta) => (reportedFiles.has(normalizeSpecPath(meta.file)) ? upsertDeliveredSpec(entries, meta) : entries), reported);
}
