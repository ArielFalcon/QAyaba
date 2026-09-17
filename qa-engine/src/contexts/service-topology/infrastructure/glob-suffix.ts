/* Filename-suffix glob compiler. Only two shapes; anything else fails closed (matches nothing). */

/** Compile a filename-suffix glob into a predicate over a bare filename (no directory segments required — callers pass the entry name from their own directory walk). */
export function compileFileGlob(glob: string): (filename: string) => boolean {
  const match = /^(?:\*\*\/)?\*(\.[^*/]+)$/.exec(glob);
  if (!match) {
    console.warn(
      `[compileFileGlob] unsupported frontFiles glob "${glob}" — only "**/*.<ext>" or "*.<ext>" ` +
        `(filename-suffix) shapes are supported. Failing closed: this predicate will match no files.`,
    );
    return (): boolean => false;
  }
  const suffix = match[1] as string;
  return (filename: string): boolean => filename.endsWith(suffix);
}
