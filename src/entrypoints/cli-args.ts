/*
 * The manual trigger's command line (`npm run qa`): the flags it reads, what each may hold, and the run it asks the service for. Pure
 * parsing: a refusal is returned with the words the operator reads, and the process root (src/composition/cli.ts) prints it and exits.
 */
import { parseRunMode, RUN_MODES, type RunMode } from "@kernel/run-mode";
import type { DelegateRunInput } from "./run-delegate";
import type { GroundingInput } from "./contract/commands";

export interface CliArgs {
  app: string;
  sha: string;
  baseSha?: string;
  mode: RunMode;
  guidance?: string;
  closedLoop?: boolean;
  agentBrowser?: boolean;
  domPack?: boolean;
}

export type CliArgsResult = { readonly ok: true; readonly args: CliArgs } | { readonly ok: false; readonly message: string };

/** Every flag the CLI reads; any other is refused rather than silently ignored. */
const KNOWN_FLAGS: ReadonlySet<string> = new Set(["app", "sha", "base-sha", "mode", "guidance", "closed-loop", "agent-browser", "dom-pack"]);

/* An on/off flag: absent unless given, so the app's setting decides; any other value is refused. */
function onOff(value: string | undefined): boolean | undefined | "refused" {
  if (value === undefined) return undefined;
  return value === "on" ? true : value === "off" ? false : "refused";
}

export function parseCliArgs(argv: readonly string[]): CliArgsResult {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]?.replace(/^--/, "");
    if (key && !KNOWN_FLAGS.has(key)) return { ok: false, message: `Unknown argument --${key}` };
    if (key) out[key] = argv[i + 1] ?? "";
    if (key) i++;  /* skip value */
  }
  if (!out.app || !out.sha) {
    return {
      ok: false,
      message: `Usage: npm run qa -- --app <app> --sha <sha> [--base-sha <sha>] [--mode ${RUN_MODES.join("|")}] [--guidance "..."] [--closed-loop on|off] [--agent-browser on|off] [--dom-pack on|off]`,
    };
  }
  const parsedMode = parseRunMode(out.mode);
  if (!parsedMode.ok) return { ok: false, message: `--mode ${parsedMode.error}` };
  /* The run's own choice about the run_spec loop. */
  const closedLoop = onOff(out["closed-loop"]);
  if (closedLoop === "refused") return { ok: false, message: '--closed-loop takes "on" or "off"' };
  /* The run's own choice about the authenticated agent browser. */
  const agentBrowser = onOff(out["agent-browser"]);
  if (agentBrowser === "refused") return { ok: false, message: '--agent-browser takes "on" or "off"' };
  /* The run's own choice about the pre-generation context pack's live-DOM capture (an A/B arm). */
  const domPack = onOff(out["dom-pack"]);
  if (domPack === "refused") return { ok: false, message: '--dom-pack takes "on" or "off"' };
  return {
    ok: true,
    args: {
      app: out.app ?? "",
      sha: out.sha ?? "",
      baseSha: out["base-sha"] || undefined,
      mode: parsedMode.mode,
      guidance: out.guidance,
      ...(closedLoop !== undefined ? { closedLoop } : {}),
      ...(agentBrowser !== undefined ? { agentBrowser } : {}),
      ...(domPack !== undefined ? { domPack } : {}),
    },
  };
}

/** The run handed to the service. Carries --base-sha so the delegated run's diff spans the same range the standalone CLI and the webhook use. */
export function delegateRunInput(args: CliArgs): DelegateRunInput {
  return {
    app: args.app,
    sha: args.sha,
    ...(args.baseSha ? { baseSha: args.baseSha } : {}),
    target: "e2e",
    mode: args.mode,
    guidance: args.guidance,
    ...(args.closedLoop !== undefined ? { closedLoop: args.closedLoop } : {}),
    ...(args.agentBrowser !== undefined ? { agentBrowser: args.agentBrowser } : {}),
    ...groundingOf(args),
  };
}

/** The run's own grounding choices (A/B arms), present only when one was given so the app's settings decide the rest. */
export function groundingOf(args: { domPack?: boolean }): { grounding?: GroundingInput } {
  const grounding: GroundingInput = {
    ...(args.domPack !== undefined ? { domPack: args.domPack } : {}),
  };
  return Object.keys(grounding).length > 0 ? { grounding } : {};
}
