/* buildWorkspaceAndPublication: the handle the workspace issues is the key the publication, confinement and gc accept, a shadow run publishes to the log, and the sanitizer is required. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkspaceAndPublication, type WorkspaceAndPublicationDeps } from "@contexts/workspace-and-publication/composition/build-workspace-and-publication.ts";

const sha = "abc1234" as never;

function deps(over: Partial<WorkspaceAndPublicationDeps> = {}, run: Partial<WorkspaceAndPublicationDeps["run"]> = {}): WorkspaceAndPublicationDeps {
  return {
    run: { repo: "o/app", branch: "qa/x", target: "e2e", isCode: false, e2eRelDir: "e2e", shadow: true, ...run },
    checkout: async () => "/mirror",
    publication: {
      githubPr: { openPr: async () => { throw new Error("no pr in shadow"); } } as never,
      githubIssue: { openIssue: async () => { throw new Error("no issue in shadow"); } } as never,
      sanitize: (text) => text,
    },
    ...over,
  };
}

test("the workspace resolves a checkout into the e2e spec directory under the mirror", async () => {
  const api = buildWorkspaceAndPublication(deps());

  const handle = await api.workspace.prepare(sha);

  assert.deepEqual(api.workspace.readRoots(handle), { mirrorDir: "/mirror", specDir: "/mirror/e2e" });
});

test("a code run's spec directory is the bare mirror and it builds no cleanup", async () => {
  const api = buildWorkspaceAndPublication(deps({ cleanup: { e2e: async () => undefined } as never }, { isCode: true, target: "code" }));

  const handle = await api.workspace.prepare(sha);

  assert.equal(api.workspace.readRoots(handle).specDir, "/mirror");
  assert.equal(api.cleanup, undefined);
});

test("a shadow run publishes a passing run to the shadow log and opens nothing on the repo", async () => {
  const api = buildWorkspaceAndPublication(deps());
  const handle = await api.workspace.prepare(sha);
  const result = await api.publication.publish({ verdict: "pass", cases: [], logs: "", workspace: handle });

  assert.match(result.outcome, /^shadow:/);
});

test("confinement and gc are built only when their collaborators are supplied", () => {
  assert.equal(buildWorkspaceAndPublication(deps()).confinement, undefined);
  assert.equal(buildWorkspaceAndPublication(deps()).mirrorGc, undefined);
  const api = buildWorkspaceAndPublication(deps({ confinement: {} as never, mirrorGc: {} as never }));
  assert.ok(api.confinement);
  assert.ok(api.mirrorGc);
});

test("the snapshot wrapper leaves the validation port as it is without a snapshot store", () => {
  const validation = { validate: async () => ({ ok: true, errors: [], infra: false }) } as never;
  assert.equal(buildWorkspaceAndPublication(deps()).snapshotValidation(validation), validation);
  assert.notEqual(buildWorkspaceAndPublication(deps({ specSnapshots: {} as never })).snapshotValidation(validation), validation);
  assert.equal(buildWorkspaceAndPublication(deps({ specSnapshots: {} as never }, { isCode: true })).snapshotValidation(validation), validation);
});

test("a build without the outbound sanitizer is refused", () => {
  const base = deps();
  assert.throws(() => buildWorkspaceAndPublication({ ...base, publication: { ...base.publication, sanitize: undefined as never } }), /sanitize is required/);
});
