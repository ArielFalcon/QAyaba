import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TreeRemovalLimitError, removeTreeBounded } from "../../src/shared-infrastructure/bounded-tree-removal.ts";

function scratch(): { root: string; done(): void } {
  const root = mkdtempSync(join(tmpdir(), "tree-removal-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a tree of files and folders is removed, and a path that is not there is not an error", () => {
  const s = scratch();
  try {
    const tree = join(s.root, "probe");
    mkdirSync(join(tree, "a", "b"), { recursive: true });
    writeFileSync(join(tree, "x.spec.ts"), "x");
    writeFileSync(join(tree, "a", "b", "y.spec.ts"), "y");
    removeTreeBounded(tree);
    assert.equal(existsSync(tree), false);
    assert.doesNotThrow(() => removeTreeBounded(tree));
  } finally {
    s.done();
  }
});

test("a link inside the tree is removed as a link: what it points at is never touched, a directory or a file", () => {
  const s = scratch();
  try {
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    const tree = join(s.root, "probe");
    mkdirSync(tree);
    symlinkSync(outside, join(tree, "to-dir"));
    symlinkSync(join(outside, "keep.txt"), join(tree, "to-file"));
    removeTreeBounded(tree);
    assert.equal(existsSync(tree), false);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
  } finally {
    s.done();
  }
});

test("a path that is itself a link is unlinked and its target is left alone", () => {
  const s = scratch();
  try {
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    const link = join(s.root, "probe");
    symlinkSync(outside, link);
    removeTreeBounded(link);
    assert.equal(existsSync(link), false);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
  } finally {
    s.done();
  }
});

test("a tree deeper than the bound is refused rather than walked", () => {
  const s = scratch();
  try {
    let dir = join(s.root, "probe");
    for (let i = 0; i < 8; i++) dir = join(dir, "d");
    mkdirSync(dir, { recursive: true });
    assert.throws(() => removeTreeBounded(join(s.root, "probe"), { maxEntries: 1000, maxDepth: 4, budgetMs: 5000 }), TreeRemovalLimitError);
  } finally {
    s.done();
  }
});

test("a tree with more entries than the bound is refused", () => {
  const s = scratch();
  try {
    const tree = join(s.root, "probe");
    mkdirSync(tree);
    for (let i = 0; i < 50; i++) writeFileSync(join(tree, `f${i}`), "x");
    assert.throws(() => removeTreeBounded(tree, { maxEntries: 20, maxDepth: 8, budgetMs: 5000 }), TreeRemovalLimitError);
  } finally {
    s.done();
  }
});

test("a removal that runs out of time is refused", () => {
  const s = scratch();
  try {
    const tree = join(s.root, "probe");
    mkdirSync(tree);
    for (let i = 0; i < 5; i++) writeFileSync(join(tree, `f${i}`), "x");
    let clock = 0;
    assert.throws(() => removeTreeBounded(tree, { maxEntries: 1000, maxDepth: 8, budgetMs: 10 }, { now: () => (clock += 20) }), TreeRemovalLimitError);
  } finally {
    s.done();
  }
});
