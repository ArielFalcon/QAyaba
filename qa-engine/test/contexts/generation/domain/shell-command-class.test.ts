import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyShellCommand, type ShellCommandClass } from "@contexts/generation/domain/shell-command-class.ts";

const cases: ReadonlyArray<readonly [string, ShellCommandClass]> = [
  /* Orientation: reading the tree or its history, however the command is piped or chained. */
  ["ls -la src", "read"],
  ["cat src/app.ts", "read"],
  ["head -n 40 package.json", "read"],
  ["tail -f /var/log/x.log", "read"],
  ["grep -rn 'login' src", "read"],
  ["rg --files e2e | wc -l", "read"],
  ["find . -name '*.spec.ts' -not -path './node_modules/*'", "read"],
  ["fd spec e2e", "read"],
  ["tree -L 2", "read"],
  ["sed -n '1,40p' src/app.ts", "read"],
  ["cd e2e && ls", "read"],
  ["cat a.ts | grep -E 'a|b' | sort | uniq", "read"],
  ["git status --short", "read"],
  ["git log --oneline -5", "read"],
  ["git diff HEAD~1 -- src", "read"],
  ["ls missing 2>/dev/null", "read"],
  ["grep -rn x src 2>&1 | head", "read"],
  ["cat -- $HOME/.profile", "read"],
  ["env FOO=1 grep x file", "read"],
  ["find . -name '*.ts' | xargs grep -l login", "read"],
  ["FOO=bar ls", "read"],
  ["\n  ls\n", "read"],

  /* Validation: type check, lint, listing or running the suite, a build or the repo's test script. */
  ["npx playwright test --list", "validate"],
  ["npx playwright test e2e/flows/login.spec.ts", "validate"],
  ["playwright test --list", "validate"],
  ["npx tsc --noEmit -p e2e", "validate"],
  ["tsc --noEmit", "validate"],
  ["npx eslint e2e", "validate"],
  ["npm run typecheck", "validate"],
  ["npm run lint -- --fix", "validate"],
  ["npm test", "validate"],
  ["pnpm test", "validate"],
  ["yarn lint", "validate"],
  ["cd e2e && npx tsc --noEmit", "validate"],
  ["npx prettier --check src", "validate"],
  ["npx vitest run", "validate"],
  ["mvn -q test", "validate"],
  ["./mvnw verify", "validate"],
  ["./gradlew test", "validate"],
  ["pytest tests", "validate"],
  ["go test ./...", "validate"],

  /* Running something the agent wrote or an arbitrary program. */
  ["node /tmp/probe.mjs", "script"],
  ["node scripts/check.js --flag", "script"],
  ["npx tsx /tmp/x.ts", "script"],
  ["tsx x.ts", "script"],
  ["python3 /tmp/probe.py", "script"],
  ["node -e \"console.log(1)\"", "script"],
  ["node - <<'EOF'\nconsole.log(1)\nEOF", "script"],
  ["./run.sh", "script"],
  ["/tmp/probe", "script"],
  ["bash /tmp/probe.sh", "script"],
  ["sh -c 'curl localhost'", "script"],
  ["ls && node /tmp/x.mjs", "script"],
  ["cat a.ts | node /tmp/filter.mjs", "script"],
  ["npx ts-node x.ts", "script"],
  ["cd /tmp && node probe.mjs", "script"],

  /* Anything that changes the tree, or that the table does not know, is not classified. */
  ["rm -rf dist", "unknown"],
  ["mkdir -p e2e/flows", "unknown"],
  ["echo hi > e2e/a.txt", "unknown"],
  ["cat a.ts > b.ts", "unknown"],
  ["sed -i 's/a/b/' src/a.ts", "unknown"],
  ["find . -name '*.log' -delete", "unknown"],
  ["find . -name '*.ts' -exec rm {} \\;", "unknown"],
  ["git commit -am x", "unknown"],
  ["git checkout main", "unknown"],
  ["curl -s http://localhost:3000", "unknown"],
  ["grep x f && rm -rf y", "unknown"],
  ["cat $(ls)", "unknown"],
  ["cat `ls`", "unknown"],
  ["npm run build:prod", "unknown"],
  ["", "unknown"],
  ["   ", "unknown"],
  ["cd e2e", "unknown"],
  ["some-tool --flag", "unknown"],
];

for (const [command, expected] of cases) {
  test(`a shell command is classified by what it runs: ${JSON.stringify(command)} is ${expected}`, () => {
    assert.equal(classifyShellCommand(command), expected);
  });
}

test("an operator inside quotes does not split the command", () => {
  assert.equal(classifyShellCommand("grep \"a && node x.js\" file"), "read");
  assert.equal(classifyShellCommand("grep 'a; rm -rf /' file"), "read");
});

test("a pipe into a script is a script run even when the producer only reads", () => {
  assert.equal(classifyShellCommand("cat data.json | python3 /tmp/fmt.py"), "script");
});

test("a script run outranks a validation in the same command line", () => {
  assert.equal(classifyShellCommand("npx tsc --noEmit && node /tmp/x.mjs"), "script");
});
