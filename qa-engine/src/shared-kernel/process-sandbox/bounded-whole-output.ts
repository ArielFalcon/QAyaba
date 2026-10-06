/* All of one output stream of a child process, up to a bound. A caller that parses the output (a JSON document, a diff) needs it whole or not at all: past the bound nothing more is kept and `exceeded` is set, so the caller can kill the child and fail loudly instead of parsing a truncated document. */

export class BoundedWholeOutput {
  private value = "";
  private over = false;

  constructor(private readonly maxChars: number) {}

  get exceeded(): boolean {
    return this.over;
  }

  append(chunk: string): void {
    if (this.over) return;
    if (this.value.length + chunk.length > this.maxChars) {
      this.over = true;
      return;
    }
    this.value += chunk;
  }

  text(): string {
    return this.value;
  }
}
