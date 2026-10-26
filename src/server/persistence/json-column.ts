import { logJson } from "../../integrations/logger";
import { RedactionPortAdapter } from "../../orchestrator/sanitizer";

const redactionPort = new RedactionPortAdapter();

export interface JsonColumnSite {
  table: string;
  column: string;
  /* The row's key, so the line names which row is corrupt. */
  id: string;
}

/* Parses a JSON-valued column. A value that does not parse is logged at `warn` (table, column, row, redacted error) and `fallback` is returned: a corrupt column is never silent. */
export function parseJsonColumn<T>(raw: string, fallback: T, site: JsonColumnSite): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logJson("warn", `corrupt JSON in ${site.table}.${site.column} of row '${site.id}'; using the fallback`, {
      table: site.table,
      column: site.column,
      id: site.id,
      error: redactionPort.redactError(error),
    });
    return fallback;
  }
}
