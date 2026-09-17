/* Durable JSON sidecar for IndexStatusPort. Store lives at join(dataDir, "index-status.json"); dataDir is supplied by the shell/factory (never process.env here). Missing file, corrupt JSON, or a non-object root all read as "no cursor" (undefined) — getLastIndexedSha never throws. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IndexStatusPort } from "@kernel/ports/index-status.port.ts";

interface IndexStatusEntry {
  lastIndexedSha: string;
  indexedAt: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): IndexStatusEntry | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.lastIndexedSha !== "string") return undefined;
  return {
    lastIndexedSha: value.lastIndexedSha,
    indexedAt: typeof value.indexedAt === "string" ? value.indexedAt : "",
  };
}

function parseStore(raw: unknown): Record<string, IndexStatusEntry> {
  if (!isPlainObject(raw)) return {};
  const store: Record<string, IndexStatusEntry> = {};
  for (const [mirrorDir, value] of Object.entries(raw)) {
    const entry = parseEntry(value);
    if (entry) store[mirrorDir] = entry;
  }
  return store;
}

export class IndexStatusAdapter implements IndexStatusPort {
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = join(dataDir, "index-status.json");
  }

  async getLastIndexedSha(mirrorDir: string): Promise<string | undefined> {
    try {
      if (!existsSync(this.filePath)) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      return parseStore(parsed)[mirrorDir]?.lastIndexedSha;
    } catch {
      return undefined;
    }
  }

  async setLastIndexedSha(mirrorDir: string, sha: string): Promise<void> {
    const store = await this.readStoreFailOpen();
    store[mirrorDir] = { lastIndexedSha: sha, indexedAt: new Date().toISOString() };
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(store)}\n`, "utf8");
  }

  private async readStoreFailOpen(): Promise<Record<string, IndexStatusEntry>> {
    try {
      if (!existsSync(this.filePath)) return {};
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      return parseStore(parsed);
    } catch {
      return {};
    }
  }
}
