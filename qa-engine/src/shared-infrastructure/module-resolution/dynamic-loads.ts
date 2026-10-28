/*
 * What a dynamic load names, read from its source at the position the code graph recorded it (1-based line, 0-based column of the
 * call), by the module syntax the language registry declares for the file: for `ecmascript-modules`, a dynamic `import(…)` or a
 * `require(…)` call, or a type that names a module (`typeof import(…)`, recorded at its `import` keyword), whose specifier is a
 * literal (a string, or a template with no substitution). A computed specifier, a position
 * that holds no such call, a source that does not parse and a language with no module syntax name nothing (undefined): whoever
 * reads the answer keeps such a load as one that may load any file. Pure: no file is read here.
 */
import ts from "typescript";
import { LanguageRegistry, type ModuleSyntax } from "@kernel/language-id.ts";

export interface LoadPosition {
  line: number;
  col: number;
}

type Reader = (file: string, source: string, positions: readonly LoadPosition[]) => Array<string | undefined>;

function scriptKindOf(file: string): ts.ScriptKind {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "tsx") return ts.ScriptKind.TSX;
  if (ext === "jsx") return ts.ScriptKind.JSX;
  if (ext === "ts" || ext === "mts" || ext === "cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

const isLoad = (call: ts.CallExpression): boolean =>
  call.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(call.expression) && call.expression.text === "require");

const literalOf = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

const readEcmascript: Reader = (file, source, positions) => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  /* The parser's own syntax errors; the compiler API keeps them on the source file without declaring them. */
  if (((sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []).length > 0) return positions.map(() => undefined);
  const byStart = new Map<string, string | undefined>();
  const record = (start: number, specifier: string | undefined): void => {
    const at = sf.getLineAndCharacterOfPosition(start);
    byStart.set(`${at.line + 1}:${at.character}`, specifier);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLoad(node)) record(node.getStart(sf), literalOf(node.arguments[0]));
    /* A type that names a module (`typeof import('…')`): the index records it at its `import` keyword, after any `typeof`. */
    else if (ts.isImportTypeNode(node)) {
      const keyword = node.getChildren(sf).find((child) => child.kind === ts.SyntaxKind.ImportKeyword);
      const argument = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      if (keyword !== undefined) record(keyword.getStart(sf), literalOf(argument));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return positions.map(({ line, col }) => byStart.get(`${line}:${col}`));
};

const READERS: Record<ModuleSyntax, Reader> = { "ecmascript-modules": readEcmascript };

/* The literal specifier each recorded load of `file` names, in the order of `positions`; undefined where it names none that can be told. */
export function loadedSpecifiersAt(file: string, source: string, positions: readonly LoadPosition[]): Array<string | undefined> {
  const syntax = LanguageRegistry.moduleSyntaxForFile(file);
  return syntax === null ? positions.map(() => undefined) : READERS[syntax](file, source, positions);
}
