/*
 * The rig behind the run-end table: a complete set of fake ports around a real working copy, a recorder for everything a run
 * does to the outside (history, publication, learning), and `observe`, which runs one run and reports what happened to it.
 * A row mutates the rig before the run; nothing here knows which end a row is aiming for.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { SuiteStorePort } from "@kernel/ports/suite-store.port.ts";
import { RunQaUseCase, type RunQaConfig, type RunQaInput, type RunQaResult, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type {
  ChangeAnalysisPort,
  ExecutionPort,
  GenerationPort,
  ObjectiveSignalPort,
  PublicationPort,
  ReviewPort,
  SetupPort,
  ValidationPort,
  WorkspacePort,
} from "@contexts/run-orchestration/application/ports/index.ts";
import { scriptedGeneration } from "../../../../support/generation-output.ts";
import { reassignableGeneration, runWorkspace, type RunWorkspace } from "../../../../support/run-workspace.ts";

/** Where a run stood and what it did to the outside when it ended. */
export interface Observed {
  /** What `run()` rejected with; absent when it returned. */
  threw?: unknown;
  result?: RunQaResult;
  saved: RunOutcome[];
  folded: RunOutcome[];
  reflections: number;
  publishCalls: number;
}

export interface Rig {
  readonly ws: RunWorkspace;
  /** Scratch directories the rig made outside the working copy; removed by `dispose`. */
  readonly scratch: string[];
  input: Partial<RunQaInput>;
  config: Partial<RunQaConfig>;
  abort: AbortController;
  /** The ports a row replaces. */
  classify: ChangeAnalysisPort["classify"];
  generate: GenerationPort["generate"];
  review: ReviewPort["review"];
  validate: ValidationPort["validate"];
  execute: ExecutionPort["execute"];
  measure: ObjectiveSignalPort["measure"];
  blocks: ObjectiveSignalPort["blocks"];
  publish: PublicationPort["publish"];
  setup: SetupPort["setup"] | undefined;
  waitUntilServing: () => ReturnType<NonNullable<RunQaUseCaseDeps["deployGate"]>["waitUntilServing"]>;
  prepare: WorkspacePort["prepare"];
  /** The suite store behind the run; a row wraps it to script what the final proof guard sees. */
  store: SuiteStorePort | undefined;
  /** Dependencies a row adds (auth, sandbox scope, grounding ...). */
  extra: Partial<RunQaUseCaseDeps>;
  /** Last word on the assembled dependencies, for the one row that needs a property to change during the run. */
  shape?: (deps: RunQaUseCaseDeps) => RunQaUseCaseDeps;
  /** Scratch that must be undone when the rig is disposed (a permission change, for example). */
  onDispose: Array<() => void>;
}

export const RIG_SPEC = "a.spec.ts";

export function newRig(): Rig {
  const ws = runWorkspace("qa-run-end-");
  const rig: Rig = {
    ws,
    scratch: [],
    input: {},
    config: {},
    abort: new AbortController(),
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }),
    generate: async () => scriptedGeneration({ specs: [RIG_SPEC], approved: true }),
    review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }),
    validate: async () => ({ ok: true, errors: [] }),
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    measure: async () => ({ status: "unknown", ratio: null }),
    blocks: () => false,
    publish: async () => ({ outcome: "pr" }),
    setup: async () => {},
    waitUntilServing: async () => ok(true),
    prepare: async () => ({ specDir: ws.specDir, mirrorDir: ws.mirrorDir }),
    store: ws.suiteStore,
    extra: {},
    onDispose: [],
  };
  return rig;
}

export function scratchDir(rig: Rig, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  rig.scratch.push(dir);
  return dir;
}

export function dispose(rig: Rig): void {
  for (const undo of rig.onDispose.splice(0)) undo();
  for (const dir of rig.scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  rig.ws.cleanup();
}

const BASE_INPUT = { app: "demo", sha: Sha.of("abc1234"), source: "manual" as const, mode: "diff" as const, target: "e2e" as const };
const BASE_CONFIG: Partial<RunQaConfig> = { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false };

/** Runs one run through the rig and reports what it did. The rig is the caller's to dispose. */
export async function observe(rig: Rig, runId: string): Promise<Observed> {
  const saved: RunOutcome[] = [];
  const folded: RunOutcome[] = [];
  let reflections = 0;
  let publishCalls = 0;
  const generation = reassignableGeneration(rig.generate);
  let deps: RunQaUseCaseDeps = {
    changeAnalysis: { classify: rig.classify },
    generation,
    review: { review: rig.review },
    validation: { validate: rig.validate },
    execution: { execute: rig.execute },
    objectiveSignal: { measure: rig.measure, blocks: rig.blocks },
    publication: { publish: async (input) => { publishCalls += 1; return await rig.publish(input); } },
    learning: { fold: async (outcome) => { folded.push(outcome); }, retrieve: async () => [] },
    workspace: { prepare: rig.prepare },
    deployGate: { waitUntilServing: async () => await rig.waitUntilServing() },
    runHistory: { save: async (outcome) => { saved.push(outcome); } },
    reflector: { reflect: async () => { reflections += 1; } },
    ...(rig.setup ? { setup: { setup: rig.setup } } : {}),
    ...(rig.store ? { suiteStore: rig.store } : {}),
    config: { ...BASE_CONFIG, ...rig.config },
    ...rig.extra,
  };
  if (rig.shape) deps = rig.shape(deps);
  const input: RunQaInput = { ...BASE_INPUT, runId, ...rig.input };
  try {
    const result = await new RunQaUseCase(deps).run(input, rig.abort.signal);
    return { result, saved, folded, reflections, publishCalls };
  } catch (threw) {
    return { threw, saved, folded, reflections, publishCalls };
  }
}

/** What a run came to, in the terms the run-end table states. */
export interface EndFacts {
  verdict: string;
  errorClass: string | null;
  furthestPhase: string | null;
  persisted: boolean;
  published: string;
  publishCalled: boolean;
  folded: boolean;
  reflected: boolean;
  note: string;
}

export function factsOf(observed: Observed): EndFacts {
  const { result } = observed;
  const published = !result ? "none" : result.decision.sideEffect;
  return {
    verdict: result ? result.decision.verdict : "threw",
    errorClass: result ? result.errorClass : null,
    furthestPhase: result?.gateSignals.furthestPhase ?? null,
    persisted: observed.saved.length > 0,
    published,
    publishCalled: observed.publishCalls > 0,
    folded: observed.folded.length > 0,
    reflected: observed.reflections > 0,
    note: result?.note ?? (observed.threw instanceof Error ? observed.threw.message : ""),
  };
}
