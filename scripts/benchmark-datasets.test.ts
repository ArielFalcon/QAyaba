import { test } from "node:test";
import assert from "node:assert/strict";
import { DatasetError } from "@contexts/evaluation/application/index.ts";
import { DATASETS_DIR, listDatasets, loadDataset, parseDatasetRef, type DatasetFiles } from "./benchmark-datasets.ts";

const doc = (over: Record<string, unknown> = {}) => JSON.stringify({ name: "real", version: "1", items: [{ app: "shop", sha: "abcdef1", description: "d" }], ...over });
const files = (content: Record<string, string>): DatasetFiles => ({
  read: (path) => {
    const hit = content[path.slice(path.lastIndexOf("/") + 1)];
    if (hit === undefined) throw new Error("ENOENT");
    return hit;
  },
  list: () => Object.keys(content),
});

test("a dataset is read from <name>@<version>.json and validated", () => {
  const d = loadDataset("real@1", "/d", files({ "real@1.json": doc() }));
  assert.equal(d.items[0]!.mode, "diff");
});

test("a missing file, bad JSON, a bad document and a name that disagrees with the file are each refused with the file named", () => {
  assert.throws(() => loadDataset("real@1", "/d", files({})), /not found/);
  assert.throws(() => loadDataset("real@1", "/d", files({ "real@1.json": "{nope" })), /real@1\.json is not valid JSON/);
  assert.throws(() => loadDataset("real@1", "/d", files({ "real@1.json": doc({ items: [] }) })), /real@1\.json: items/);
  assert.throws(() => loadDataset("real@1", "/d", files({ "real@1.json": doc({ version: "2" }) })), /real@2/);
});

test("a reference needs a name and a version", () => {
  assert.deepEqual(parseDatasetRef("a@b@2"), { name: "a@b", version: "2" });
  for (const bad of ["real", "@1", "real@"]) assert.throws(() => parseDatasetRef(bad), DatasetError);
});

test("the listing names the datasets that follow the convention, in order", () => {
  assert.deepEqual(listDatasets("/d", files({ "b@2.json": "", "a@1.json": "", "README.md": "", "bad.json": "" })), ["a@1", "b@2"]);
});

test("the shipped example dataset is valid", () => {
  assert.ok(listDatasets(DATASETS_DIR).includes("example@1"));
  assert.ok(loadDataset("example@1", DATASETS_DIR).items.length > 0);
});
