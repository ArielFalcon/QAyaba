/* A class that implements a port while holding another of the same port (a decorator) forwards by hand, so a method its port gains later is silently dropped. Each such class is pinned with `AssertNever<MissingForwards<Port, Class>>` (engine/src/shared-kernel/forwarding.ts), which fails to compile when it drops one. The case checks the real tree and a synthetic one, so a detector that stopped matching would fail here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

interface Decorator {
  file: string;
  name: string;
  port: string;
}

function typeName(node: ts.TypeNode | undefined): string | undefined {
  return node !== undefined && ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) ? node.typeName.text : undefined;
}

/** The classes of `files` (repo-relative path to source text) that implement a `*Port` and hold a field, or a constructor property, of that same port type. */
function decoratorClasses(files: Record<string, string>): Decorator[] {
  const found: Decorator[] = [];
  for (const [file, text] of Object.entries(files)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        const implemented = (node.heritageClauses ?? [])
          .filter((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)
          .flatMap((clause) => clause.types.map((type) => type.expression.getText(source)))
          .filter((name) => name.endsWith("Port"));
        const held = new Set<string>();
        for (const member of node.members) {
          if (ts.isPropertyDeclaration(member)) held.add(typeName(member.type) ?? "");
          if (ts.isConstructorDeclaration(member)) for (const parameter of member.parameters) if (parameter.modifiers?.length) held.add(typeName(parameter.type) ?? "");
        }
        for (const port of implemented) if (held.has(port)) found.push({ file, name: node.name.text, port });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

function pinned(decorator: Decorator, text: string): boolean {
  return new RegExp(`AssertNever<\\s*MissingForwards<\\s*${decorator.port}\\s*,\\s*${decorator.name}\\s*>`).test(text);
}

function realTree(): Record<string, string> {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "engine/src", "platform"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\0")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));
  return Object.fromEntries(listed.map((f) => [f, readFileSync(join(repoRoot, f), "utf8")]));
}

test("the detector finds a class that implements a port and holds one, and ignores one that only implements it", () => {
  const found = decoratorClasses({
    "a.ts": "class Traced implements WidgetPort { constructor(private readonly inner: WidgetPort) {} }\nclass Plain implements WidgetPort { run() {} }\nclass Other implements WidgetPort { constructor(private readonly dep: GadgetPort) {} }\nclass Field implements WidgetPort { private inner: WidgetPort; }",
  });
  assert.deepEqual(found.map((d) => d.name).sort(), ["Field", "Traced"]);
});

test("every decorator class carries a MissingForwards pin for the port it forwards", () => {
  const files = realTree();
  const decorators = decoratorClasses(files);
  assert.ok(decorators.length >= 10, `the detector found ${decorators.length} decorators, far fewer than the tree holds`);
  const unpinned = decorators.filter((decorator) => !pinned(decorator, files[decorator.file]!)).map((d) => `${d.file}: ${d.name} implements ${d.port} and holds one without a MissingForwards pin`);
  assert.deepEqual(unpinned, []);
});
