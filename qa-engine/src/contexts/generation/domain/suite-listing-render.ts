/* How a listing of the suite is written into a prompt. Pure: it writes the text of the entries a listing hands out, and nothing else of them, so what an agent wrote reaches a prompt only as the sanitized, capped text the listing was built with.
   A turn with nothing editable gets the plain list of the suite: the title with its note, then every entry. A turn with specs to change gets two groups under their labels: every editable entry, then the entries to leave alone, which the listing caps and whose left-out count ends the list. */
import { PROMPT_HEADINGS, SUITE_LISTING_LABELS } from "./prompt-headings.ts";
import type { SuiteListing } from "./suite-listing.ts";

/* What the title of the plain list adds to the count of specs. */
export const PLAIN_LISTING_NOTE = " — do NOT rewrite flows already covered here";

/* The line that says how many do-not-rewrite entries the cap left out. */
export function leftOutLine(count: number): string {
  return `(+${count} more)`;
}

const bullets = (entries: SuiteListing["entries"]): string[] => entries.map((entry) => `- ${entry.text}`);

/* The section's content, or an empty text when the listing holds no spec. */
export function renderSuiteListing(listing: SuiteListing): string {
  if (listing.entries.length === 0) return "";
  const title = `## ${PROMPT_HEADINGS.existingSuiteManifest} (${listing.entries.length} spec file(s)`;
  if (listing.editable.length === 0) return [`${title}${PLAIN_LISTING_NOTE})`, ...bullets(listing.entries)].join("\n");
  return [
    `${title})`,
    SUITE_LISTING_LABELS.editable,
    ...bullets(listing.editable),
    ...(listing.doNotRewrite.length > 0 ? [SUITE_LISTING_LABELS.doNotRewrite, ...bullets(listing.doNotRewrite)] : []),
    ...(listing.leftOut > 0 ? [leftOutLine(listing.leftOut)] : []),
  ].join("\n");
}
