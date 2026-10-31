/*
 * The containers a line of a template sits in, nearest first, named the way the DOM capture names a page's containers
 * (`[test-id="v"]`, `#id`, a custom element's tag): a changed line and the occurrence of its text on the live page are matched
 * by these names. Pure and markup-only: an element counts from its opening tag (a line inside that tag, an attribute line,
 * is in it) to its closing tag; a self-closing or void element contains only the lines of its own tag; a bound attribute (`[id]`, `:id`, `id={…}`)
 * names nothing, since its value is not in the source. A container with none of the three names is passed over.
 */

const TAG = /<(\/?)([A-Za-z][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

interface Open { tag: string; attrs: string }

function literal(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  const value = m?.[1] ?? m?.[2];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

function nameOf(open: Open, testIdAttr: string): string | undefined {
  const testId = literal(open.attrs, testIdAttr);
  if (testId !== undefined) return `[${testIdAttr}="${testId}"]`;
  const id = literal(open.attrs, "id");
  if (id !== undefined) return `#${id}`;
  const tag = open.tag.toLowerCase();
  return tag.indexOf("-") > 0 ? tag : undefined;
}

/** The named containers of 1-based `line` of `source`, nearest first; `[]` for a line outside the source or in none. */
export function enclosingScope(source: string, line: number, testIdAttr = "data-testid"): string[] {
  const lines = source.split("\n");
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return [];
  const lineStart = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  const lineEnd = lineStart + lines[line - 1]!.length;
  const stack: Open[] = [];
  TAG.lastIndex = 0;
  for (let m = TAG.exec(source); m !== null && m.index <= lineEnd; m = TAG.exec(source)) {
    const [whole, closing, tag, attrs, selfClosing] = m;
    const open: Open = { tag: tag!, attrs: attrs! };
    const tagEnd = m.index + whole.length;
    if (closing) {
      const at = stack.map((o) => o.tag.toLowerCase()).lastIndexOf(tag!.toLowerCase());
      if (tagEnd <= lineStart && at !== -1) stack.length = at;
      continue;
    }
    if (selfClosing || VOID.has(tag!.toLowerCase())) {
      /* It contains nothing, but a line of its own tag (an attribute line) is in it. */
      if (tagEnd > lineStart) {
        stack.push(open);
        break;
      }
      continue;
    }
    /* Every opening tag up to the line contains it, the one the line is part of included (its attribute lines). */
    stack.push(open);
  }
  return stack.reverse().flatMap((o) => nameOf(o, testIdAttr) ?? []);
}
