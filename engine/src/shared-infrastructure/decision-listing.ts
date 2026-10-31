/*
 * The static decision listing: the decisions on a changed file's changed lines, read from its source text before anything runs.
 * The language registry declares which syntax reads each language (`LanguageRegistry.decisionSyntaxForFile`); a language with
 * none is unlisted, and a file its lister cannot parse lists nothing and says so. A decision is changed when a changed line
 * holds its head (an if's keyword and condition, a conditional's condition, a logical operator's left operand and operator, a
 * switch's discriminant or one of its case labels); it is placed at the line its condition starts on, as the run's branch
 * measurement places it. Pure and deterministic: no file is read here.
 */
import ts from "typescript";
import { LanguageRegistry, type DecisionSyntax } from "@kernel/language-id.ts";
import type { ChangedDecision, DecisionArm, DecisionKind } from "@kernel/changed-decision.ts";

export type FileDecisions = { decisions: ChangedDecision[] } | { unparsed: true } | { unlisted: true };

/* A decision found in the source: its head's span (offsets), where its condition starts, its kind and its arms (offsets of their code). */
interface FoundDecision {
  heads: Array<{ start: number; end: number }>;
  at: number;
  kind: DecisionKind;
  arms: Array<{ label: string; at?: number }>;
}

/* The source parsed, or undefined when it does not parse. */
type Lister = (file: string, source: string) => { found: FoundDecision[]; lineOf: (offset: number) => number } | undefined;

const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);
const MAX_CASE_LABEL = 40;

function scriptKindOf(file: string): ts.ScriptKind {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "tsx") return ts.ScriptKind.TSX;
  if (ext === "jsx") return ts.ScriptKind.JSX;
  if (ext === "ts" || ext === "mts" || ext === "cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

const listEcmascript: Lister = (file, source) => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, scriptKindOf(file));
  /* The parser's own syntax errors; the compiler API keeps them on the source file without declaring them. */
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return undefined;
  const start = (node: ts.Node): number => node.getStart(sf);
  const found: FoundDecision[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      found.push({
        heads: [{ start: start(node), end: node.expression.end }],
        at: start(node.expression),
        kind: "if",
        arms: [{ label: "then", at: start(node.thenStatement) }, node.elseStatement ? { label: "else", at: start(node.elseStatement) } : { label: "else" }],
      });
    } else if (ts.isConditionalExpression(node)) {
      found.push({ heads: [{ start: start(node.condition), end: node.questionToken.end }], at: start(node.condition), kind: "conditional", arms: [{ label: "true", at: start(node.whenTrue) }, { label: "false", at: start(node.whenFalse) }] });
    } else if (ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind)) {
      const operator = node.operatorToken.getText(sf);
      found.push({ heads: [{ start: start(node.left), end: node.operatorToken.end }], at: start(node.left), kind: "logical", arms: [{ label: `right of ${operator} evaluated`, at: start(node.right) }, { label: `${operator} short-circuited` }] });
    } else if (ts.isSwitchStatement(node)) {
      const clauses = node.caseBlock.clauses;
      found.push({
        heads: [{ start: start(node), end: node.expression.end }, ...clauses.map((clause) => ({ start: start(clause), end: ts.isCaseClause(clause) ? clause.expression.end : start(clause) + "default".length }))],
        at: start(node.expression),
        kind: "switch",
        arms: clauses.map((clause) => ({ label: ts.isCaseClause(clause) ? `case ${clause.expression.getText(sf).slice(0, MAX_CASE_LABEL)}` : "default", at: start(clause) })),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { found, lineOf: (offset) => sf.getLineAndCharacterOfPosition(offset).line + 1 };
};

/* One lister per syntax the registry declares: a syntax without one fails to compile. */
const LISTERS: Record<DecisionSyntax, Lister> = { ecmascript: listEcmascript };

/* The decisions of `file` whose head a line of `changedLines` (1-based, new side) holds, in source order. */
export function listDecisions(file: string, source: string, changedLines: ReadonlySet<number>): FileDecisions {
  const syntax = LanguageRegistry.decisionSyntaxForFile(file);
  if (syntax === null) return { unlisted: true };
  const parsed = LISTERS[syntax](file, source);
  if (parsed === undefined) return { unparsed: true };
  const { found, lineOf } = parsed;
  const changed = (head: { start: number; end: number }): boolean => {
    for (let line = lineOf(head.start), last = lineOf(head.end); line <= last; line++) if (changedLines.has(line)) return true;
    return false;
  };
  const decisions = found
    .map((decision, order) => ({ decision, order }))
    .filter(({ decision }) => decision.heads.some(changed))
    .sort((a, b) => a.decision.at - b.decision.at || a.order - b.order)
    .map(({ decision }): ChangedDecision => ({
      file,
      line: lineOf(decision.at),
      kind: decision.kind,
      arms: decision.arms.map((arm): DecisionArm => (arm.at === undefined ? { label: arm.label } : { label: arm.label, line: lineOf(arm.at) })),
    }));
  return { decisions };
}
