/*
 * The lines of a source that hold no executable code, by the statement syntax its language declares
 * (`LanguageRegistry.statementSyntaxForFile`): an import, a re-export or an export list, a type-only declaration (an interface, a
 * type alias, a `declare` statement), a comment and a blank line run nothing. Every line a top-level statement of any other kind
 * spans is code, so a line it shares with a re-export stays code. A language that declares no syntax, or a source its syntax cannot
 * parse, tells nothing (undefined): the caller then keeps what it counted before. Pure: no file is read here.
 */
import ts from "typescript";
import { LanguageRegistry, type StatementSyntax } from "@kernel/language-id.ts";

type Reader = (file: string, source: string) => ReadonlySet<number> | undefined;

function scriptKindOf(file: string): ts.ScriptKind {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "tsx") return ts.ScriptKind.TSX;
  if (ext === "jsx") return ts.ScriptKind.JSX;
  if (ext === "ts" || ext === "mts" || ext === "cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/* A top-level statement that emits no code: it only names modules, types or what another module declares. */
function runsNothing(statement: ts.Statement): boolean {
  if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) return true;
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
  if (ts.isImportEqualsDeclaration(statement)) return statement.isTypeOnly;
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
}

const readEcmascript: Reader = (file, source) => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, scriptKindOf(file));
  /* The parser's own syntax errors; the compiler API keeps them on the source file without declaring them. */
  if (((sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []).length > 0) return undefined;
  const lineOf = (offset: number): number => sf.getLineAndCharacterOfPosition(offset).line + 1;
  const code = new Set<number>();
  for (const statement of sf.statements) {
    if (runsNothing(statement)) continue;
    for (let line = lineOf(statement.getStart(sf)); line <= lineOf(statement.getEnd()); line++) code.add(line);
  }
  const none = new Set<number>();
  for (let line = 1; line <= sf.getLineStarts().length; line++) if (!code.has(line)) none.add(line);
  return none;
};

const READERS: Record<StatementSyntax, Reader> = { ecmascript: readEcmascript };

export function linesWithoutCode(file: string, source: string): ReadonlySet<number> | undefined {
  const syntax = LanguageRegistry.statementSyntaxForFile(file);
  return syntax === null ? undefined : READERS[syntax](file, source);
}
