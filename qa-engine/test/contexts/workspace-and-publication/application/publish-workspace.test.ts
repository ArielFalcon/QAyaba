/* PublishWorkspace: what each kind of run stages, in what order, and what it reports. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublishWorkspace } from "@contexts/workspace-and-publication/application/publish-workspace.use-case.ts";
import { commitMessageFor, excludesFor, pathspecsFor, type PublishKind } from "@contexts/workspace-and-publication/domain/publish-policy.ts";
import type { VcsWritePort } from "@contexts/workspace-and-publication/application/ports/vcs-write.port.ts";

interface Recording {
  vcs: VcsWritePort;
  calls: string[];
  commits: { message: string; files: readonly string[]; denied: (path: string) => boolean }[];
}

function recordingVcs(opts: { changed?: boolean; reverted?: { denylisted: string[]; dangerous: string[] } } = {}): Recording {
  const calls: string[] = [];
  const commits: Recording["commits"] = [];
  const vcs: VcsWritePort = {
    writeExcludes: async (_dir, patterns) => void calls.push(`excludes:${patterns.join(",")}`),
    hasChanges: async (_dir, pathspecs) => (calls.push(`changes:${pathspecs.join(",")}`), opts.changed ?? true),
    checkoutBranch: async (_dir, branch) => void calls.push(`checkout:${branch}`),
    commit: async (_dir, message, files, denied) => {
      calls.push("commit");
      commits.push({ message, files, denied: denied as (path: string) => boolean });
      return { revertedDenylisted: opts.reverted?.denylisted ?? [], revertedDangerous: opts.reverted?.dangerous ?? [] };
    },
    push: async (_dir, branch) => void calls.push(`push:${branch}`),
  };
  return { vcs, calls, commits };
}

const KINDS: PublishKind[] = ["e2e", "code", "context"];

for (const kind of KINDS) {
  test(`a ${kind} publication writes its excludes, then stages its pathspecs, commits with its message and pushes after the commit`, async () => {
    const { vcs, calls, commits } = recordingVcs();

    const outcome = await new PublishWorkspace(kind, vcs).publish({ mirrorDir: "/m", branch: "qa-bot/b" });

    assert.equal(outcome.changed, true);
    assert.deepEqual(calls, [`excludes:${excludesFor(kind).join(",")}`, `changes:${pathspecsFor(kind).join(",")}`, "checkout:qa-bot/b", "commit", "push:qa-bot/b"]);
    assert.equal(commits[0]!.message, commitMessageFor(kind));
    assert.deepEqual(commits[0]!.files, pathspecsFor(kind));
  });

  test(`a ${kind} publication with nothing changed reports it and touches no branch`, async () => {
    const { vcs, calls } = recordingVcs({ changed: false });

    const outcome = await new PublishWorkspace(kind, vcs).publish({ mirrorDir: "/m", branch: "qa-bot/b" });

    assert.deepEqual(outcome, { changed: false });
    assert.deepEqual(calls, [`excludes:${excludesFor(kind).join(",")}`, `changes:${pathspecsFor(kind).join(",")}`]);
  });
}

test("the reverts of the tracked-file denylist are reported to the caller", async () => {
  const { vcs } = recordingVcs({ reverted: { denylisted: [".env"], dangerous: ["sub/mod"] } });

  const outcome = await new PublishWorkspace("code", vcs).publish({ mirrorDir: "/m", branch: "b" });

  assert.deepEqual(outcome, { changed: true, revertedDenylisted: [".env"], revertedDangerous: ["sub/mod"] });
});

test("the commit is given the code-denylist guard, which denies an env file and allows a spec", async () => {
  const { vcs, commits } = recordingVcs();

  await new PublishWorkspace("code", vcs).publish({ mirrorDir: "/m", branch: "b" });

  assert.equal(commits[0]!.denied(".env"), true);
  assert.equal(commits[0]!.denied("e2e/login.spec.ts"), false);
});
