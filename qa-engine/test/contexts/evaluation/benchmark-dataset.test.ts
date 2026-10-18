import { test } from "node:test";
import assert from "node:assert/strict";
import { DatasetError, datasetFileName, parseDataset, parseDatasetFileName, runRequestOf } from "@contexts/evaluation/domain/benchmark-dataset.ts";

const item = { app: "shop", sha: "0123456789abcdef0123456789abcdef01234567", description: "the coupon field was added" };
const dataset = (items: unknown[] = [item], over: Record<string, unknown> = {}) => ({ name: "real-failures", version: "1", items, ...over });

test("a valid dataset parses, defaulting an item without guidance to a diff run and one with guidance to a manual run", () => {
  const parsed = parseDataset(dataset([item, { ...item, sha: "abcdef1", guidance: "test the contact form" }]), { name: "real-failures", version: "1" });
  assert.deepEqual(parsed.items.map((i) => i.mode), ["diff", "manual"]);
});

test("the description is metadata: it is in the item but never in what a run is asked", () => {
  const [parsed] = parseDataset(dataset([{ ...item, guidance: "g", mode: "manual" }])).items;
  assert.equal(parsed!.description, item.description);
  assert.deepEqual(runRequestOf(parsed!), { app: "shop", sha: item.sha, mode: "manual", guidance: "g" });
  assert.equal(JSON.stringify(runRequestOf(parsed!)).includes("coupon"), false);
});

test("guidance is only for a manual run", () => {
  assert.throws(() => parseDataset(dataset([{ ...item, guidance: "g", mode: "diff" }])), DatasetError);
});

test("bad items are refused with where they are", () => {
  const bad: Array<[unknown, RegExp]> = [
    [{ ...item, sha: "zz" }, /items\[0\]\.sha/],
    [{ ...item, app: "" }, /items\[0\]\.app/],
    [{ ...item, description: undefined }, /items\[0\]\.description/],
    [{ ...item, mode: "turbo" }, /items\[0\]\.mode/],
    [{ ...item, surprise: 1 }, /unknown field 'surprise'/],
    ["nope", /must be an object/],
  ];
  for (const [entry, message] of bad) assert.throws(() => parseDataset(dataset([entry])), message);
});

test("an empty dataset and a repeated item are refused", () => {
  assert.throws(() => parseDataset(dataset([])), /non-empty/);
  assert.throws(() => parseDataset(dataset([item, { ...item }])), /repeats/);
});

test("the content must agree with the name and version the file name promises", () => {
  assert.throws(() => parseDataset(dataset(), { name: "other", version: "1" }), /other@1/);
  assert.throws(() => parseDataset(dataset([item], { name: "Bad Name" })), /name/);
});

test("file names follow name@version.json", () => {
  assert.equal(datasetFileName("real-failures", "2"), "real-failures@2.json");
  assert.deepEqual(parseDatasetFileName("real-failures@2.json"), { name: "real-failures", version: "2" });
  assert.equal(parseDatasetFileName("real-failures.json"), undefined);
  assert.equal(parseDatasetFileName("Bad@1.json"), undefined);
});
