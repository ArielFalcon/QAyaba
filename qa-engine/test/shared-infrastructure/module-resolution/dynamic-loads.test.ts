/* What a source loads at run time, read whole by the module syntax its language declares: only a load of a literal specifier names
   it; every other load the language can express makes the source opaque; a type that names a module is a use, not a load; a
   language with no syntax, or a source that does not parse, says nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { moduleLoadsOf } from "../../../src/shared-infrastructure/module-resolution/dynamic-loads.ts";

test("a dynamic import, a require, a resolve or a module URL of a literal specifier names it, and nothing else is opaque", () => {
  const source = [
    "export const routes = [",
    "  { path: 'a', loadComponent: () => import('@features/a/a.page').then((m) => m.APage) },",
    "  { path: 'b', loadChildren: () => import(`./b.routes`) },",
    "];",
    "const common = require('./common');",
    "const where = require.resolve('./where');",
    "const meta = import.meta.resolve('./meta');",
    "const worker = new Worker(new URL('./worker', import.meta.url));",
    "const mode = import.meta.env.MODE;",
  ].join("\n");

  assert.deepEqual(moduleLoadsOf("src/app/app.routes.ts", source), { loads: ["@features/a/a.page", "./b.routes", "./common", "./where", "./meta", "./worker"], types: [], opaque: false });
});

test("every load the language can express without a literal specifier makes the source opaque", () => {
  const opaque = [
    "export const load = (name: string) => import(name);",
    "export const load = (name: string) => import(`./pages/${name}.page`);",
    "export const load = (name: string) => require(name);",
    "export const load = (name: string) => require(`./${name}`).default;",
    "export const pages = require.context('./pages', true, /\\.ts$/);",
    "export const pages = import.meta.glob('./pages/*.ts');",
    "export const pages = import.meta.glob(['./a/*.ts'], { eager: true });",
    "export const worker = (name: string) => new URL(name, import.meta.url);",
  ];

  for (const source of opaque) assert.equal(moduleLoadsOf("src/app/loader.ts", source)?.opaque, true, source);
});

test("a load written through a cast, a non-null assertion or parentheses is read as the same load", () => {
  const opaque = [
    "export const pages = (require as any).context('./pages', true, /\\.ts$/);",
    "export const load = (name: string) => (require as any)(name);",
    "export const pages = (<any>require).context('./pages');",
    "export const pages = require!.context('./pages');",
    "export const pages = (import.meta as any).glob('./pages/*.ts');",
    "export const load = (name: string) => (import.meta as any).resolve(name);",
  ];

  for (const source of opaque) assert.equal(moduleLoadsOf("src/app/loader.ts", source)?.opaque, true, source);
  assert.deepEqual(moduleLoadsOf("src/app/loader.ts", "export const common = (require as any)('./common');\nexport const where = (require as any).resolve('./where');"), { loads: ["./common", "./where"], types: [], opaque: false });
});

test("a type that names a module by a literal (`typeof import('…')`) is a use of it and loads nothing", () => {
  const source = ["type AppModule = typeof import('@capacitor/app');", "export type Kit = (typeof import(`./kit`))['default'];"].join("\n");

  assert.deepEqual(moduleLoadsOf("src/app/a.ts", source), { loads: [], types: ["@capacitor/app", "./kit"], opaque: false });
});

test("a source of a language with no module syntax, or one that does not parse, says nothing", () => {
  assert.equal(moduleLoadsOf("src/Main.java", "class A { Object o = Class.forName(\"x.Y\"); }"), undefined);
  assert.equal(moduleLoadsOf("src/broken.ts", "import('./a'"), undefined);
});
