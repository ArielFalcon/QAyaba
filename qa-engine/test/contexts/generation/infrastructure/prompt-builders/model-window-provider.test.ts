import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  BYTES_PER_TOKEN,
  INPUT_PROMPT_SAFETY_MARGIN,
  DEFAULT_WINDOW_TOKENS,
  configuredContextTokens,
  modelWindowBytes,
  roleWindowBytes,
  setRuntimeRoleModels,
} from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog.ts";

function writeConfig(content: unknown): string {
  const dir = join(tmpdir(), `catalog-provider-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "opencode.json");
  writeFileSync(p, JSON.stringify(content), "utf8");
  return p;
}

const corporate = {
  provider: {
    corp: { models: { "coder-large": { limit: { context: 200_000 } }, "no-limit": {} } },
  },
  agent: {
    "qa-generator": { model: "corp/coder-large" },
    "qa-reviewer": { model: "corp/no-limit" },
  },
};

test("configuredContextTokens reads provider.<id>.models.<model>.limit.context", () => {
  const p = writeConfig(corporate);
  assert.equal(configuredContextTokens("corp/coder-large", p), 200_000);
  assert.equal(configuredContextTokens("corp/no-limit", p), undefined);
  assert.equal(configuredContextTokens("other/coder-large", p), undefined);
  assert.equal(configuredContextTokens("bare-model", p), undefined);
  assert.equal(configuredContextTokens("corp/coder-large", join(tmpdir(), "missing-opencode.json")), undefined);
});

test("roleWindowBytes uses the provider-declared window for a custom provider model", () => {
  setRuntimeRoleModels(undefined);
  const p = writeConfig(corporate);
  assert.equal(roleWindowBytes("qa-generator", p), Math.floor(200_000 * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN));
});

test("roleWindowBytes falls back to the default when a custom model declares no window", () => {
  setRuntimeRoleModels(undefined);
  const p = writeConfig(corporate);
  assert.equal(roleWindowBytes("qa-reviewer", p), modelWindowBytes("__unknown__"));
  assert.equal(modelWindowBytes("__unknown__"), Math.floor(DEFAULT_WINDOW_TOKENS * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN));
});

test("a runtime-assigned custom model also resolves its provider-declared window", () => {
  const p = writeConfig(corporate);
  setRuntimeRoleModels({ primary: "corp/coder-large", reviewer: "corp/no-limit", chat: "corp/no-limit" });
  try {
    assert.equal(roleWindowBytes("qa-generator", p), Math.floor(200_000 * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN));
  } finally {
    setRuntimeRoleModels(undefined);
  }
});
