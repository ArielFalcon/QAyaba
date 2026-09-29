/* A rolling tail of a child process's output. A spawned child running untrusted code can write without limit (`yes`, a runaway logger); accumulating that into one string ends in a RangeError inside a stream listener or an out-of-memory kill, taking the orchestrator down with the child. This keeps only the most recent `keepChars` and counts what was dropped. The kept text always begins at the start of a line: the bound may cut through a secret, and its back half must not survive as a fragment that redaction, which runs on the kept text, cannot recognise. That holds across chunks too: once a trim has dropped everything up to the middle of a line, the input that continues that line is dropped up to its next line break. */

export class BoundedOutputTail {
  private readonly keepChars: number;
  private buffer = "";
  private dropped = 0;
  /** True when everything dropped so far ends inside a line, so the next input continues that dropped line. */
  private midLine = false;

  constructor(keepChars: number) {
    this.keepChars = keepChars;
  }

  append(chunk: string): void {
    let text = chunk;
    if (this.midLine) {
      const lineEnd = text.search(/[\r\n]/);
      if (lineEnd === -1) {
        this.dropped += text.length;
        return;
      }
      this.dropped += lineEnd + 1;
      text = text.slice(lineEnd + 1);
      this.midLine = false;
    }
    this.buffer += text;
    /* Trim in batches (at twice the bound) so a flood costs amortized O(chunk), not a full copy per chunk; memory stays under twice the bound plus one chunk. */
    if (this.buffer.length > this.keepChars * 2) this.trim();
  }

  /** Chars dropped so far, whether by an earlier trim or still pending in the buffer. */
  get omittedChars(): number {
    return this.dropped + this.pendingTrim();
  }

  /** The most recent whole lines within `keepChars`, led by an omission note when anything was dropped. */
  text(): string {
    this.trim();
    return this.dropped === 0 ? this.buffer : `…[${this.dropped} chars omitted]…\n${this.buffer}`;
  }

  /** How many leading chars the next trim removes: everything beyond the bound, plus the rest of the line the bound cut through. An unbroken run has no line start to keep, so all of it goes. */
  private pendingTrim(): number {
    const cut = this.buffer.length - this.keepChars;
    if (cut <= 0) return 0;
    if (this.isLineBreak(this.buffer[cut - 1])) return cut;
    const rest = this.buffer.slice(cut).search(/[\r\n]/);
    return rest === -1 ? this.buffer.length : cut + rest + 1;
  }

  private isLineBreak(char: string | undefined): boolean {
    return char === "\n" || char === "\r";
  }

  private trim(): void {
    const count = this.pendingTrim();
    this.dropped += count;
    /* Everything went and the last dropped char was not a line break: the line is still open. */
    if (count > 0 && count === this.buffer.length && !this.isLineBreak(this.buffer[count - 1])) this.midLine = true;
    this.buffer = this.buffer.slice(count);
  }
}
