/*
 * Reads the JSON an agent put in free-form output. An agent narrates before its closing block, and the narration holds braces that
 * are not JSON (`{name, value, url}`, `async ({ page }) => {`) next to objects that are JSON but not the answer (an earlier
 * verdict, a quoted payload). Every `{` is therefore tried as the start of an object: a span that is not balanced, string- and
 * escape-aware, or does not parse is skipped one character on, never allowed to swallow what follows it. The answer is the LAST
 * top-level object the caller's own check accepts.
 */

/* The span end (exclusive) of the balanced object starting at `start`, or undefined when its braces never balance. */
function balancedEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

/* Every top-level JSON object of the text, in document order. Arrays and spans that do not parse are not objects. */
export function jsonObjectsIn(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("{", from);
    if (start < 0) return objects;
    const end = balancedEnd(text, start);
    if (end === undefined) {
      from = start + 1;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
        from = end;
        continue;
      }
    } catch {
      /* not JSON: the next brace may start the object */
    }
    from = start + 1;
  }
}

/* The last top-level JSON object of the text that `accept` holds for, or undefined. */
export function lastJsonObjectWhere(text: string, accept: (object: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  const objects = jsonObjectsIn(text);
  for (let i = objects.length - 1; i >= 0; i--) if (accept(objects[i]!)) return objects[i];
  return undefined;
}
