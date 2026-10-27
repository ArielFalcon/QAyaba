/* Prompt and output bodies of an agent turn, stored in Loki as the HOW of the turn that Tempo describes structurally (design: docs/observability-design.md, "Turn bodies in Loki").

   Rules:
   - A body is never a span attribute. The spans keep sizes, hashes and section bytes; this module is the only exporter of text.
   - The run's capture mode decides: bodies leave only in `full`. `off` and `metadata` export nothing, so the default stays as private as it was.
   - A prompt is a sequence of sections, each exported with the turn that sent it; a turn's record lists section ids, hashes and sizes in order. Sections are not deduplicated across turns: on real runs a repeated section was 1-6% of the prompt bytes, which Loki's compression already absorbs. The static layers (agents/AGENTS.md, agent/*.md, skill/) never pass through the prompt text: the record carries their digest, the bytes are in the repository at that digest.
   - Every body is redacted through the run's scope and the outbound sanitizer before it is cut into chunks. A failed redaction drops the record: the raw text is never exported.
   - A record is one Loki line, at most MAX_LINE_BYTES serialized; a longer body is split into numbered chunks. A body over MAX_BODY_CHARS is cut and says so.
   - A fault here never reaches the prompt path. */

import { ROOT_CONTEXT, trace, TraceFlags, type Context } from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { sha256Hex } from "../../qa-engine/src/shared-kernel/content-hash";
import type { CaptureMode } from "@kernel/telemetry/capture-mode";
import type { TelemetryContext } from "@kernel/telemetry/telemetry.port";

/* Loki's default per-line cap is 64 KB. */
export const MAX_LINE_BYTES = 64 * 1024;
/* One body (a section, an output) is cut here: a body this large is a context dump whose value is its hash and size, which the spans hold. */
export const MAX_BODY_CHARS = 256 * 1024;
export type BodyKind = "prompt_turn" | "prompt_section" | "turn_output";

export interface TurnBodyIdentity {
  readonly turn: TelemetryContext;
  readonly sessionId: string;
  readonly agent: string;
  readonly role: string;
  readonly round?: number;
  readonly repair: boolean;
  /* Digest of the static prompt layers, or null when unknown. */
  readonly staticHash: string | null;
}

export interface PromptBodyDeps {
  readonly logger: Pick<Logger, "emit">;
  /* Redact through the active run's scope and the outbound sanitizer; undefined means: do not export. */
  readonly redact: (text: string) => string | undefined;
}

export interface PromptBodyInput {
  readonly who: TurnBodyIdentity;
  readonly mode: CaptureMode;
  readonly text: string;
  readonly sectionSizes: Readonly<Record<string, number>> | null;
  readonly sectionHashes: Readonly<Record<string, string>> | null;
  /* sha256 of a section's bytes with the run's secrets taken out by value: the assembler's own hash function. */
  readonly hashSection: (content: string) => string;
}

interface SectionPart {
  readonly id: string;
  readonly hash: string;
  readonly text: string;
}

const spanContextOf = (turn: TelemetryContext): Context =>
  trace.setSpanContext(ROOT_CONTEXT, { traceId: turn.traceId, spanId: turn.spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true });

/* The sections of an assembled prompt, from the sizes and hashes the assembler recorded: sections are joined by one newline in size-table order, and a slice is accepted only when its hash is the one the assembler computed, so a prompt that is not exactly the assembled text is never mis-cut. What does not verify (or follows the last section: the budget notice) is kept as a single remainder part. */
export function splitSections(input: Pick<PromptBodyInput, "text" | "sectionSizes" | "sectionHashes" | "hashSection">): SectionPart[] {
  const { text, sectionSizes, sectionHashes, hashSection } = input;
  const whole = (): SectionPart[] => [{ id: "prompt", hash: hashSection(text), text }];
  if (!sectionSizes || !sectionHashes) return whole();
  const bytes = Buffer.from(text, "utf8");
  const parts: SectionPart[] = [];
  let offset = 0;
  for (const [id, size] of Object.entries(sectionSizes)) {
    const expected = sectionHashes[id];
    if (expected === undefined || offset + size > bytes.length) return whole();
    const slice = bytes.subarray(offset, offset + size).toString("utf8");
    if (hashSection(slice) !== expected) return whole();
    parts.push({ id, hash: expected, text: slice });
    offset += size + 1;
  }
  if (offset < bytes.length) {
    const rest = bytes.subarray(offset).toString("utf8");
    parts.push({ id: "tail", hash: hashSection(rest), text: rest });
  }
  return parts;
}

/* Cuts `text` into pieces whose serialized record (envelope included) stays under MAX_LINE_BYTES. */
export function chunkBody(text: string, envelope: (chunk: string, index: number, count: number) => object): string[] {
  const pieces: string[] = [];
  let pos = 0;
  let size = 16 * 1024;
  while (pos < text.length || pieces.length === 0) {
    let end = Math.min(text.length, pos + size);
    for (;;) {
      if (end < text.length && end > pos + 1) {
        const last = text.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      }
      const probe = Buffer.byteLength(JSON.stringify(envelope(text.slice(pos, end), 9999, 9999)), "utf8");
      if (probe <= MAX_LINE_BYTES || end - pos <= 1) break;
      size = Math.max(1, Math.floor((end - pos) / 2));
      end = pos + size;
    }
    pieces.push(text.slice(pos, end));
    pos = end;
    if (text.length === 0) break;
  }
  return pieces;
}

export class PromptBodyExporter {
  constructor(private readonly deps: PromptBodyDeps) {}

  exportPrompt(input: PromptBodyInput): void {
    if (input.mode !== "full") return;
    try {
      const fresh: Array<{ part: SectionPart; text: string }> = [];
      const listed: Array<{ id: string; hash: string; bytes: number; dropped?: true }> = [];
      for (const part of splitSections(input)) {
        const redacted = this.deps.redact(part.text.length > MAX_BODY_CHARS ? part.text.slice(0, MAX_BODY_CHARS) : part.text);
        const bytes = Buffer.byteLength(part.text, "utf8");
        /* A body that could not be redacted is not exported; the turn record says so. */
        if (redacted === undefined) {
          listed.push({ id: part.id, hash: part.hash, bytes, dropped: true });
          continue;
        }
        fresh.push({ part, text: redacted });
        listed.push({ id: part.id, hash: part.hash, bytes });
      }
      const context = spanContextOf(input.who.turn);
      this.emit(context, "prompt_turn", {
        kind: "prompt_turn",
        session: input.who.sessionId,
        agent: input.who.agent,
        role: input.who.role,
        ...(input.who.round !== undefined ? { round: input.who.round } : {}),
        repair: input.who.repair,
        static_hash: input.who.staticHash,
        sections: listed,
      });
      for (const { part, text } of fresh) {
        const truncated = part.text.length > MAX_BODY_CHARS;
        const chunks = chunkBody(text, (chunk, index, count) => this.sectionRecord(part, chunk, index, count, truncated));
        chunks.forEach((chunk, index) => this.emit(context, "prompt_section", this.sectionRecord(part, chunk, index, chunks.length, truncated)));
      }
    } catch {
      /* Observability never breaks the prompt. */
    }
  }

  exportOutput(input: { who: TurnBodyIdentity; mode: CaptureMode; text: string }): void {
    if (input.mode !== "full" || input.text.length === 0) return;
    try {
      const truncated = input.text.length > MAX_BODY_CHARS;
      const redacted = this.deps.redact(truncated ? input.text.slice(0, MAX_BODY_CHARS) : input.text);
      if (redacted === undefined) return;
      const record = (chunk: string, index: number, count: number): object => ({ kind: "turn_output", session: input.who.sessionId, hash: sha256Hex(redacted), chunk: index, chunks: count, ...(truncated ? { truncated: true } : {}), text: chunk });
      const chunks = chunkBody(redacted, record);
      const context = spanContextOf(input.who.turn);
      chunks.forEach((chunk, index) => this.emit(context, "turn_output", record(chunk, index, chunks.length)));
    } catch {
      /* Observability never breaks the prompt. */
    }
  }

  private sectionRecord(part: SectionPart, text: string, index: number, count: number, truncated: boolean): object {
    return { kind: "prompt_section", id: part.id, hash: part.hash, chunk: index, chunks: count, ...(truncated ? { truncated: true } : {}), text };
  }

  private emit(context: Context, kind: BodyKind, body: object): void {
    this.deps.logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: JSON.stringify(body),
      attributes: { "qayaba.body.kind": kind },
      timestamp: new Date(),
      context,
    });
  }
}
