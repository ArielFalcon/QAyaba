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

test("bucketForTool falls back to other for an analyzing tool matching none of the fine patterns", () => {
  assert.equal(bucketForTool("webfetch"), CALL_BUCKETS.OTHER);
  assert.equal(bucketForTool("some_unknown_tool"), CALL_BUCKETS.OTHER);
});
