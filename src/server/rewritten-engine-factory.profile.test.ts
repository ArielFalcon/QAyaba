import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPublicationEffectors } from "./rewritten-engine-factory";
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
