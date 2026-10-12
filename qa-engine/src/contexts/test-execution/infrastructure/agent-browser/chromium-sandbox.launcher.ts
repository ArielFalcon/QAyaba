/*
 * Starts the browser of the authenticated agent tools the way every other thing an agent can influence is started: through the
 * execution launcher, as the sandbox uid, in the run's work dir, with the egress lease of the app's origins held for as long
 * as it lives. The orchestrator drives it over a pipe pair the browser inherits (--remote-debugging-pipe), put behind a
 * loopback WebSocket that only the orchestrator can find (cdp-pipe-bridge.ts): a TCP debugging port could not be answered
 * under the egress filter, which rejects every loopback connection of the sandbox uid. The saved session is never staged to
 * this process: the cookies reach it through the protocol, from memory.
 * An optional wrapper (`timeout`) gives the browser a lifetime of its own, so that one the orchestrator forgot, because it was
 * restarted in place, ends by itself.
 */

import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { ExecSandboxPort } from "../../../../shared-infrastructure/process-sandbox/exec-sandbox.ts";
import type { ProcessKillPort } from "../../../../shared-kernel/process-sandbox/process-kill.port.ts";
import { startCdpPipeBridge, type CdpPipe, type CdpPipeBridge } from "./cdp-pipe-bridge.ts";
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
  /* A signal that fires when the browser has had long enough to be driven. Defaults to a timer. */
  startSignal?: () => AbortSignal;
  /* Test seam: the bridge in front of the pipe. */
  startBridge?: (pipe: CdpPipe) => Promise<CdpPipeBridge>;
}

const START_MS = 30_000;
/* The browser's fd 3 and fd 4 in the stdio array of the child: commands in, answers out. */
const COMMANDS_FD = 3;
const ANSWERS_FD = 4;

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
      "--remote-debugging-pipe",
      `--user-data-dir=${dir}/profile`,
      "about:blank",
    ];
    const wrapper = this.deps.ttlWrapper;
    const [cmd, argv] = wrapper ? [wrapper.command, ["--signal=KILL", String(wrapper.seconds), executable, ...args]] : [executable, args];
    const child = this.deps.exec.spawn(cmd, argv, { cwd: dir, profile: "suite", stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    /* Whatever the browser prints is drained and dropped: it can carry page content. */
    child.stderr?.resume();
    const toBrowser = child.stdio?.[COMMANDS_FD] as Writable | null | undefined;
    const fromBrowser = child.stdio?.[ANSWERS_FD] as Readable | null | undefined;
    if (!toBrowser || !fromBrowser) {
      this.deps.kill.killTree(child);
      throw new Error("the browser was started without its DevTools pipe");
    }

    let bridge: CdpPipeBridge | undefined;
    let browser: PwBrowser;
    try {
      bridge = await (this.deps.startBridge ?? startCdpPipeBridge)({ toBrowser, fromBrowser });
      browser = await this.connected(chromium, bridge.url, child);
    } catch (err) {
      await bridge?.close().catch(() => undefined);
      this.deps.kill.killTree(child);
      throw err;
    }
    const connected = browser;
    const open = bridge;
    let disposed = false;
    return {
      browser: connected,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await connected.close().catch(() => undefined);
        await open.close().catch(() => undefined);
        this.deps.kill.killTree(child);
      },
    };
  }

  /* The connection, unless the browser ends first or takes too long: a browser that never comes up must not hold the call. */
  private connected(chromium: PlaywrightChromium, url: string, child: ChildProcess): Promise<PwBrowser> {
    const stop = this.deps.startSignal?.() ?? AbortSignal.timeout(START_MS);
    return new Promise<PwBrowser>((resolve, reject) => {
      const onStop = (): void => finish(() => reject(new Error("the browser did not start in time")));
      const onClose = (code: number | null): void => finish(() => reject(new Error(`the browser exited before it was ready (code ${code ?? "none"})`)));
      const finish = (action: () => void): void => {
        stop.removeEventListener("abort", onStop);
        child.removeListener("close", onClose);
        action();
      };
      stop.addEventListener("abort", onStop, { once: true });
      child.once("close", onClose);
      chromium.connectOverCDP(url).then(
        (browser) => finish(() => resolve(browser)),
        (err: unknown) => finish(() => reject(err)),
      );
    });
  }
}
