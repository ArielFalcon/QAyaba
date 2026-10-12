// Runs INSIDE the execution sandbox. Every test PASSES when the isolation holds.
import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function codeOf(action: () => unknown): string {
  try {
    action();
    return "succeeded";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "failed";
  }
}

// What the harness tells the specs, written beside them by the orchestrator (a child gets no variables of its own choosing).
const context = JSON.parse(readFileSync(join(process.cwd(), "smoke-context.json"), "utf8")) as { otherMirror: string };

const DENIED = /^(EACCES|EPERM|EROFS)$/;

test("the mirror the suite runs in cannot be written", () => {
  expect(codeOf(() => writeFileSync(join(process.cwd(), "planted-by-smoke.txt"), "x"))).toMatch(DENIED);
});

test("the specs the suite runs cannot be rewritten", () => {
  expect(codeOf(() => writeFileSync(join(process.cwd(), "secrets.spec.ts"), "// rewritten"))).toMatch(DENIED);
});

test("another repo's mirror can be neither listed nor written", () => {
  const other = context.otherMirror;
  expect(other).not.toBe("");
  expect(codeOf(() => readdirSync(other))).toMatch(DENIED);
  expect(codeOf(() => writeFileSync(join(other, "planted-by-smoke.txt"), "x"))).toMatch(DENIED);
});

test("the mirrors volume cannot be listed", () => {
  expect(codeOf(() => readdirSync("/app/.mirrors"))).toMatch(DENIED);
});

test("the orchestrator's own code cannot be changed", () => {
  expect(codeOf(() => writeFileSync("/app/src/planted-by-smoke.txt", "x"))).toMatch(DENIED);
});

test("an app config cannot be written, so a run cannot widen what the next run may reach", () => {
  expect(codeOf(() => writeFileSync("/app/config/apps/planted-by-smoke.yaml", "x"))).toMatch(DENIED);
  expect(codeOf(() => writeFileSync("/app/config/egress/registries.yaml", "x", { flag: "r+" }))).toMatch(DENIED);
});

test("no mount under the orchestrator's root can be written (code, config, state: whatever the host's filesystem enforces)", () => {
  const mounts = readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .map((line) => line.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))))
    .filter((point): point is string => point !== undefined && point.startsWith("/app/"));
  expect(mounts.length).toBeGreaterThan(0);
  for (const point of mounts) {
    const planted = join(point, "planted-by-smoke.txt");
    let code = codeOf(() => writeFileSync(planted, "x", { flag: "wx" }));
    if (code === "ENOTDIR") code = codeOf(() => writeFileSync(point, "", { flag: "a" }));
    if (code === "succeeded") rmSync(planted, { force: true });
    expect(code, point).toMatch(DENIED);
  }
});

test("the run's own temp dir is writable (the sandbox has somewhere to work)", () => {
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  expect(codeOf(() => writeFileSync(join(dir, "ok.txt"), "x"))).toBe("succeeded");
});
