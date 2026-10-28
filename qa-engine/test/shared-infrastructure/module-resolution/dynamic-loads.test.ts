/* What a dynamic load at a position of a source names: the literal specifier of a dynamic import or require call there, by the
   module syntax its language declares; anything else (a computed specifier, no load at the position, a language with no syntax)
   names nothing that can be told. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadedSpecifiersAt } from "../../../src/shared-infrastructure/module-resolution/dynamic-loads.ts";

const SOURCE = [
  "export const routes = [",
  "  { path: 'a', loadComponent: () => import('@features/a/a.page').then((m) => m.APage) },",
  "  { path: 'b', loadChildren: () => import(`./b.routes`) },",
  "  { path: 'c', loadChildren: () => import(name) },",
  "  { path: 'd', loadChildren: () => import(`./${name}.routes`) },",
  "];",
  "const legacy = require('./legacy');",
  "run();",
].join("\n");

test("a dynamic import or require of a literal specifier names it; a computed one, or a position holding no load, names nothing", () => {
  const at = (line: number, text: string) => ({ line, col: SOURCE.split("\n")[line - 1]!.indexOf(text) });

  const loads = loadedSpecifiersAt("src/app/app.routes.ts", SOURCE, [at(2, "import("), at(3, "import("), at(4, "import("), at(5, "import("), at(7, "require("), at(8, "run(")]);

  assert.deepEqual(loads, ["@features/a/a.page", "./b.routes", undefined, undefined, "./legacy", undefined]);
});

test("a type that names a module by a literal (`typeof import('…')`) names it at its import keyword, where the index records it", () => {
  const source = ["type AppModule = typeof import('@capacitor/app');", "export type Kit = (typeof import(`./kit`))['default'];"].join("\n");
  const at = (line: number) => ({ line, col: source.split("\n")[line - 1]!.indexOf("import(") });

  assert.deepEqual(loadedSpecifiersAt("src/app/a.ts", source, [at(1), at(2), { line: 1, col: 17 }]), ["@capacitor/app", "./kit", undefined]);
});

test("a source of a language with no module syntax, or one that does not parse, names nothing", () => {
  assert.deepEqual(loadedSpecifiersAt("src/Main.java", "class A { Object o = Class.forName(\"x.Y\"); }", [{ line: 1, col: 21 }]), [undefined]);
  assert.deepEqual(loadedSpecifiersAt("src/broken.ts", "import('./a'", [{ line: 1, col: 0 }]), [undefined]);
});
