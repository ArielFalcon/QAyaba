/* The staging of a service's context over REAL service repositories: a git repository under os.tmpdir() whose commit is read by the real hardened git, the real strict calls, and the sweep of every kind of file a service tree can hold (ordinary, binary, over the size cap, a link out of the mirror, a file deleted after the commit, contracts the default sweep names). Each case reads the whole staged tree and the manifest, so what the agent is given for a service stays the same however the staging is wired. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageServiceContext, serviceContextDir, defaultStageDeps, type ServiceContextManifest, type StageDeps } from "./service-context";

const CLOCK = 1_700_000_000_000;
const STAMP = new Date(CLOCK).toISOString();

interface Service {
  tmp: string;
  front: string;
  svc: string;
  outside: string;
  sha: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=qa@example.test", "-c", "user.name=qa", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function put(root: string, rel: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/* A repository with one commit holding `files` (a value starting with "->" is a link to what follows, `<outside>` standing for a directory beside the mirror), and `after` done to its working tree once the commit exists. */
async function withService(files: Record<string, string | Buffer>, run: (s: Service) => Promise<void>, after?: (s: Service) => void): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-stage-sweep-"));
  const s: Service = { tmp, front: join(tmp, "front"), svc: join(tmp, "svc"), outside: join(tmp, "outside"), sha: "" };
  try {
    mkdirSync(join(s.front, "e2e"), { recursive: true });
    mkdirSync(s.svc);
    mkdirSync(s.outside);
    writeFileSync(join(s.outside, "secret.txt"), "OUTSIDE-THE-MIRROR\n");
    git(s.svc, ["init", "-q"]);
    for (const [name, content] of Object.entries(files)) {
      if (typeof content === "string" && content.startsWith("->")) {
        mkdirSync(dirname(join(s.svc, name)), { recursive: true });
        symlinkSync(content.slice(2).replace("<outside>", s.outside), join(s.svc, name));
      } else {
        put(s.svc, name, content);
      }
    }
    git(s.svc, ["add", "-A"]);
    git(s.svc, ["commit", "-q", "-m", "the commit under test"]);
    s.sha = git(s.svc, ["rev-parse", "HEAD"]);
    after?.(s);
    await run(s);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const deps: StageDeps = { ...defaultStageDeps, now: () => CLOCK };
const stage = (s: Service, extra: { sha?: string; openapi?: string | string[] } = {}) =>
  stageServiceContext({ workingCopyDir: s.front, service: { repo: "org/svc", mirrorDir: s.svc, ...(extra.openapi ? { openapi: extra.openapi } : {}) }, ...(extra.sha ? { sha: extra.sha } : {}) }, deps);
const manifestOf = (path: string): ServiceContextManifest => JSON.parse(readFileSync(path, "utf8")) as ServiceContextManifest;

/* Every file below a directory, as a path below it. */
function filesBelow(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1)).sort();
}

const TREE: Record<string, string | Buffer> = {
  "openapi/openapi.yaml": "openapi: 3.0.3\n",
  "docs/API-Definition.json": "{}\n",
  "src/a.txt": "an ordinary file\n",
  "src/blob.bin": Buffer.from([1, 2, 0, 3]),
  "src/big.txt": "x".repeat(512 * 1024 + 1),
  "src/gone.txt": "committed, then deleted from the working tree\n",
  "src/link.txt": "-><outside>/secret.txt",
};
const withoutGone = (s: Service): void => rmSync(join(s.svc, "src", "gone.txt"));

test("a service with a commit is staged as its contracts, the diff, the files the commit changed and a manifest that says what was left out and why, the patch over the cap included", async () => {
  await withService(TREE, async (s) => {
    const staged = await stage(s, { sha: s.sha });
    const dir = serviceContextDir(s.front, "org/svc");

    assert.equal(staged.dir, dir);
    assert.equal(staged.manifestPath, join(dir, "manifest.json"));
    assert.deepEqual(filesBelow(dir), [
      "changed/docs/API-Definition.json",
      "changed/openapi/openapi.yaml",
      "changed/src/a.txt",
      "contracts/docs/API-Definition.json",
      "contracts/openapi/openapi.yaml",
      "manifest.json",
    ]);
    const manifest = manifestOf(staged.manifestPath);
    assert.deepEqual(manifest, {
      repo: "org/svc",
      sha: s.sha,
      stagedAt: STAMP,
      contracts: ["docs/API-Definition.json", "openapi/openapi.yaml"],
      changed: ["docs/API-Definition.json", "openapi/openapi.yaml", "src/a.txt"],
      omitted: [
        { path: "CHANGE.patch", reason: "file too large (> 512KB)" },
        { path: "src/big.txt", reason: "refused: the file is larger than 524288 bytes" },
        { path: "src/blob.bin", reason: "binary file (skipped)" },
        { path: "src/gone.txt", reason: "not found in the service mirror (deleted/renamed)" },
        { path: "src/link.txt", reason: "refused: the file is a symbolic link or not a regular file" },
      ],
    });
  }, withoutGone);
});

test("a service staged without a commit carries only its contracts, hinted by a glob when the service declares one", async () => {
  await withService(TREE, async (s) => {
    const everything = await stage(s);
    const dir = serviceContextDir(s.front, "org/svc");
    assert.deepEqual(filesBelow(dir), ["contracts/docs/API-Definition.json", "contracts/openapi/openapi.yaml", "manifest.json"]);
    const manifest = manifestOf(everything.manifestPath);
    assert.equal("sha" in manifest, false, "the manifest names no commit");
    assert.deepEqual({ contracts: manifest.contracts, changed: manifest.changed, omitted: manifest.omitted }, { contracts: ["docs/API-Definition.json", "openapi/openapi.yaml"], changed: [], omitted: [] });

    const hinted = await stage(s, { openapi: ["src/*.txt"] });
    assert.deepEqual(manifestOf(hinted.manifestPath).contracts, ["src/a.txt"], "the hint replaces the default sweep");
    assert.deepEqual(manifestOf(hinted.manifestPath).omitted.map((o) => o.path), ["src/big.txt"], "the walk lists no link, and the file deleted from the tree is not there to list");
    assert.deepEqual(filesBelow(dir), ["contracts/src/a.txt", "manifest.json"], "a re-stage leaves nothing of the previous one");
  }, withoutGone);
});

test("a revision that is not a commit id is refused before git reads it as an option, and no patch, changed file or manifest follows", async () => {
  await withService(TREE, async (s) => {
    await assert.rejects(() => stage(s, { sha: `--output=${join(s.outside, "planted")}` }));
    assert.deepEqual(readdirSync(s.outside), ["secret.txt"], "git was never run with the option");
    assert.deepEqual(filesBelow(serviceContextDir(s.front, "org/svc")), ["contracts/docs/API-Definition.json", "contracts/openapi/openapi.yaml"], "the contracts were staged before the revision was judged, and no patch, changed file or manifest followed");
  });
});

test("a commit id the repository does not hold lists the patch and the changed files as omitted for git's failure and still stages the contracts", async () => {
  await withService(TREE, async (s) => {
    const staged = await stage(s, { sha: "0".repeat(40) });
    const manifest = manifestOf(staged.manifestPath);

    assert.deepEqual(manifest.contracts, ["docs/API-Definition.json", "openapi/openapi.yaml"]);
    assert.deepEqual(manifest.changed, []);
    assert.deepEqual(manifest.omitted.map((o) => o.path), ["CHANGE.patch", "changed/*"]);
    assert.match(manifest.omitted[0]!.reason, /^git show --patch failed: \S/);
    assert.match(manifest.omitted[1]!.reason, /^git show --name-only failed: \S/);
    assert.deepEqual(filesBelow(serviceContextDir(s.front, "org/svc")), ["contracts/docs/API-Definition.json", "contracts/openapi/openapi.yaml", "manifest.json"]);
  });
});

test("the patch staged for a commit within the caps is git's own show of it, and every file the commit changed is staged beside it", async () => {
  await withService({ "openapi.yaml": "openapi: 3.0.3\n", "src/a.txt": "an ordinary file\n" }, async (s) => {
    const staged = await stage(s, { sha: s.sha });
    const dir = serviceContextDir(s.front, "org/svc");

    assert.equal(readFileSync(join(dir, "CHANGE.patch"), "utf8"), execFileSync("git", ["show", "--stat", "--patch", s.sha], { cwd: s.svc, encoding: "utf8" }));
    assert.deepEqual(filesBelow(dir), ["CHANGE.patch", "changed/openapi.yaml", "changed/src/a.txt", "contracts/openapi.yaml", "manifest.json"]);
    assert.deepEqual(manifestOf(staged.manifestPath).omitted, []);
  });
});
