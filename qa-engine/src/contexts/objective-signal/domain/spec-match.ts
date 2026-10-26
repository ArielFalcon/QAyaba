/* Whether two spec paths name the same file when one of them is relative to a directory the other may or may not include. Pure. */

const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

/* Equal, or one ends with the other at a segment boundary. */
export function sameSpecFile(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}
