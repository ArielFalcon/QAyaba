import { test } from "node:test";
import assert from "node:assert/strict";
import { importsTestFromFixtures } from "../../src/shared-infrastructure/spec-fixtures-import.ts";

test("a spec that takes test from the suite's fixtures is recognized, however the import is spelled", () => {
  for (const source of [
    'import { test, expect } from "../fixtures";\n',
    "import { expect, test } from './fixtures';\n",
    'import { test } from "../../fixtures.js";\n',
    'import { test as base } from "../fixtures.ts";\n',
    'import {\n  test,\n  expect,\n} from "../fixtures";\ntest("x", async () => {});\n',
  ]) {
    assert.equal(importsTestFromFixtures(source), true, source);
  }
});

test("text that only looks like the import is not the import: a comment, a string, a template, a type-only import", () => {
  for (const source of [
    '// import { test } from "../fixtures";\nimport { test } from "@playwright/test";\n',
    '/* import { test } from "./fixtures"; */\nimport { test } from "@playwright/test";\n',
    'import { test } from "@playwright/test";\nconst s = \'import { test } from "./fixtures"\';\n',
    'import { test } from "@playwright/test";\nconst s = `\nimport { test } from "./fixtures"\n`;\n',
    'import type { test } from "../fixtures";\nimport { test as t } from "@playwright/test";\n',
    'import { type test } from "../fixtures";\n',
    'import { test } from "@playwright/test";\nawait import("../fixtures");\n',
    'import * as fixtures from "../fixtures";\n',
    'import { expect } from "../fixtures";\n',
    'import { test } from "../other-fixtures";\n',
    'import { test } from "fixtures";\n',
    "",
  ]) {
    assert.equal(importsTestFromFixtures(source), false, source);
  }
});

test("source that does not parse as a module is not a spec that imports the fixtures", () => {
  assert.equal(importsTestFromFixtures('import { test } from "../fixtures'), false);
});
