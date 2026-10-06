import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExportSecretCheck, buildPublicationEffectors } from "./rewritten-engine-factory";
import { LocalExportPublicationAdapter } from "@contexts/workspace-and-publication/infrastructure/local-export-publication.adapter";
import { GitHubPrAdapter } from "@contexts/workspace-and-publication/infrastructure/github-pr.adapter";
import { GitHubIssueAdapter } from "@contexts/workspace-and-publication/infrastructure/github-issue.adapter";

const base = {
  appName: "shop",
  baseBranch: "develop",
  namespace: "qa-bot-abc1234-run1",
  mode: "diff" as const,
  isCode: false,
  mirrorDir: "/mirrors/group__shop",
};

test("slim profile: one local exporter serves git write, PR, Issue and shadow preview", () => {
  const fx = buildPublicationEffectors({ ...base, env: { QAYABA_PROFILE: "slim", QAYABA_EXPORT_DIR: "/exports" } });
  assert.ok(fx.githubPr instanceof LocalExportPublicationAdapter);
  assert.equal(fx.githubIssue, fx.githubPr);
  assert.equal(fx.vcsWrite, fx.githubPr);
  assert.equal(fx.shadowPublication, fx.githubPr);
});

test("slim profile: exports land under <exportRoot>/<app>/<namespace> and only e2e/ is scanned", async () => {
  const exportDir = mkdtempSync(join(tmpdir(), "qa-export-"));
  try {
    const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
    const fx = buildPublicationEffectors(
      { ...base, env: { QAYABA_PROFILE: "slim", QAYABA_EXPORT_DIR: exportDir } },
      async (args, cwd) => {
        gitCalls.push({ args, cwd });
        return "";
      },
      () => {},
    );
    const res = await fx.vcsWrite!.publish({ mirrorDir: "/mirrors/group__shop", branch: "qa/e2e", sha: "abc1234" });
    assert.equal(res.changed, false);
    assert.deepEqual(gitCalls[0]?.args, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=dirty", "--", "e2e"]);
    const pr = await fx.githubPr.openWithAutoMerge("group/shop", "qa/e2e", "t", "b");
    assert.equal(pr.url, join(exportDir, "shop", "qa-bot-abc1234-run1", "MR.md"));
  } finally {
    rmSync(exportDir, { recursive: true, force: true });
  }
});

test("slim profile: context mode exports only the context map", async () => {
  const gitCalls: string[][] = [];
  const fx = buildPublicationEffectors(
    { ...base, mode: "context", env: { QAYABA_PROFILE: "slim", QAYABA_EXPORT_DIR: "/exports" } },
    async (args) => {
      gitCalls.push(args);
      return "";
    },
    () => {},
  );
  await fx.vcsWrite!.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });
  assert.deepEqual(gitCalls[0]?.slice(-2), ["--", "e2e/.qa/context.json"]);
});

test("full profile (default): GitHub PR/Issue adapters and no export-backed shadow preview", () => {
  const fx = buildPublicationEffectors({ ...base, env: {} });
  assert.ok(fx.githubPr instanceof GitHubPrAdapter);
  assert.ok(fx.githubIssue instanceof GitHubIssueAdapter);
  assert.equal(typeof fx.vcsWrite?.publish, "function");
  assert.equal(fx.shadowPublication, undefined);
});

test("an unknown profile fails loud instead of silently publishing remotely", () => {
  assert.throws(() => buildPublicationEffectors({ ...base, env: { QAYABA_PROFILE: "lite" } }), /QAYABA_PROFILE/);
});

/* A slim export of one file the agent wrote into a real temp mirror, screened by the check the composition root injects. */
async function exportOneFile(content: string, env: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "qa-export-screen-"));
  try {
    const mirrorDir = join(root, "mirror");
    mkdirSync(join(mirrorDir, "e2e"), { recursive: true });
    writeFileSync(join(mirrorDir, "e2e", "flow.spec.ts"), content);
    const fx = buildPublicationEffectors(
      { ...base, mirrorDir, env: { QAYABA_PROFILE: "slim", QAYABA_EXPORT_DIR: join(root, "out"), ...env } },
      async (args) => (args[0] === "status" ? "?? e2e/flow.spec.ts\0" : ""),
      () => {},
    );
    return await fx.vcsWrite!.publish({ mirrorDir, branch: "qa/e2e", sha: "abc1234" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("slim profile: a file carrying the exact value of a secret env var is left out of the export", async () => {
  const password = "correct-horse-battery-staple";
  const res = await exportOneFile(`await page.fill("#pw", "${password}");`, { E2E_APP_PASSWORD: password });
  assert.equal(res.changed, false);
  assert.deepEqual(res.leftOut?.map((l) => l.path), ["e2e/flow.spec.ts"]);
});

test("slim profile: a file carrying a token-shaped secret is left out of the export", async () => {
  const token = "ghp_" + "a1B2".repeat(9);
  const res = await exportOneFile(`const t = "${token}";`, {});
  assert.equal(res.changed, false);
  assert.equal(res.leftOut?.length, 1);
});

test("slim profile: ordinary test code that merely names a credential is exported (the stock fixtures must not be held back)", async () => {
  const res = await exportOneFile(`const DEFAULT_PASSWORD_SELECTOR = 'input[type="password"]';\nexport const user = process.env.E2E_APP_PASSWORD;`, {
    E2E_APP_PASSWORD: "correct-horse-battery-staple",
  });
  assert.equal(res.changed, true);
  assert.equal(res.leftOut, undefined);
});

/* The screen the composition root injects into the local exporter, called as the exporter calls it: with the text of a new file or with the lines a patch adds. */
const GATEWAY_KEY_VALUE = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpL";
const UUID_VALUE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

test("export screen: a credential-named constant holding a key-shaped value is caught even though its name matches the ignored pattern", () => {
  const screen = buildExportSecretCheck({});

  assert.equal(screen(`export const GATEWAY_KEY = "${GATEWAY_KEY_VALUE}";`), true);
  assert.equal(screen(`export const API_KEY = "${UUID_VALUE}";`), true);
});

test("export screen: the exact value of a secret env var is caught wherever it appears", () => {
  const screen = buildExportSecretCheck({ DEV_TEST_PASS: "correct-horse-battery" });

  assert.equal(screen('await page.fill("#pw", "correct-horse-battery");'), true);
});

test("export screen: a constant that only names a credential is clean", () => {
  const screen = buildExportSecretCheck({});

  assert.equal(screen(`const DEFAULT_PASSWORD_SELECTOR = 'input[type="password"]';`), false);
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test("export screen: the e2e seed files, which every first run publishes, pass", () => {
  const screen = buildExportSecretCheck({});
  const seed = filesUnder(join(process.cwd(), "config", "e2e"));

  assert.ok(seed.length > 0, "the seed is found");
  for (const file of seed) assert.equal(screen(readFileSync(file, "utf8")), false, file);
});

/* A slim export of a tracked file whose patch git prints as `patch`, screened by the injected check. */
async function exportTrackedChange(patch: string) {
  const root = mkdtempSync(join(tmpdir(), "qa-export-patch-"));
  try {
    const mirrorDir = join(root, "mirror");
    mkdirSync(join(mirrorDir, "e2e"), { recursive: true });
    writeFileSync(join(mirrorDir, "e2e", "fixtures.ts"), "// content the screen must not read whole\n");
    const fx = buildPublicationEffectors(
      { ...base, mirrorDir, env: { QAYABA_PROFILE: "slim", QAYABA_EXPORT_DIR: join(root, "out") } },
      async (args) => (args[0] === "status" ? " M e2e/fixtures.ts\0" : args[0] === "diff" ? patch : ""),
      () => {},
    );
    return await fx.vcsWrite!.publish({ mirrorDir, branch: "qa/e2e", sha: "abc1234" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const textPatch = (body: string[]) => `diff --git a/e2e/fixtures.ts b/e2e/fixtures.ts\n--- a/e2e/fixtures.ts\n+++ b/e2e/fixtures.ts\n@@ -1,${body.filter((l) => !l.startsWith("+")).length} +1,${body.filter((l) => !l.startsWith("-")).length} @@\n${body.join("\n")}\n`;

test("slim profile: a key-shaped literal already in a tracked file does not hold back a change that leaves it alone", async () => {
  const res = await exportTrackedChange(textPatch([` const GATEWAY_KEY = "${GATEWAY_KEY_VALUE}";`, "+const added = 1;"]));

  assert.equal(res.changed, true);
  assert.equal(res.leftOut, undefined);
});

test("slim profile: a key-shaped literal on a line the change adds is held back", async () => {
  const res = await exportTrackedChange(textPatch([" const keep = 1;", `+const GATEWAY_KEY = "${GATEWAY_KEY_VALUE}";`]));

  assert.equal(res.changed, false);
  assert.deepEqual(res.leftOut?.map((l) => l.path), ["e2e/fixtures.ts"]);
});

test("slim profile: a binary baseline in the patch is not read as a secret", async () => {
  const body = `zcmZQz${GATEWAY_KEY_VALUE}${GATEWAY_KEY_VALUE}`;
  const patch = `diff --git a/e2e/fixtures.ts b/e2e/fixtures.ts\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 900\n${body}\n\nliteral 0\nHcmV?d00001\n\n`;

  const res = await exportTrackedChange(patch);

  assert.equal(res.changed, true);
  assert.equal(res.leftOut, undefined);
});
