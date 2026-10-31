/* Decodes a run_scores `value` column according to its `data_type`; undefined when it does not hold that type. */
export function scoreValueOf(raw: string, dataType: string): number | boolean | string | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (dataType === "NUMERIC") return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  if (dataType === "BOOLEAN") return typeof v === "boolean" ? v : undefined;
  if (dataType === "CATEGORICAL") return typeof v === "string" ? v : undefined;
  return undefined;
}
