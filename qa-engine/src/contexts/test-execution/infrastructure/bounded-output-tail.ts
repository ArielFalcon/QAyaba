/* A rolling tail of a child process's output. A spawned child running untrusted code can write without limit (`yes`, a runaway logger); accumulating that into one string ends in a RangeError inside a stream listener or an out-of-memory kill, taking the orchestrator down with the child. This keeps only the most recent `keepChars` and counts what was dropped. */

export class BoundedOutputTail {
  private readonly keepChars: number;
  private buffer = "";
  private dropped = 0;

  constructor(keepChars: number) {
    this.keepChars = keepChars;
  }

  append(chunk: string): void {
    this.buffer += chunk;
    /* Trim in batches (at twice the bound) so a flood costs amortized O(chunk), not a full copy per chunk; memory stays under twice the bound plus one chunk. */
    if (this.buffer.length > this.keepChars * 2) this.trim();
  }

  /** Chars dropped so far, whether by an earlier trim or still pending in the buffer. */
  get omittedChars(): number {
    return this.dropped + Math.max(0, this.buffer.length - this.keepChars);
  }

  /** The most recent `keepChars` of output, led by an omission note when anything was dropped. */
  text(): string {
    if (this.buffer.length > this.keepChars) this.trim();
    return this.dropped === 0 ? this.buffer : `…[${this.dropped} chars omitted]…\n${this.buffer}`;
  }

  private trim(): void {
    this.dropped += this.buffer.length - this.keepChars;
    this.buffer = this.buffer.slice(-this.keepChars);
  }
}
