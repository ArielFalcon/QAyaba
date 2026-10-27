/*
 * Fails a test that starts with the process's timers or clock replaced. In a shared worker (`--test-isolation=none`)
 * every file runs in one process, so a test that leaves setTimeout, setInterval, setImmediate or Date replaced (the
 * global `mock.timers` never reset, or a test whose work goes on after it ended with timers still mocked) breaks every
 * test that runs after it, far from the cause: a wait on a mocked setTimeout never ends. The guard checks the globals
 * and node:timers at the start of each outermost test (one no other test is running around), names the replacement and
 * the last test that ended before it, and puts the originals back so one leak fails one test, not the rest of the worker.
 *
 * A test mocks time with `t.mock.timers`, which node:test resets when that test ends. A subtest that starts inside a
 * test that mocked time is not checked: the replacement is its parent's and still in force.
 */
import timers from "node:timers";
import timersPromises from "node:timers/promises";
import { relative } from "node:path";

const GUARDED = [
  [globalThis, "globalThis", ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"]],
  [timers, "node:timers", ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate"]],
  [timersPromises, "node:timers/promises", ["setTimeout", "setInterval", "setImmediate"]],
];

/* Whether this process runs test files itself: a shared worker, or the child node --test starts per file. The parent of
   per-file processes only reports, and has no test of its own to guard. */
export function runsTestsInThisProcess(execArgv = process.execArgv, env = process.env) {
  return env.NODE_TEST_CONTEXT !== undefined || execArgv.includes("--test-isolation=none") || execArgv.includes("--experimental-test-isolation=none");
}

/* `hooks` is node:test's { beforeEach, afterEach }; `root` makes the reported file path relative. */
export function installGlobalTimerGuard(hooks, root) {
  const originals = GUARDED.flatMap(([owner, ownerName, names]) =>
    names.map((name) => ({ owner, label: `${ownerName}.${name}`, name, value: owner[name], descriptor: Object.getOwnPropertyDescriptor(owner, name) })),
  );
  let running = 0;
  let lastEnded = "none: it is the first test of this process";
  hooks.beforeEach(() => {
    running += 1;
    if (running > 1) return;
    const replaced = originals.filter((o) => o.owner[o.name] !== o.value);
    if (replaced.length === 0) return;
    for (const o of replaced) Object.defineProperty(o.owner, o.name, o.descriptor);
    throw new Error(
      `${replaced.map((o) => o.label).join(", ")} ${replaced.length === 1 ? "was" : "were"} still replaced when this test started ` +
        `(the originals are now put back). The last test to end before it: ${lastEnded}. A test mocks time with t.mock.timers, ` +
        "which is reset when the test ends, never the global mock.timers, and leaves no work of its own running after it ends.",
    );
  });
  hooks.afterEach((t) => {
    running -= 1;
    const file = t.filePath ? ` (${root ? relative(root, t.filePath) : t.filePath})` : "";
    lastEnded = `"${t.fullName}"${file}`;
  });
}
