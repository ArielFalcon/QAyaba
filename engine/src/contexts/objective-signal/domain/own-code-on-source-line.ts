/* Whether a piece of the served script is the change's own code, told from the source it is placed in. Pure; no I/O.
   A build adds code of its own to what it serves (a framework's development guard, the lowering of `?.` or `??` to comparisons, a two-way binding's setter, a helper's checks) and its source map places that code on whatever source line it sits beside; a mutant or a decision of it speaks of the build, not of the change, and no test of the change can notice it.
   A mutation site is the change's when the expression it mutates is on the source line its map places it at (`expressionOnSourceLine`): matched loosely, since a build rewrites what it keeps (quotes, spacing, a local's name), and strictly enough that an expression none of whose names is on the line is never taken for it: at least one name of the expression (an identifier or a property, outside its string literals, not a keyword) must be a name of the line, and every comparison or logical operator of the expression (the swapped one included) must stand on the line as that operator. What cannot be matched is no candidate.
   A branch decision is judged on its evidence of being the build's, never on its absence from one line (`buildAddedDecision`): a decision's operands may hold lowered code and a map places a multi-line decision on any of its lines, so a decision stays unless nothing of it is in its file, or its line holds what it talks about but not the operator that makes it a decision; the null check a build writes for the author's `?.` or `??` is the author's decision, whatever operator heads it. What cannot be told stays. */

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

/* A comparison with `null`, `undefined` or `void 0`: what a build lowers `?.` and `??` to. */
const NULL_CHECK = /[=!]==?\s*(?:null|undefined|void\s+0)(?![\p{L}\p{N}_$])/u;
/* The source forms a null check is lowered from. */
const NULLISH_SYNTAX = /\?\.(?!\d)|\?\?/;

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

/* Whether `text` is an operator whose presence in the source shows a decision. */
export const isDecisionOperator = (text: string): boolean => DECISION_OPERATORS.has(text);

/* Why a decision of the served script is the build's: nothing of it is in its file, or its line holds what it talks about but not the operator that makes it a decision. */
export type DecisionSkipReason = "not-in-source" | "not-in-source-line";

/* The most decisions a record lists; the count stays whole. */
export const MAX_RECORDED_SKIPPED_DECISIONS = 50;

export interface SkippedDecision {
  file: string;
  line: number;
  column: number;
  kind: string;
  reason: DecisionSkipReason;
}

/* The decisions on changed lines that are the build's and so left out of the measurement: how many, how many for each reason, and which (at most MAX_RECORDED_SKIPPED_DECISIONS). */
export interface SkippedDecisions {
  count: number;
  reasons: Partial<Record<DecisionSkipReason, number>>;
  decisions: SkippedDecision[];
}

/* What a decision of the served script is made of: the expression it decides on, and the operator that makes it a decision when it has one (the logical operator, or the comparison or logical operator at the top of a condition). */
export interface DecisionHead {
  expression: string;
  operator?: string;
}

/* A changed file's source as a decision is looked for in it: every name it holds, and its lines. */
export interface DecisionSource {
  names: ReadonlySet<string>;
  lineAt: (line: number) => string | undefined;
}

export function decisionSourceOf(text: string): DecisionSource {
  const lines = text.split(/\r?\n/);
  return { names: namesOf(text), lineAt: (line) => lines[line - 1] };
}

/* A line that carries on the one before it with an operator of its own (a formatter that breaks before `&&` or `?`). */
const CONTINUES = /^\s*(?:&&|\|\||\?\?|\?|:|===?|!==?|<=|>=)/;

/* The line a decision is placed at and the lines that carry it on with an operator. */
function lineAndContinuations(source: DecisionSource, line: number): string | undefined {
  const here = source.lineAt(line);
  if (here === undefined) return undefined;
  const parts = [here];
  for (let next = source.lineAt(line + parts.length); next !== undefined && CONTINUES.test(next); next = source.lineAt(line + parts.length)) parts.push(next);
  return parts.join("\n");
}

/*
 * Why the decision placed at `line` of its source is the build's, or undefined when it may be the change's. Evidence of the build: no name of
 * the decision's expression is a name of the file (a framework's `ngDevMode` guard), or the line it is placed at holds a name of it but
 * not its operator (a two-way binding's `setter(x, $event) || (x = $event)` placed on `[(value)]="x"`); a null check on a line that holds
 * `?.` or `??` is that operator lowered (`(tmp = a) == null`, `(tmp = a.b) !== null && tmp !== void 0`) and stays. A line holding none of its names says
 * nothing: a map places a decision on any line of a multi-line statement, and a template's bindings are placed beside their element. A
 * decision with no name, or no source line to read, stays.
 */
export function buildAddedDecision(head: DecisionHead, line: number, source: DecisionSource): DecisionSkipReason | undefined {
  const names = namesOf(head.expression.replace(STRING_LITERAL, " "));
  if (names.size === 0) return undefined;
  if (![...names].some((name) => source.names.has(name))) return "not-in-source";
  if (head.operator === undefined) return undefined;
  const region = lineAndContinuations(source, line);
  if (region === undefined) return undefined;
  const regionNames = namesOf(source.lineAt(line)!);
  if (![...names].some((name) => regionNames.has(name))) return undefined;
  if (holdsOperator(region, head.operator)) return undefined;
  return NULL_CHECK.test(head.expression) && NULLISH_SYNTAX.test(region) ? undefined : "not-in-source-line";
}
