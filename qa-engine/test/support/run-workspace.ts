/*
 * A real working copy for run-level tests: a temp mirror with its e2e directory and the suite store the composition puts behind
 * a run, over a temp store directory. The proof ledger, the final guard and the store hash and restore these bytes for real, so
 * a run that publishes has executed a spec that exists — as in production.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GenerationPort } from "@contexts/generation/application/index.ts";
import { SuiteStoreAdapter } from "@contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts";
import type { SuiteStorePort } from "@kernel/ports/suite-store.port.ts";

export interface RunWorkspace {
  readonly baseDir: string;
  readonly mirrorDir: string;
  readonly specDir: string;
  readonly suiteStore: SuiteStorePort;
  /** Writes a file below the suite directory, as the agent would. */
  write(file: string, text?: string): void;
  has(file: string): boolean;
  cleanup(): void;
}

const pendingCleanup = new Set<string>();
let cleanupHooked = false;

/** A test that never calls cleanup() still leaves no directory behind when the runner exits. */
function cleanupAtExit(baseDir: string): void {
  pendingCleanup.add(baseDir);
  if (cleanupHooked) return;
  cleanupHooked = true;
  process.once("exit", () => {
    for (const dir of pendingCleanup) rmSync(dir, { recursive: true, force: true });
  });
}

export function runWorkspace(prefix = "qa-run-"): RunWorkspace {
  const baseDir = mkdtempSync(join(tmpdir(), prefix));
  cleanupAtExit(baseDir);
  const mirrorDir = join(baseDir, "mirror");
  const specDir = join(mirrorDir, "e2e");
  mkdirSync(specDir, { recursive: true });
  const suiteStore = new SuiteStoreAdapter({
    storeDir: join(baseDir, "suite-store"),
    app: "demo",
    repo: "org/app",
    specRelDir: "e2e",
    listTracked: async () => new Map(),
    now: () => new Date(Date.UTC(2026, 0, 1)),
  });
  return {
    baseDir,
    mirrorDir,
    specDir,
    suiteStore,
    write(file, text = `// fixture ${file}\n`) {
      const path = join(specDir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    has: (file) => existsSync(join(specDir, file)),
    cleanup: () => {
      pendingCleanup.delete(baseDir);
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

/*
 * The disk side effect a real generator has: every spec a turn delivers exists when the turn returns, in the spec directory the
 * turn was given. Bytes a test wrote itself stay untouched, so a scripted rewrite keeps its own content.
 */
function writeDelivered(specDir: string, specs: readonly string[]): void {
  if (!existsSync(specDir)) return;
  for (const file of specs) {
    if (!file.endsWith(".spec.ts")) continue;
    const path = join(specDir, file);
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `// fixture ${file}\n`);
  }
}

/** A generation port that leaves the specs each turn delivers on disk until the turn returns. */
export function generationOnDisk(port: GenerationPort): GenerationPort {
  return {
    ...port,
    generate: async (...args) => {
      const output = await port.generate(...args);
      writeDelivered(args[0], output.specs);
      return output;
    },
  };
}

/*
 * The same port, for a rig whose tests replace `generate` after the harness is built: the assignment keeps the disk side effect,
 * so a scripted turn still leaves the specs it reported in the spec directory it was given.
 */
export function reassignableGeneration(initial: GenerationPort["generate"]): GenerationPort {
  /* The getter hands out the concrete function, so a test that captures it and wraps it keeps a direct call, never a cycle. */
  const onDisk = (generate: GenerationPort["generate"]): GenerationPort["generate"] => async (...args) => {
    const output = await generate(...args);
    writeDelivered(args[0], output.specs);
    return output;
  };
  let current = onDisk(initial);
  return {
    get generate() {
      return current;
    },
    set generate(next: GenerationPort["generate"]) {
      current = onDisk(next);
    },
  };
}
