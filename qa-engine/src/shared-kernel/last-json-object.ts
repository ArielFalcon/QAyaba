/*
 * Reads the JSON an agent put in free-form output. An agent narrates before its closing block, and the narration holds braces that
 * are not JSON (`{name, value, url}`, `async ({ page }) => {`) next to objects that are JSON but not the answer (an earlier
 * verdict, a quoted payload). Every `{` is therefore tried as the start of an object: a span that is not balanced, string- and
 * escape-aware, or does not parse is skipped one character on, never allowed to swallow what follows it. The answer is the object
 * that CLOSES the output: its last top-level object, with nothing after it that opens another. The reader never guesses which of
 * several objects is the answer, so a closing block that does not read leaves no answer rather than an earlier one.
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

/* A top-level JSON object of the text and where its span ends (exclusive). */
interface ObjectSpan {
  object: Record<string, unknown>;
  end: number;
}

/* Every top-level JSON object of the text with its span, in document order. Arrays and spans that do not parse are not objects. */
function objectSpansIn(text: string): ObjectSpan[] {
  const spans: ObjectSpan[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("{", from);
    if (start < 0) return spans;
    const end = balancedEnd(text, start);
    if (end === undefined) {
      from = start + 1;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        spans.push({ object: parsed as Record<string, unknown>, end });
        from = end;
        continue;
      }
    } catch {
      /* not JSON: the next brace may start the object */
    }
    from = start + 1;
  }
}

/* Every top-level JSON object of the text, in document order. Arrays and spans that do not parse are not objects. */
export function jsonObjectsIn(text: string): Record<string, unknown>[] {
  return objectSpansIn(text).map((span) => span.object);
}

/*
 * The object that closes the text: its last top-level object, when nothing after it opens another brace. A closing block that does
 * not parse (not JSON, cut short), or anything after the answer that opens a brace, leaves undefined: an earlier object, which the
 * agent may have revised or quoted, never stands in for it. The caller checks the object against its own contract.
 */
export function closingJsonObject(text: string): Record<string, unknown> | undefined {
  const last = objectSpansIn(text).at(-1);
  return last !== undefined && !text.includes("{", last.end) ? last.object : undefined;
}
