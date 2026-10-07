import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSpecPath } from "@kernel/spec-path.ts";

test("a spec path keeps its folders and file name", () => {
  assert.equal(normalizeSpecPath("flows/login.spec.ts"), "flows/login.spec.ts");
  assert.equal(normalizeSpecPath("login.spec.ts"), "login.spec.ts");
});

test("a backslash separator reads as a forward slash, wherever it stands", () => {
  assert.equal(normalizeSpecPath("flows\\owners\\add.spec.ts"), "flows/owners/add.spec.ts");
});

test("a ./ segment goes, however many are stacked and wherever they stand", () => {
  assert.equal(normalizeSpecPath("./flows/login.spec.ts"), "flows/login.spec.ts");
  assert.equal(normalizeSpecPath("././login.spec.ts"), "login.spec.ts");
  assert.equal(normalizeSpecPath("flows/./login.spec.ts"), "flows/login.spec.ts");
  assert.equal(normalizeSpecPath("flows/./owners/./add.spec.ts"), "flows/owners/add.spec.ts");
});

test("a repeated separator is one", () => {
  assert.equal(normalizeSpecPath("flows//login.spec.ts"), "flows/login.spec.ts");
  assert.equal(normalizeSpecPath("flows///owners//add.spec.ts"), "flows/owners/add.spec.ts");
  assert.equal(normalizeSpecPath("flows\\\\login.spec.ts"), "flows/login.spec.ts");
});

test("a .\\ segment and a mixed run of separators and dots go as well: the separator is normalized first", () => {
  assert.equal(normalizeSpecPath(".\\flows\\login.spec.ts"), "flows/login.spec.ts");
  assert.equal(normalizeSpecPath("flows/.\\/login.spec.ts"), "flows/login.spec.ts");
});

test("however a file is spelled, its spellings are one path", () => {
  const spellings = ["flows/a.spec.ts", "./flows/a.spec.ts", "flows/./a.spec.ts", "flows//a.spec.ts", "flows\\a.spec.ts", ".\\flows\\.\\a.spec.ts", "./flows//./a.spec.ts"];
  assert.equal(new Set(spellings.map(normalizeSpecPath)).size, 1);
});

test("a parent segment stays where it stands, so the confined reader still refuses it", () => {
  assert.equal(normalizeSpecPath("../login.spec.ts"), "../login.spec.ts");
  assert.equal(normalizeSpecPath("flows/../login.spec.ts"), "flows/../login.spec.ts");
  assert.equal(normalizeSpecPath("flows/../../secret.txt"), "flows/../../secret.txt");
  assert.equal(normalizeSpecPath("./flows/.././x.spec.ts"), "flows/../x.spec.ts");
  assert.equal(normalizeSpecPath("..\\login.spec.ts"), "../login.spec.ts");
});

test("a name that only starts with a dot is a name: a hidden folder and a long run of dots stay", () => {
  assert.equal(normalizeSpecPath(".hidden/login.spec.ts"), ".hidden/login.spec.ts");
  assert.equal(normalizeSpecPath("flows/...spec.ts"), "flows/...spec.ts");
  assert.equal(normalizeSpecPath("flows/.a.spec.ts"), "flows/.a.spec.ts");
});

test("an absolute path stays absolute, so the confined reader still refuses it", () => {
  assert.equal(normalizeSpecPath("/etc/hostname"), "/etc/hostname");
  assert.equal(normalizeSpecPath("//etc//hostname"), "/etc/hostname");
  assert.equal(normalizeSpecPath("\\etc\\hostname"), "/etc/hostname");
  assert.notEqual(normalizeSpecPath("/etc/hostname"), normalizeSpecPath("etc/hostname"));
});

test("a path that names no file in the spec directory is empty, except the root, which stays visible", () => {
  assert.equal(normalizeSpecPath(""), "");
  assert.equal(normalizeSpecPath("./"), "");
  assert.equal(normalizeSpecPath("."), "");
  assert.equal(normalizeSpecPath("./."), "");
  assert.equal(normalizeSpecPath("/"), "/");
});

test("a trailing separator is dropped: a path names the entry, not a directory", () => {
  assert.equal(normalizeSpecPath("flows/login.spec.ts/"), "flows/login.spec.ts");
  assert.equal(normalizeSpecPath("flows/"), "flows");
});

test("normalizing a normalized path changes nothing", () => {
  for (const reported of ["./a/b.spec.ts", "a\\b.spec.ts", ".\\.\\b.spec.ts", "b.spec.ts", "a//./b.spec.ts", "../a/b.spec.ts", "//a/b", "/", ""]) {
    const once = normalizeSpecPath(reported);
    assert.equal(normalizeSpecPath(once), once);
  }
});
