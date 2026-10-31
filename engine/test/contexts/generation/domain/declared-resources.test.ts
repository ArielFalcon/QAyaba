import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DECLARED_PER_FILE, declaredRelativeFiles } from "@contexts/generation/domain/declared-resources.ts";

const isCode = (file: string): boolean => /\.(ts|tsx|js|jsx|mjs|cjs|java)$/i.test(file);
const declared = (source: string, from = "src/app/page/list.page.ts"): string[] => declaredRelativeFiles(source, from, isCode);

test("a relative string literal naming a non-code file is declared, resolved against the declaring file", () => {
  const source = `@Component({ templateUrl: './list.page.html', styleUrls: ['./list.page.scss', "../shared/theme.css"] })`;
  assert.deepEqual(declared(source), ["src/app/page/list.page.html", "src/app/page/list.page.scss", "src/app/shared/theme.css"]);
});

test("side-effect imports and require calls of non-code files are declared", () => {
  assert.deepEqual(declared(`import './x.css';\nconst t = require('./x.html');`), ["src/app/page/x.css", "src/app/page/x.html"]);
});

test("a literal naming source code, or no file extension, declares nothing", () => {
  assert.deepEqual(declared(`import { A } from './a.service'; import b from './b.ts'; import c from './c'; import d from './d.js';`), ["src/app/page/a.service"]);
});

test("a literal that is not relative declares nothing", () => {
  assert.deepEqual(declared(`const a = '/etc/x.html'; const b = 'x.html'; const c = 'https://h/x.html'; const d = 'C:\\\\x.html';`), []);
});

test("a path that climbs out of the repository declares nothing", () => {
  assert.deepEqual(declared(`const a = '../../../../x.html'; const b = '../../../etc/x.html';`, "src/app/p.ts"), []);
});

test("query and hash suffixes are dropped, and a template with interpolation is not a literal path", () => {
  assert.deepEqual(declared("const a = './x.html?raw'; const b = `./${name}.html`;"), ["src/app/page/x.html"]);
});

test("a repeated literal is declared once and the list is capped", () => {
  assert.deepEqual(declared(`'./x.html'; './x.html'; "./x.html";`), ["src/app/page/x.html"]);
  const many = Array.from({ length: MAX_DECLARED_PER_FILE + 10 }, (_, i) => `'./f${i}.html'`).join(";");
  assert.equal(declared(many).length, MAX_DECLARED_PER_FILE);
});

test("a file at the repository root resolves its literals from the root", () => {
  assert.deepEqual(declaredRelativeFiles(`'./x.html'`, "page.ts", isCode), ["x.html"]);
});
