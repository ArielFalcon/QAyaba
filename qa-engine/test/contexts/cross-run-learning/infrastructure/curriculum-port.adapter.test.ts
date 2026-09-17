import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CurriculumPortAdapter } from "@contexts/cross-run-learning/infrastructure/curriculum-port.adapter.ts";
import { initCurriculum, foldCurriculum, type Curriculum } from "@contexts/cross-run-learning/domain/curriculum.ts";
import { MAX_SELECTED_EXEMPLARS } from "@contexts/qa-run-orchestration/application/ports/index.ts";

/* A diff that matches four exemplars across form, api-call and data-list, exceeding the cap of three. */
const RICH_DIFF = `
+<form onsubmit="save()"><input required minlength="3" /></form>
+const res = await fetch(url, { method: 'POST', body: payload });
+if (!res.ok) { this.error = 'failed'; }
+<table><tr *ngFor="let row of rows"></tr></table>
+<div *ngIf="rows.length === 0">No results</div>
`;
const FILES = ["src/app/owner/owner.component.html", "src/app/owner/owner.service.ts"];

function store(initial: Curriculum | null) {
  let saved: Curriculum | null = initial;
  return {
    load: () => saved,
    save: (c: Curriculum) => { saved = c; },
    get current() { return saved; },
  };
}

describe("CurriculumPortAdapter.select", () => {
  it("caps a richer match set at MAX_SELECTED_EXEMPLARS, ranked", async () => {
    const s = store(null);
    const adapter = new CurriculumPortAdapter("app", s.load, s.save);
    const selected = await adapter.select(RICH_DIFF, FILES);
    assert.equal(selected.length, MAX_SELECTED_EXEMPLARS);
  });

  it("puts a proven archetype first", async () => {
    const proven = foldCurriculum(initCurriculum("app"), ["empty-state"], "bug", "2026-09-04T10:00:00.000Z");
    const s = store(proven);
    const selected = await new CurriculumPortAdapter("app", s.load, s.save).select(RICH_DIFF, FILES);
    assert.equal(selected[0]!.archetype, "empty-state");
    assert.equal(selected[0]!.proven, true);
    assert.equal(selected[0]!.promotionCount, 1);
  });

  it("returns an empty list when there is no diff — nothing offered, nothing to fold", async () => {
    const s = store(null);
    assert.deepEqual(await new CurriculumPortAdapter("app", s.load, s.save).select(undefined, []), []);
  });

  it("returns an empty list, never throws, when the store fails", async () => {
    let logged: unknown;
    const adapter = new CurriculumPortAdapter(
      "app",
      () => { throw new Error("db down"); },
      () => {},
      (error) => { logged = error; },
    );
    assert.deepEqual(await adapter.select(RICH_DIFF, FILES), []);
    assert.ok(logged instanceof Error);
    assert.equal(logged.message, "db down");
  });
});

describe("CurriculumPortAdapter.fold", () => {
  it("persists credit for every offered archetype on a covered run", async () => {
    const s = store(null);
    const adapter = new CurriculumPortAdapter("app", s.load, s.save);
    await adapter.fold({ offered: ["happy-path", "empty-state"], verdict: "pass", coverageStatus: "pass" });
    const saved = s.current!;
    assert.equal(saved.archetypes.find((a) => a.archetype === "happy-path")!.credited, 1);
    assert.equal(saved.archetypes.find((a) => a.archetype === "empty-state")!.credited, 1);
  });

  it("does not write at all for an inconclusive run", async () => {
    const s = store(null);
    await new CurriculumPortAdapter("app", s.load, s.save).fold({ offered: ["happy-path"], verdict: "flaky" });
    assert.equal(s.current, null);
  });

  it("does not write when every offered archetype is unknown", async () => {
    let writes = 0;
    const adapter = new CurriculumPortAdapter(
      "app",
      () => null,
      () => { writes++; },
    );
    await adapter.fold({ offered: ["unknown-archetype"], verdict: "pass", coverageStatus: "pass" });
    assert.equal(writes, 0);
  });

  it("swallows a store failure — never gates the run", async () => {
    let logged: unknown;
    const adapter = new CurriculumPortAdapter("app", () => null, () => { throw new Error("disk full"); }, (e) => { logged = e; });
    await adapter.fold({ offered: ["happy-path"], verdict: "pass", coverageStatus: "pass" });
    assert.ok(logged instanceof Error);
  });
});
