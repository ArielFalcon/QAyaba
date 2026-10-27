import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSections, makeSection, WINDOW_FIT_REASON, type SectionDegradation, type WindowFitOutcome } from "../../src/shared-kernel/prompt-sections.ts";

/* A fit rule over a fixed window, the way the run's ContextBudget answers it. */
const windowOf = (bytes: number) => (size: number): WindowFitOutcome => (size <= bytes ? "fits" : "over");

/* A section of `pages` page blocks that gives way one page at a time, the last page first, each named as a reference. */
function pagedSection(id: string, pages: string[], opts: { priority?: number; role?: "volatile" | "semi-stable" } = {}) {
  const page = (name: string): string => `route ${name}:\n${"  node line\n".repeat(20)}`;
  const render = (referenced: number): SectionDegradation => ({
    content: pages.map((name, i) => (i >= pages.length - referenced ? `route ${name}: (left out to fit the window)` : page(name))).join("\n"),
    omissions: pages.slice(pages.length - referenced).map((route) => ({ class: "truncation" as const, reason: WINDOW_FIT_REASON, count: 20, route })),
  });
  return makeSection(id, opts.role ?? "volatile", render(0).content, {
    priority: opts.priority ?? 0,
    itemIds: pages.map((name) => `route:${name}`),
    degrade: (step) => (step <= pages.length ? render(step) : undefined),
  });
}

test("a prompt over its role's window degrades a section page by page, the last page first, until it fits", () => {
  const task = makeSection("task", "task", "## Task\nwrite the specs");
  const pages = pagedSection("pack", ["/a", "/b", "/c"]);
  const whole = assembleSections([task, pages]).text;
  const window = Buffer.byteLength(whole, "utf8") - 300;

  const assembled = assembleSections([task, pages], { fit: windowOf(window) });

  assert.ok(Buffer.byteLength(assembled.text, "utf8") <= window);
  assert.match(assembled.text, /route \/c: \(left out to fit the window\)/);
  assert.match(assembled.text, /route \/a:\n {2}node line/);
  assert.equal(assembled.windowFit?.outcome, "fits");
  assert.deepEqual(assembled.windowFit?.degraded.map((d) => d.id), ["pack"]);
  const omissions = assembled.sectionItems["pack"]?.omissions ?? [];
  assert.ok(omissions.every((o) => o.reason === WINDOW_FIT_REASON && o.class === "truncation"));
  assert.ok(omissions.some((o) => o.route === "/c"));
  assert.ok(!omissions.some((o) => o.route === "/a"), "a page the window holds is not recorded as lost");
});

test("the window degrades the lowest-priority run fact first and leaves the next one whole once the prompt fits", () => {
  const kept = pagedSection("dom", ["/x", "/y"], { priority: 1 });
  const first = pagedSection("missing", ["/m", "/n"], { priority: 3 });
  const whole = assembleSections([kept, first]).text;

  const assembled = assembleSections([kept, first], { fit: windowOf(Buffer.byteLength(whole, "utf8") - 100) });

  assert.deepEqual(assembled.windowFit?.degraded.map((d) => d.id), ["missing"]);
  assert.equal(assembled.sectionItems["dom"]?.omissions.length, 0);
  assert.deepEqual(assembled.sectionItems["dom"]?.itemIds, ["route:/x", "route:/y"]);
});

test("an unknown window degrades nothing and records that it was unknown", () => {
  const pages = pagedSection("pack", ["/a", "/b"]);
  const plain = assembleSections([pages]);

  const assembled = assembleSections([pages], { fit: () => "unknown" });

  assert.equal(assembled.text, plain.text);
  assert.deepEqual(assembled.windowFit, { outcome: "unknown", degraded: [] });
});

test("a prompt that fits its role's window is assembled byte for byte as without the rule", () => {
  const sections = [makeSection("task", "task", "## Task\nx"), pagedSection("pack", ["/a", "/b"])];
  const plain = assembleSections(sections);

  const assembled = assembleSections(sections, { fit: windowOf(1_000_000) });

  assert.equal(assembled.text, plain.text);
  assert.deepEqual(assembled.sectionItems, plain.sectionItems);
  assert.deepEqual(assembled.windowFit, { outcome: "fits", degraded: [] });
});

test("a render the window chose adds its claims to the section's own, and a whole render adds none", () => {
  const own = { kind: "provides", fact: "existing-suite" } as const;
  const added = { kind: "provides", fact: "diff" } as const;
  const section = makeSection("diff", "volatile", "x".repeat(400), {
    claims: [own],
    degrade: (step) => (step === 1 ? { content: "(references)", omissions: [{ class: "truncation", reason: WINDOW_FIT_REASON, count: 1 }], claims: [added] } : undefined),
  });

  assert.deepEqual(assembleSections([section]).claims["diff"], [own]);
  assert.deepEqual(assembleSections([section], { fit: windowOf(50) }).claims["diff"], [own, added]);
});

test("a prompt still over with every step taken is sent degraded and says it is over", () => {
  const sections = [makeSection("task", "task", "## Task\n" + "t".repeat(500)), pagedSection("pack", ["/a"])];

  const assembled = assembleSections(sections, { fit: windowOf(100) });

  assert.equal(assembled.windowFit?.outcome, "over");
  assert.match(assembled.text, /route \/a: \(left out to fit the window\)/);
  assert.match(assembled.text, /## Task/, "a section with no smaller render is never degraded");
});
