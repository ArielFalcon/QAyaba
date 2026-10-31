/* Whether a spec takes its `test` from the suite's fixtures file, judged on the parsed module and not on its text. The fixtures carry the write counter (the ledger run_spec charges DEV writes from) and the failure capture; a spec that does not import them counts nothing. The old test was a regular expression over the source, which a comment or a string literal satisfies, so the check is on the import declarations of the syntax tree: a relative module specifier that ends in `fixtures` (with an optional .js or .ts), a value import (not `import type`, not `{ type test }`), naming `test`. A dynamic import, a namespace import and a re-export are not it. This is a guard against a mistake and against the cheapest cheat; it is not the bound on DEV writes, which does not depend on what a spec says about itself (see docs/execution-sandbox.md). */

import ts from "typescript";

const FIXTURES_SPECIFIER = /^(?:\.{1,2}\/)+fixtures(?:\.js|\.ts)?$/;

export function importsTestFromFixtures(source: string): boolean {
  let file: ts.SourceFile;
  try {
    file = ts.createSourceFile("spec.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  } catch {
    return false;
  }
  /* A module with a syntax error is not a module whose imports can be told: refuse it, the run would not load it either. */
  const diagnostics = (file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) return false;
  return file.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
    if (!FIXTURES_SPECIFIER.test(statement.moduleSpecifier.text)) return false;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) return false;
    const bindings = clause.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
    return bindings.elements.some((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === "test");
  });
}

/* The check as an object, for a use case that receives it as a dependency. */
export const typescriptSpecFixtures: { importsTestFromFixtures(source: string): boolean } = { importsTestFromFixtures };
