/*
 * Starts the browser of the authenticated agent tools the way every other thing an agent can influence is started: through the
 * execution launcher, as the sandbox uid, in the run's work dir, with the egress lease of the app's origins held for as long
 * as it lives. The orchestrator then drives it over the DevTools port the browser opens on loopback, which only the
 * orchestrator can reach (the egress chain rejects every loopback port for the sandbox uid but the filter's own). The saved
 * session is never staged to this process: the cookies reach it through the protocol, from memory.
 * An optional wrapper (`timeout`) gives the browser a lifetime of its own, so that one the orchestrator forgot, because it was
 * restarted in place, ends by itself.
 */

import type { ChildProcess } from "node:child_process";
import type { ExecSandboxPort } from "../../../../shared-infrastructure/process-sandbox/exec-sandbox.ts";
import type { ProcessKillPort } from "../../../../shared-kernel/process-sandbox/process-kill.port.ts";
import type { BrowserLauncherPort, LaunchedBrowser, PwBrowser } from "./playwright-types.ts";

/* The part of playwright-core's `chromium` the launcher uses. */
export interface PlaywrightChromium {
  executablePath(): string;
  connectOverCDP(endpointURL: string): Promise<PwBrowser>;
}

export interface SandboxedChromiumLauncherDeps {
  exec: ExecSandboxPort;
  /* Loads playwright-core's chromium. Lazy, so that nothing that does not use the browser pays for the package. */
  chromium: () => Promise<PlaywrightChromium>;
  kill: ProcessKillPort;
  /* Absent: no lifetime is imposed on the browser process. */
  ttlWrapper?: { command: string; seconds: number };
  /* A signal that fires when the browser has had long enough to announce its port. Defaults to a timer. */
  startSignal?: () => AbortSignal;
}

const START_MS = 20_000;
const ANNOUNCEMENT = /DevTools listening on (ws:\/\/\S+)/;

export class SandboxedChromiumLauncher implements BrowserLauncherPort {
  constructor(private readonly deps: SandboxedChromiumLauncherDeps) {}

  async launch(): Promise<LaunchedBrowser> {
    const chromium = await this.deps.chromium();
    const dir = this.deps.exec.allocDir("browser", ["profile"]);
    const executable = chromium.executablePath();
    const args = [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--mute-audio",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}/profile`,
      "about:blank",
    ];
    const wrapper = this.deps.ttlWrapper;
    const [cmd, argv] = wrapper ? [wrapper.command, ["--signal=KILL", String(wrapper.seconds), executable, ...args]] : [executable, args];
    const child = this.deps.exec.spawn(cmd, argv, { cwd: dir, profile: "suite", stdio: ["ignore", "ignore", "pipe"] });
    let browser: PwBrowser | undefined;
    try {
      const endpoint = await this.announced(child);
      browser = await chromium.connectOverCDP(endpoint);
    } catch (err) {
      this.deps.kill.killTree(child);
      throw err;
    }
    const connected = browser;
    let disposed = false;
    return {
      browser: connected,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await connected.close().catch(() => undefined);
        this.deps.kill.killTree(child);
      },
    };
  }

  /* The DevTools address the browser prints on stderr once it listens. What else it prints is drained and dropped: it can carry page content. */
  private announced(child: ChildProcess): Promise<string> {
    const stop = this.deps.startSignal?.() ?? AbortSignal.timeout(START_MS);
    return new Promise<string>((resolve, reject) => {
      let buffer = "";
      let found = false;
      const finish = (action: () => void): void => {
        stop.removeEventListener("abort", onStop);
        child.removeListener("close", onClose);
        action();
      };
      const onStop = (): void => finish(() => reject(new Error("the browser did not start in time")));
      const onClose = (code: number | null): void => finish(() => reject(new Error(`the browser exited before it was ready (code ${code ?? "none"})`)));
      stop.addEventListener("abort", onStop, { once: true });
      child.once("close", onClose);
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (found) return;
        buffer = (buffer + chunk.toString("utf8")).slice(-4096);
        const match = ANNOUNCEMENT.exec(buffer);
        if (!match) return;
        found = true;
        buffer = "";
        finish(() => resolve(match[1]!));
      });
    });
  }
}
