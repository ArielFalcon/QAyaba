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

  /* Control flow and subshells run the commands inside them: the line is what they run. */
  ["for f in e2e/*.mjs; do node $f; done", "script"],
  ["for f in a b\ndo\n  node $f\ndone", "script"],
  ["if [ -f x.mjs ]; then node x.mjs; fi", "script"],
  ["if node check.mjs; then echo ok; else echo no; fi", "script"],
  ["while true; do node poll.mjs; done", "script"],
  ["until node ready.mjs; do true; done", "script"],
  ["(node /tmp/x.mjs)", "script"],
  ["(cd e2e && node x.mjs)", "script"],
  ["{ node x.mjs; }", "script"],
  ["! node x.mjs", "script"],
  ["case $x in a) node x.mjs ;; esac", "script"],
  ["echo $(node x.mjs)", "script"],
  ["if false; then true; elif node x.mjs; then true; fi", "script"],
  ["select f in a b; do node $f; done", "script"],
  ["for f in e2e/*.ts; do npx tsc --noEmit; done", "validate"],
  ["if npx tsc --noEmit; then echo ok; fi", "validate"],
  ["for f in e2e/*.ts; do cat $f; done", "read"],
  ["(cd e2e && ls)", "read"],
  ["if [ -d e2e ]; then ls e2e; fi", "read"],
  ["while read l; do cat $l; done < list.txt", "read"],

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
  ["for f in a b; do rm $f; done", "unknown"],
  ["for f in a b; do echo $f; done", "unknown"],
  ["(rm -rf dist)", "unknown"],
  ["if [ -d e2e ]; then mkdir e2e/x; fi", "unknown"],
  ["for f in $(ls); do cat $f; done", "unknown"],
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
