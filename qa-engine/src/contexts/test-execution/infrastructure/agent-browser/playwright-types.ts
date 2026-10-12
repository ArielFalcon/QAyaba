/*
 * The slice of Playwright the agent browser uses, written as the interfaces it needs and nothing more. The host and the
 * launcher are written against these, so a test drives them with hand-made objects and the host cannot reach a method
 * that is not listed here: there is no evaluate, no script injection, no file chooser and no download on this surface.
 * The real objects come from `playwright-core` and are handed over once, at the launcher's edge.
 */

export interface PwRequest {
  method(): string;
  url(): string;
  isNavigationRequest(): boolean;
  frame(): PwFrame;
}

export interface PwFrame {
  page(): PwPage | null;
}

export interface PwResponse {
  status(): number;
  request(): PwRequest;
  frame(): PwFrame;
}

export interface PwRoute {
  request(): PwRequest;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export interface PwWebSocketRoute {
  url(): string;
  close(options?: { code?: number; reason?: string }): Promise<void>;
  connectToServer(): unknown;
}

export interface PwLocator {
  click(options: { timeout: number }): Promise<void>;
  fill(text: string, options: { timeout: number }): Promise<void>;
  press(key: string, options: { timeout: number }): Promise<void>;
  getAttribute(name: string, options: { timeout: number }): Promise<string | null>;
  count(): Promise<number>;
}

export interface PwDialog {
  dismiss(): Promise<void>;
}

export interface PwPage {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<PwResponse | null>;
  url(): string;
  title(): Promise<string>;
  ariaSnapshot(options: { mode: "ai"; timeout: number }): Promise<string>;
  locator(selector: string): PwLocator;
  waitForLoadState(state: "domcontentloaded" | "networkidle", options: { timeout: number }): Promise<void>;
  mainFrame(): PwFrame;
  on(event: "response", handler: (response: PwResponse) => void): unknown;
  on(event: "dialog", handler: (dialog: PwDialog) => void): unknown;
  close(): Promise<void>;
}

export interface PwContextOptions {
  serviceWorkers: "block";
  acceptDownloads: false;
  viewport: { width: number; height: number };
  storageState?: { cookies: unknown[]; origins: unknown[] };
  httpCredentials?: { username: string; password: string };
  clientCertificates?: { origin: string; pfx: Buffer; passphrase?: string }[];
}

export interface PwContext {
  route(url: RegExp | string, handler: (route: PwRoute) => Promise<void> | void): Promise<void>;
  routeWebSocket(url: RegExp | string, handler: (ws: PwWebSocketRoute) => Promise<void> | void): Promise<void>;
  addInitScript(script: string): Promise<void>;
  newPage(): Promise<PwPage>;
  on(event: "page", handler: (page: PwPage) => void): unknown;
  close(): Promise<void>;
}

export interface PwBrowser {
  newContext(options: PwContextOptions): Promise<PwContext>;
  close(): Promise<void>;
  /* Fires when the browser process dies or its connection closes. */
  on?(event: "disconnected", handler: () => void): void;
}

/* A browser the orchestrator started and owns, with the way to stop it. */
export interface LaunchedBrowser {
  browser: PwBrowser;
  dispose(): Promise<void>;
}

export interface BrowserLauncherPort {
  launch(): Promise<LaunchedBrowser>;
}

/* What a context is built from: held in memory for as long as the context lives, never written anywhere. */
export interface SessionMaterial {
  storageState?: { cookies: unknown[]; origins: unknown[] };
  httpCredentials?: { username: string; password: string };
  clientCertificate?: { origin: string; pfx: Buffer; passphrase?: string };
}
