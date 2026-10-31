/* Shapes the code-graph engine's answer for the lead: redacts it string by string and cuts it by its structure, so it stays within the budget and stays readable. */

/* A line the engine's text opens a section with, outside every code block: a file's heading (**`path`** — ...) or one of the answer's own headings. */
const SECTION = /^\*\*/;
const FILE_HEADING = /^\*\*`/;
const FENCE = /^```/;

/* How big a text is for the budget: characters by default, bytes for a caller whose budget is in bytes. */
export type Size = (text: string) => number;

interface Omitted {
  /* Files not shown at all. */
  files: number;
  /* The last file shown is cut inside its code block. */
  partial: boolean;
  /* The closing sections (the engine's list of names not shown) are left out. */
  closing: boolean;
}

function omissionMarker(o: Omitted): string {
  const what = [
    ...(o.partial ? ["the rest of the last file shown"] : []),
    ...(o.files > 0 ? [`${o.files} more file${o.files === 1 ? "" : "s"}`] : []),
    ...(o.closing ? ["the closing notes"] : []),
  ];
  return what.length > 0 ? `[omitted: ${what.join(", ")} that did not fit; explore narrower terms to see more]` : "[omitted: the answer did not fit; explore narrower terms]";
}

/* The generic marker cut to `max` by the same measure as the budget. */
function fitMarker(max: number, size: Size): string {
  let marker = omissionMarker({ files: 0, partial: false, closing: false });
  while (marker.length > 0 && size(marker) > max) marker = marker.slice(0, -1);
  return marker;
}

/* The leading lines of one file section that fit in `room` characters, ending inside its code block at a line boundary with the block closed; undefined when not even one line of code fits. */
function cutFile(body: string, room: number, size: Size): string | undefined {
  const lines = body.split("\n");
  let out = "";
  let open: boolean = false;
  let code = 0;
  for (const line of lines) {
    const next = out === "" ? line : `${out}\n${line}`;
    const opens: boolean = FENCE.test(line) ? !open : open;
    if (size(next) + (opens ? size("\n```") : 0) > room) break;
    out = next;
    open = opens;
    if (open && !FENCE.test(line)) code += 1;
  }
  if (code === 0) return undefined;
  return open ? `${out}\n\`\`\`` : out;
}

/*
 * The engine's text as the lead is shown it: redacted as text first (a secret can sit anywhere in it, and the run's redaction
 * knows its values and patterns), then at most `max` characters. The opening (before the first file) is kept whole, then as many
 * whole files as fit, each from its heading to the next; the first file that does not fit is cut at a line boundary inside its
 * code block (the block is closed), so one large file never leaves the lead without source. The closing sections (the list of
 * names not shown) are kept when they fit after the source. What is left out is said in a closing marker that counts only what
 * is not shown. An opening that does not fit leaves only the marker.
 */
export function shapeExploreAnswer(text: string, max: number, redact?: (text: string) => string, size: Size = (t) => t.length): { result: string; truncated: boolean } {
  const clean = (redact ? redact(text) : text).trim();
  if (size(clean) <= max) return { result: clean, truncated: false };
  const sections: Array<{ file: boolean; body: string }> = [];
  let inBlock = false;
  for (const line of clean.split("\n")) {
    if (!inBlock && SECTION.test(line)) sections.push({ file: FILE_HEADING.test(line), body: line });
    else if (sections.length === 0) sections.push({ file: false, body: line });
    else sections[sections.length - 1]!.body += `\n${line}`;
    if (FENCE.test(line)) inBlock = !inBlock;
  }
  const firstFile = sections.findIndex((s) => s.file);
  const lastFile = sections.map((s) => s.file).lastIndexOf(true);
  /* The opening: every section before the first file. The closing: every section after the last. Without a file, the whole text is an opening. */
  const opening = sections.slice(0, firstFile === -1 ? sections.length : firstFile);
  const files = firstFile === -1 ? [] : sections.slice(firstFile, lastFile + 1);
  const closing = (firstFile === -1 ? [] : sections.slice(lastFile + 1)).map((s) => s.body.trim()).join("\n\n");
  let kept = opening.map((s) => s.body).join("\n").trim();
  const marker = (o: Omitted) => `\n\n${omissionMarker(o)}`;
  if (size(kept) + size(marker({ files: files.length, partial: false, closing: closing !== "" })) > max) return { result: fitMarker(max, size), truncated: true };
  let taken = 0;
  let partial = false;
  for (const file of files) {
    const body = file.body.trim();
    const rest = files.length - taken - 1;
    const whole = `${kept}\n\n${body}`;
    if (size(whole) + size(marker({ files: rest, partial: false, closing: closing !== "" })) <= max) {
      kept = whole;
      taken += 1;
      continue;
    }
    const room = max - size(kept) - 2 - size(marker({ files: rest, partial: true, closing: closing !== "" }));
    /* The closing list is worth a few lines of the cut file, but never the file's first line of code. */
    const cut = cutFile(body, room - (closing === "" ? 0 : size(closing) + 2), size) ?? cutFile(body, room, size);
    if (cut !== undefined) {
      kept = `${kept}\n\n${cut}`;
      taken += 1;
      partial = true;
    }
    break;
  }
  const left = files.length - taken;
  const withClosing = closing === "" ? undefined : `${kept}\n\n${closing}`;
  const closingFits = withClosing !== undefined && size(withClosing) + (left > 0 || partial ? size(marker({ files: left, partial, closing: false })) : 0) <= max;
  if (closingFits) kept = withClosing;
  const omitted: Omitted = { files: left, partial, closing: closing !== "" && !closingFits };
  if (omitted.files === 0 && !omitted.partial && !omitted.closing) return { result: kept, truncated: false };
  return { result: `${kept}${marker(omitted)}`, truncated: true };
}
