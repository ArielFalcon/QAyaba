/* The non-code files a source file declares itself: the relative string literals in it that name a file which is not source code, such as a page's template or style sheet (`templateUrl: './x.html'`, `styleUrls: ['./x.scss']`, `import './x.css'`, `require('./x.html')`). Only what the file says counts. A sibling is never guessed from a name, so a file nobody declares is not tied to the page. A source file is repo content of unknown shape: what is found here is a candidate that the caller still has to find in the repository. */

/* The most files one source file declares: a page names a template and a few style sheets, so this is far above any real one. */
export const MAX_DECLARED_PER_FILE = 32;
/* A literal longer than this is no path. */
const MAX_LITERAL_CHARS = 256;

/* A string literal in single, double or back quotes that starts with `./` or `../`. A back-quoted literal with an interpolation is not matched: it names no one file. */
const RELATIVE_LITERAL = /(['"`])(\.{1,2}\/[^'"`\n\r\\$]*)\1/g;

/* The literal's path without a query or a fragment (`./x.html?raw`), or undefined when it names no file with an extension. */
function pathOf(literal: string): string | undefined {
  const path = literal.replace(/[?#].*$/, "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.includes(".") && !name.startsWith(".") && !name.endsWith(".") ? path : undefined;
}

/* `relative` taken from the directory of `fromFile`, as a repo-relative path with "/" separators, or undefined when it climbs out of the repository. */
function resolveFrom(fromFile: string, relative: string): string | undefined {
  const segments = fromFile.replaceAll("\\", "/").split("/").filter((segment) => segment !== "" && segment !== ".");
  segments.pop();
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

/* The repo-relative files `source` (the text of `fromFile`) declares by relative path literals and that `isSourceCode` does not take for source, in the order it names them, each once, at most MAX_DECLARED_PER_FILE. */
export function declaredRelativeFiles(source: string, fromFile: string, isSourceCode: (file: string) => boolean): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(RELATIVE_LITERAL)) {
    if (found.size >= MAX_DECLARED_PER_FILE) break;
    const literal = match[2] ?? "";
    if (literal.length > MAX_LITERAL_CHARS) continue;
    const path = pathOf(literal);
    if (path === undefined) continue;
    const resolved = resolveFrom(fromFile, path);
    if (resolved === undefined || resolved === "" || isSourceCode(resolved)) continue;
    found.add(resolved);
  }
  return [...found];
}
