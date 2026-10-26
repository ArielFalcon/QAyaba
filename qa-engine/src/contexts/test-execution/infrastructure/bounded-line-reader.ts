/* Splits a child process's output into lines while it streams, holding at most one line under `maxLineChars` at a time. A child running untrusted code can write without a line break; buffering "the current line" then grows without bound, so a line that passes the bound is skipped whole (its remainder too, up to its line break) and never reaches the consumer. */

export class BoundedLineReader {
  private partialLine = "";
  private skippingLongLine = false;

  constructor(
    private readonly maxLineChars: number,
    private readonly onLine: (line: string) => void,
  ) {}

  feed(chunk: string): void {
    const lines = (this.partialLine + chunk).split("\n");
    this.partialLine = lines.pop() ?? "";
    for (const line of lines) {
      if (!this.skippingLongLine && line.length <= this.maxLineChars) this.onLine(line);
      this.skippingLongLine = false;
    }
    if (this.partialLine.length > this.maxLineChars) {
      this.partialLine = "";
      this.skippingLongLine = true;
    }
  }

  /** The stream closed: the last line, which had no line break after it, is complete. */
  end(): void {
    this.feed("\n");
  }
}
