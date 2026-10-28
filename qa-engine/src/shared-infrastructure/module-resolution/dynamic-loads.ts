/*
 * What a source loads at run time, read from the whole source by the module syntax the language registry declares for the file
 * (the code graph records only some forms of a dynamic load, and `import.meta.glob` not at all). For `ecmascript-modules`:
 *   - a dynamic `import(…)`, a `require(…)`, a `require.resolve(…)` or `import.meta.resolve(…)`, or a `new URL(…, import.meta.url)`
 *     whose specifier is a literal (a string, or a template with no substitution) loads that specifier;
 *   - any other of them (a computed specifier), and any other call on `require` or `import.meta` (`require.context`,
 *     `import.meta.glob`), loads modules the source does not state (`opaque`);
 *   - a type that names a module (`typeof import('…')`) uses it and loads nothing.
 * A language with no module syntax, or a source that does not parse, says nothing (undefined): whoever reads the answer keeps such a
 * file as one that may load any file. Pure: no file is read here.
 */
import ts from "typescript";
import { LanguageRegistry, type ModuleSyntax } from "@kernel/language-id.ts";

export interface ModuleLoads {
  /* The literal specifiers the source loads at run time, once each, in source order. */
  loads: string[];
  /* The literal specifiers a type of the source names, once each, in source order: a use, never a load. */
  types: string[];
  /* The source loads modules it does not name by a literal. */
  opaque: boolean;
}

type Reader = (file: string, source: string) => ModuleLoads | undefined;

function scriptKindOf(file: string): ts.ScriptKind {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "tsx") return ts.ScriptKind.TSX;
  if (ext === "jsx") return ts.ScriptKind.JSX;
  if (ext === "ts" || ext === "mts" || ext === "cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

const literalOf = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

const isImportMeta = (node: ts.Node): boolean => ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta";

/* The root of a property access chain (`require` of `require.context`, `import.meta` of `import.meta.glob`). */
function rootOf(node: ts.Expression): ts.Expression {
  let at = node;
  while (ts.isPropertyAccessExpression(at)) at = at.expression;
  return at;
}

const isRequire = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === "require";

const readEcmascript: Reader = (file, source) => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  /* The parser's own syntax errors; the compiler API keeps them on the source file without declaring them. */
  if (((sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []).length > 0) return undefined;
  const loads = new Set<string>();
  const types = new Set<string>();
  let opaque = false;
  const load = (specifier: string | undefined): void => {
    if (specifier === undefined) opaque = true;
    else loads.add(specifier);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || isRequire(callee)) load(literalOf(node.arguments[0]));
      else if (ts.isPropertyAccessExpression(callee)) {
        const root = rootOf(callee);
        if (isRequire(root) || isImportMeta(root)) load(callee.name.text === "resolve" && callee.expression === root ? literalOf(node.arguments[0]) : undefined);
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
      const base = node.arguments?.[1];
      if (base !== undefined && ts.isPropertyAccessExpression(base) && isImportMeta(base.expression) && base.name.text === "url") load(literalOf(node.arguments![0]));
    } else if (ts.isImportTypeNode(node)) {
      const specifier = ts.isLiteralTypeNode(node.argument) ? literalOf(node.argument.literal) : undefined;
      if (specifier !== undefined) types.add(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { loads: [...loads], types: [...types], opaque };
};

const READERS: Record<ModuleSyntax, Reader> = { "ecmascript-modules": readEcmascript };

/* What `source` (the text of `file`) loads, or undefined when its language declares no module syntax or it does not parse. */
export function moduleLoadsOf(file: string, source: string): ModuleLoads | undefined {
  const syntax = LanguageRegistry.moduleSyntaxForFile(file);
  return syntax === null ? undefined : READERS[syntax](file, source);
}
