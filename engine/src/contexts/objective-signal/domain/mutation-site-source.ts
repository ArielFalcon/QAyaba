/* Whether a mutation site of the served script is the change's own code: the expression it mutates must be found on the source line the script's map places it at. Pure; no I/O.
   A build adds code of its own to what it serves (a framework's development guard, the lowering of `?.` or `??` to comparisons, a helper's checks) and its source map places that code on whatever source line it sits beside; a mutant of it speaks of the build, not of the change, and no test of the change can notice it. The source line is matched loosely, since a build rewrites what it keeps (quotes, spacing, a local's name), and strictly enough that an expression none of whose names is on the line is never taken for it: at least one name of the expression (an identifier or a property, outside its string literals, not a keyword) must be a name of the line, and every comparison or logical operator of the expression (the swapped one included) must stand on the line as that operator. What cannot be matched is no candidate. */

/* Why a site is not a candidate: no source text could be had for its line, or the line does not hold its expression. */
export type SiteSkipReason = "no-source-line" | "not-in-source-line";

/* The words of the language that name no value of the program, so they cannot tell the change's code from the build's. */
const KEYWORDS = new Set(["this", "typeof", "void", "null", "undefined", "true", "false", "new", "in", "instanceof", "delete", "await", "yield", "of", "function", "return", "var", "let", "const", "if", "else", "super", "NaN", "Infinity"]);
const NAME = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;
/* The characters an operator is made of: an operator stands alone when none of them touches it. */
const OPERATOR_CHARS = "=!<>&|?";
const OPERATOR_RUN = /[=!<>&|?]+/g;
/* The operators whose presence a decision of the source shows: a build that lowers `?.` or `??`, or adds a guard, adds them. */
const DECISION_OPERATORS = new Set(["===", "!==", "==", "!=", "<", "<=", ">", ">=", "&&", "||", "??"]);

const namesOf = (text: string): Set<string> => new Set([...text.matchAll(NAME)].map((m) => m[0]).filter((name) => !KEYWORDS.has(name)));
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* Whether `operator` stands on `line` as itself, not as a part of a longer operator (`==` of `===`, `>` of `=>`). */
function holdsOperator(line: string, operator: string): boolean {
  const chars = escape(OPERATOR_CHARS);
  return new RegExp(`(?<![${chars}])${escape(operator)}(?![${chars}])`).test(line);
}

/* Whether the site's expression is on `line`. `expression` is the whole expression the site mutates (the condition negated, or the comparison or logical expression whose operator is swapped); `operator` is the swapped operator's text, for a swap. */
export function expressionOnSourceLine(site: { expression: string; operator?: string }, line: string): boolean {
  const code = site.expression.replace(STRING_LITERAL, " ");
  const lineNames = namesOf(line);
  if (![...namesOf(code)].some((name) => lineNames.has(name))) return false;
  const operators = new Set([...code.matchAll(OPERATOR_RUN)].map((m) => m[0]).filter((run) => DECISION_OPERATORS.has(run)));
  if (site.operator !== undefined) operators.add(site.operator);
  return [...operators].every((operator) => holdsOperator(line, operator));
}
