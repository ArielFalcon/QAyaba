import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALL_BUCKETS,
  bucketForTool,
  kindForTool,
} from "@contexts/generation/domain/tool-call-taxonomy.ts";

test("kindForTool classifies write, shell and subagent tools by their coarse kind", () => {
  assert.equal(kindForTool("write"), "writing");
  assert.equal(kindForTool("edit"), "writing");
  assert.equal(kindForTool("bash"), "command");
  assert.equal(kindForTool("task"), "subagent");
});

test("kindForTool defaults every other raw tool name to analyzing", () => {
  assert.equal(kindForTool("read"), "analyzing");
  assert.equal(kindForTool("browser_navigate"), "analyzing");
  assert.equal(kindForTool("mem_search"), "analyzing");
});

test("bucketForTool maps writing/command/subagent one-to-one (reconciles with kindForTool)", () => {
  assert.equal(bucketForTool("write"), CALL_BUCKETS.WRITE);
  assert.equal(bucketForTool("bash"), CALL_BUCKETS.VALIDATE_RUN);
  assert.equal(bucketForTool("task"), CALL_BUCKETS.SUBAGENT);
});

test("bucketForTool refines analyzing into browser for playwright MCP tools", () => {
  assert.equal(bucketForTool("browser_navigate"), CALL_BUCKETS.BROWSER);
  assert.equal(bucketForTool("browser_snapshot"), CALL_BUCKETS.BROWSER);
  assert.equal(bucketForTool("browser_click"), CALL_BUCKETS.BROWSER);
});

test("bucketForTool refines analyzing into memory for engram and serena memory tools", () => {
  assert.equal(bucketForTool("mem_search"), CALL_BUCKETS.MEMORY);
  assert.equal(bucketForTool("mem_save"), CALL_BUCKETS.MEMORY);
  assert.equal(bucketForTool("read_memory"), CALL_BUCKETS.MEMORY);
  assert.equal(bucketForTool("list_memories"), CALL_BUCKETS.MEMORY);
});

test("bucketForTool refines analyzing into code_read for the native read tool and serena code navigation", () => {
  assert.equal(bucketForTool("read"), CALL_BUCKETS.CODE_READ);
  assert.equal(bucketForTool("find_symbol"), CALL_BUCKETS.CODE_READ);
  assert.equal(bucketForTool("search_for_pattern"), CALL_BUCKETS.CODE_READ);
  assert.equal(bucketForTool("read_file"), CALL_BUCKETS.CODE_READ);
});

test("bucketForTool recognizes MCP tools whose names carry the server prefix", () => {
  assert.equal(bucketForTool("playwright_browser_navigate"), CALL_BUCKETS.BROWSER);
  assert.equal(bucketForTool("mcp__playwright__browser_snapshot"), CALL_BUCKETS.BROWSER);
  assert.equal(bucketForTool("engram_mem_search"), CALL_BUCKETS.MEMORY);
  assert.equal(bucketForTool("serena_read_memory"), CALL_BUCKETS.MEMORY);
  assert.equal(bucketForTool("serena_find_symbol"), CALL_BUCKETS.CODE_READ);
  assert.equal(bucketForTool("serena_read_file"), CALL_BUCKETS.CODE_READ);
});

test("bucketForTool does not treat an unrelated tool that merely ends in a read-like word as code_read", () => {
  assert.equal(bucketForTool("spread"), CALL_BUCKETS.OTHER);
  assert.equal(bucketForTool("thread"), CALL_BUCKETS.OTHER);
});

test("bucketForTool falls back to other for an analyzing tool matching none of the fine patterns", () => {
  assert.equal(bucketForTool("webfetch"), CALL_BUCKETS.OTHER);
  assert.equal(bucketForTool("some_unknown_tool"), CALL_BUCKETS.OTHER);
});

/* Serena's editing tools are named by what they do to the working tree, whatever the server prefix. */
const SERENA_EDIT_TOOLS = [
  "create_text_file",
  "replace_symbol_body",
  "insert_after_symbol",
  "insert_before_symbol",
  "replace_content",
  "replace_regex",
  "replace_lines",
  "delete_lines",
  "insert_at_line",
  "rename_symbol",
];

test("serena's editing tools are writes, bare or with a server prefix", () => {
  for (const tool of SERENA_EDIT_TOOLS) {
    for (const name of [tool, `serena_${tool}`, `mcp__serena__${tool}`]) {
      assert.equal(kindForTool(name), "writing", name);
      assert.equal(bucketForTool(name), CALL_BUCKETS.WRITE, name);
    }
  }
});

test("serena's shell tool is a command, bare or with a server prefix", () => {
  for (const name of ["execute_shell_command", "serena_execute_shell_command"]) {
    assert.equal(kindForTool(name), "command", name);
    assert.equal(bucketForTool(name), CALL_BUCKETS.VALIDATE_RUN, name);
  }
});

test("serena's navigation tools stay reads and its memory tools stay memory", () => {
  assert.equal(bucketForTool("serena_get_symbols_overview"), CALL_BUCKETS.CODE_READ);
  assert.equal(bucketForTool("serena_list_dir"), CALL_BUCKETS.CODE_READ);
  assert.equal(bucketForTool("serena_write_memory"), CALL_BUCKETS.MEMORY);
});

test("a tool that merely contains an editing tool's name inside a longer word is not a write", () => {
  assert.equal(bucketForTool("preplace_content"), CALL_BUCKETS.OTHER);
  assert.equal(bucketForTool("replace_content_preview"), CALL_BUCKETS.OTHER);
});
