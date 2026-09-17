
function stripTrailingLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return `${line.slice(0, i)} `;
    }
  }
  return line;
}

function stripCommentsAndJoin(specSrc: string): string {
  const noBlocks = specSrc.replace(/\/\*[\s\S]*?\*\//g, " ");
  return noBlocks
    .split("\n")
    .filter((rawLine) => {
      const trimmed = rawLine.trimStart();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*"));
    })
    .map(stripTrailingLineComment)
    .join(" ");
}

export function confidentWindowEnd(specSrc: string): number {
  const joined = stripCommentsAndJoin(specSrc);
  const firstClick = joined.search(/\.(?:dblclick|click|tap)\s*\(/);
  const gotoRe = /\.goto\s*\(/g;
  let count = 0;
  let secondGoto = -1;
  for (let m: RegExpExecArray | null; (m = gotoRe.exec(joined)) !== null; ) {
    if (++count === 2) { secondGoto = m.index; break; }
  }
  const ends = [firstClick, secondGoto].filter((i) => i >= 0);
  return ends.length > 0 ? Math.min(...ends) : Infinity;
}

export function extractTestIdSelectorsWithIndex(specSrc: string): Array<{ value: string; index: number }> {
  const joined = stripCommentsAndJoin(specSrc);
  const re = /\.getByTestId\(\s*["'`]([^"'`]+)["'`]/g;
  const out: Array<{ value: string; index: number }> = [];
  for (let m: RegExpExecArray | null; (m = re.exec(joined)) !== null; ) {
    const value = m[1]!.trim();
    if (value && !value.includes("${")) out.push({ value, index: m.index });
  }
  return out;
}
