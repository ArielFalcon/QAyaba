/*
 * The Langfuse mirror of the run scores (docs/observability-design.md §11.1): an adapter for the evaluation context's ScoreSinkPort
 * over Langfuse's public HTTP API (plain `fetch`, no SDK). It exists only for people: scores are stored in `run_scores` first and
 * graders, the API and calibration read that, never Langfuse. So it is fail-open all the way: a timeout, an outage or a rejected
 * score is counted in the health and logged, and never reaches the grade. The project keys come from the environment (Doppler), sign
 * every request and appear nowhere else: not in a log line, not in the health, not in a recorded error.
 */

import { createHash } from "node:crypto";
import type { ScoreSinkPort } from "@contexts/evaluation/application/ports/index";
import { GRADER_CATALOG, MAX_SCORE_COMMENT_CHARS } from "@contexts/evaluation/domain/grader-catalog";
import type { Score } from "@contexts/evaluation/domain/score";

export interface LangfuseConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

/* Configured only when the address and both keys are set; an address that is not http(s) stops the boot, since the keys would be sent to it. */
export function resolveLangfuseConfig(env: Record<string, string | undefined>): LangfuseConfig | undefined {
  const baseUrl = env.LANGFUSE_BASE_URL?.trim();
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  if (!baseUrl || !publicKey || !secretKey) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("LANGFUSE_BASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("LANGFUSE_BASE_URL must be an http(s) URL");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), publicKey, secretKey };
}

/* Langfuse replaces a score with the same id, name and day: one id per (run, name, grader version) makes a regrade an overwrite and a new grader version an addition. */
export function langfuseScoreId(runId: string, name: string, graderVersion: string): string {
  return createHash("sha256").update(`${runId}:${name}:${graderVersion}`).digest("hex");
}

export interface ScoreConfigBody {
  name: string;
  dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
  minValue?: number;
  maxValue?: number;
  categories?: Array<{ label: string; value: number }>;
}

/* One config per graded catalog score, a family expanded to one per suffix (Langfuse matches a config by exact name). A category score with no closed set cannot have a config, so it goes without one. */
export function scoreConfigsOfCatalog(): ScoreConfigBody[] {
  const out: ScoreConfigBody[] = [];
  for (const spec of GRADER_CATALOG) {
    if (spec.state !== "graded") continue;
    const names = spec.suffixes ? spec.suffixes.map((suffix) => `${spec.name}.${suffix}`) : [spec.name];
    for (const name of names) {
      if (spec.dataType === "NUMERIC") {
        out.push({ name, dataType: "NUMERIC", ...(spec.range ? { minValue: spec.range.min, ...(spec.range.max !== undefined ? { maxValue: spec.range.max } : {}) } : {}) });
      } else if (spec.dataType === "BOOLEAN") {
        out.push({ name, dataType: "BOOLEAN" });
      } else if (spec.categories && spec.categories.length > 0) {
        out.push({ name, dataType: "CATEGORICAL", categories: spec.categories.map((label, value) => ({ label, value })) });
      }
    }
  }
  return out;
}

export interface LangfuseSinkDeps {
  config: LangfuseConfig;
  /* The OTel trace id the run was exported under; none: the score is skipped. */
  traceIdOf: (runId: string) => string | null | undefined;
  /* The outbound redaction (default in the composition: the shell's RedactionPortAdapter). */
  sanitize: (text: string) => string;
  fetch?: typeof fetch;
  now?: () => string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export interface ScoreSinkHealth {
  configured: boolean;
  lastExportAt?: string;
  lastError?: string;
}

/* What the telemetry health reports when there may be no sink at all. */
export function scoreSinkHealthOf(sink: { status(): ScoreSinkHealth } | undefined): ScoreSinkHealth {
  return sink ? sink.status() : { configured: false };
}

export interface EnsureConfigsResult {
  created: number;
  skipped: number;
  failed: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_CHARS = 300;
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

/* A transport fault (the request never got an answer): the rest of a batch is not tried against it. */
class NetworkFault extends Error {}

export class LangfuseScoreSink implements ScoreSinkPort {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly auth: string;
  private configIds = new Map<string, string>();
  private ensured = false;
  private ensuring: Promise<EnsureConfigsResult> | undefined;
  private lastExportAt: string | undefined;
  private lastError: string | undefined;

  constructor(private readonly deps: LangfuseSinkDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = deps.log ?? ((m: string) => console.error(m));
    this.auth = `Basic ${Buffer.from(`${deps.config.publicKey}:${deps.config.secretKey}`).toString("base64")}`;
  }

  status(): ScoreSinkHealth {
    return { configured: true, ...(this.lastExportAt ? { lastExportAt: this.lastExportAt } : {}), ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  async emit(runId: string, scores: readonly Score[], at: string): Promise<void> {
    try {
      const traceId = this.deps.traceIdOf(runId);
      if (!traceId) {
        this.log(`[langfuse] ${runId} has no trace id: its ${scores.length} score(s) were not mirrored`);
        return;
      }
      await this.ensureOnce();
      for (const score of scores) {
        try {
          await this.post("/api/public/scores", this.scoreBody(runId, traceId, score, at));
          this.lastExportAt = this.now();
        } catch (error) {
          this.record(error);
          if (error instanceof NetworkFault) return;
        }
      }
    } catch (error) {
      this.record(error);
    }
  }

  /* Creates the catalog's score configs that Langfuse lacks. Idempotent: an existing name is left alone, and a lost race is not an error. Never throws. */
  async ensureScoreConfigs(): Promise<EnsureConfigsResult> {
    const result: EnsureConfigsResult = { created: 0, skipped: 0, failed: 0 };
    try {
      const existing = await this.listConfigs();
      for (const body of scoreConfigsOfCatalog()) {
        if (existing.has(body.name)) {
          result.skipped += 1;
          continue;
        }
        try {
          const created = (await this.post("/api/public/score-configs", body)) as { id?: unknown } | undefined;
          if (typeof created?.id === "string") existing.set(body.name, created.id);
          result.created += 1;
        } catch (error) {
          if (error instanceof HttpFault && alreadyExists(error)) {
            result.skipped += 1;
            continue;
          }
          result.failed += 1;
          this.record(error);
          if (error instanceof NetworkFault) break;
        }
      }
      this.configIds = existing;
      this.ensured = result.failed === 0;
    } catch (error) {
      result.failed += 1;
      this.record(error);
    }
    return result;
  }

  /* The configs are ensured before the first score, and again until one attempt succeeds; Langfuse may come up after the orchestrator. */
  private async ensureOnce(): Promise<void> {
    if (this.ensured) return;
    this.ensuring ??= this.ensureScoreConfigs().finally(() => {
      this.ensuring = undefined;
    });
    await this.ensuring;
  }

  private async listConfigs(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = (await this.request("GET", `/api/public/score-configs?page=${page}&limit=${PAGE_LIMIT}`)) as { data?: Array<{ id?: unknown; name?: unknown }>; meta?: { totalPages?: unknown } } | undefined;
      for (const item of body?.data ?? []) if (typeof item.id === "string" && typeof item.name === "string") found.set(item.name, item.id);
      const totalPages = typeof body?.meta?.totalPages === "number" ? body.meta.totalPages : 1;
      if (page >= totalPages) break;
    }
    return found;
  }

  private scoreBody(runId: string, traceId: string, score: Score, at: string): Record<string, unknown> {
    const configId = this.configIds.get(score.name);
    const comment = score.comment !== undefined ? this.deps.sanitize(score.comment).slice(0, MAX_SCORE_COMMENT_CHARS) : undefined;
    return {
      id: langfuseScoreId(runId, score.name, score.graderVersion),
      traceId,
      ...(score.observationId ? { observationId: score.observationId } : {}),
      name: score.name,
      value: typeof score.value === "boolean" ? (score.value ? 1 : 0) : score.value,
      dataType: score.dataType,
      ...(comment ? { comment } : {}),
      ...(configId ? { configId } : {}),
      /* The run's end, so a regrade on another day still lands on the same score (Langfuse keys a score by id, name and date). */
      timestamp: at,
    };
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, body);
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.deps.config.baseUrl}${path}`, {
        method,
        headers: { Authorization: this.auth, "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new NetworkFault(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new HttpFault(response.status, `${method} ${path}`, text);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  /* A short, sanitized description with neither key in it, whatever the server or the transport echoed. */
  private record(error: unknown): void {
    const raw = error instanceof HttpFault ? `${error.what}: HTTP ${error.status} ${error.body.slice(0, 200)}` : error instanceof Error ? error.message : String(error);
    const { publicKey, secretKey } = this.deps.config;
    let text = raw;
    for (const secret of [secretKey, publicKey, this.auth, this.auth.slice("Basic ".length)]) if (secret) text = text.split(secret).join("[redacted]");
    text = this.deps.sanitize(text).slice(0, MAX_ERROR_CHARS);
    this.lastError = text;
    this.log(`[langfuse] ${text}`);
  }
}

class HttpFault extends Error {
  constructor(readonly status: number, readonly what: string, readonly body: string) {
    super(`${what}: HTTP ${status}`);
  }
}

function alreadyExists(error: HttpFault): boolean {
  return error.status === 409 || /already exist/i.test(error.body);
}
