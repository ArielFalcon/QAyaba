/* Finds the console calls a source file makes: a `console.<method>` in code position, not in a comment, a string, a regular expression or the text of a template literal (source text for a page or a child process). */

const CONSOLE_CALL = /^console\.(?:log|warn|error|info|debug)\b/;
/* A `/` after one of these characters starts a regular expression; after anything else it divides. */
const REGEX_AFTER_CHAR = "(,=:[!&|?{};+-*%<>~^";
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await"]);

/* The 1-based lines of the console calls in the source. */
export function consoleCallLines(source: string): number[] {
  const hits: number[] = [];
  const n = source.length;
  /* One counter per open `${ }` expression: the braces opened inside it and not yet closed. */
  const expressions: number[] = [];
  let line = 1;
  let i = 0;
  let previous = "";
  let previousWord = "";

  const templateText = (): void => {
    while (i < n) {
      const c = source[i]!;
      if (c === "\\") {
        if (source[i + 1] === "\n") line++;
        i += 2;
      } else if (c === "`") {
        i++;
        return;
      } else if (c === "$" && source[i + 1] === "{") {
        expressions.push(0);
        i += 2;
        return;
      } else {
        if (c === "\n") line++;
        i++;
      }
    }
  };

  while (i < n) {
    const c = source[i]!;
    const d = source[i + 1];
    if (c === "\n") {
      line++;
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && d === "/") {
      while (i < n && source[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      line += (source.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && source[i] !== c && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      i++;
      previous = c;
      previousWord = "";
    } else if (c === "`") {
      i++;
      templateText();
      previous = "`";
      previousWord = "";
    } else if (c === "{") {
      if (expressions.length > 0) expressions[expressions.length - 1]!++;
      i++;
      previous = c;
      previousWord = "";
    } else if (c === "}") {
      i++;
      if (expressions.length > 0 && expressions[expressions.length - 1] === 0) {
        expressions.pop();
        templateText();
        previous = "`";
      } else {
        if (expressions.length > 0) expressions[expressions.length - 1]!--;
        previous = c;
      }
      previousWord = "";
    } else if (c === "/" && (previous === "" || REGEX_AFTER_CHAR.includes(previous) || REGEX_AFTER_WORD.has(previousWord))) {
      i++;
      let inClass = false;
      while (i < n && source[i] !== "\n") {
        if (source[i] === "\\") i++;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) break;
        i++;
      }
      i++;
      previous = "/";
      previousWord = "";
    } else if (/[\w$]/.test(c)) {
      const start = i;
      while (i < n && /[\w$]/.test(source[i]!)) i++;
      const word = source.slice(start, i);
      if (word === "console" && source[start - 1] !== "." && CONSOLE_CALL.test(source.slice(start, start + 20))) hits.push(line);
      previous = word.slice(-1);
      previousWord = word;
    } else {
      i++;
      previous = c;
      previousWord = "";
    }
  }
  return hits;
}
