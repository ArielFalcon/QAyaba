/* Classifies captured console and page errors of a failed case into an app-defect signal. Pure: no I/O. Shared by the run flow (adjudication, fix loop) and the lead's coordination (authoring failures). */

export interface RuntimeErrorVerdict {
  /** True only on a STRONG framework/uncaught signal — conservative by design (see module doc). */
  appDefect: boolean;
  /** Human-legible reasons, one per matched entry, threaded into the adjudicator verdict reason. */
  reasons: string[];
}

const FRAMEWORK_ERROR_RE = /\bNG\d+\b|ERROR Error:|Uncaught|Unhandled Promise rejection/;

/* Benign noise that must NEVER set appDefect, even though it can share surface words with the patterns above (e.g. a "Failed to load resource" line has no "Error:" but is excluded defensively here too, in case the format changes). Resource load failures (4xx and generic network errors, including favicon) are expected background chatter, not app breakage. */
const BENIGN_NOISE_RE = /Failed to load resource|favicon|net::ERR_/i;

/* Classifies captured console/pageerror entries into appDefect. Conservative: only a pageerror or a framework-error signature sets true; a single genuine entry among noise is enough. */
export function classifyRuntimeErrors(errors: { type: string; text: string }[]): RuntimeErrorVerdict {
  const reasons: string[] = [];
  for (const e of errors) {
    /* Any pageerror is, by definition, an uncaught JS exception — always a strong signal regardless of its text (a Playwright `pageerror` event only fires for genuinely uncaught exceptions). */
    if (e.type === "pageerror") {
      reasons.push(`uncaught page error: ${e.text}`);
      continue;
    }
    /* Console entries: exclude benign noise FIRST (defense in depth), then match the generic framework-error signature set. */
    if (BENIGN_NOISE_RE.test(e.text)) continue;
    if (FRAMEWORK_ERROR_RE.test(e.text)) {
      reasons.push(`framework runtime error: ${e.text}`);
    }
  }
  return { appDefect: reasons.length > 0, reasons };
}
