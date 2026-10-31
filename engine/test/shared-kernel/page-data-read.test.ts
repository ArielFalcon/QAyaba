import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyConfirmedPages, type PageDataRead } from "@kernel/page-data-read.ts";

const read = (scope: string, fields: Partial<PageDataRead> = {}): PageDataRead => ({ scope, grounded: true, dataState: true, unconfirmed: false, ...fields });

test("a grounded page read as a confirmed empty state is an empty page", () => {
  assert.deepEqual(emptyConfirmedPages([read("/listing", { resultCount: 0, emptyConfirmed: true }), read("/home")]), ["/listing"]);
});

test("a page some read of the run read with results is not an empty page", () => {
  assert.deepEqual(emptyConfirmedPages([read("/listing", { resultCount: 0, emptyConfirmed: true }), read("/listing", { resultCount: 4 })]), []);
});

test("a read that was not grounded, or not confirmed, names no empty page", () => {
  assert.deepEqual(emptyConfirmedPages([read("/listing", { grounded: false, resultCount: 0, emptyConfirmed: true }), read("/other", { resultCount: 0, unconfirmed: true })]), []);
});

test("a read of a route template names no single page", () => {
  assert.deepEqual(emptyConfirmedPages([read("/shops/:city", { resultCount: 0, emptyConfirmed: true })]), []);
});
