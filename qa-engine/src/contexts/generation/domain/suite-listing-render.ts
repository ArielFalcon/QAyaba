/* How a listing of the suite is written into a prompt. Pure: it writes the text of the entries a listing hands out, and nothing else of them, so what an agent wrote reaches a prompt only as the sanitized, capped text the listing was built with.
   A turn with nothing editable gets the plain list of the suite: the title with its note, then every entry. A turn with specs to change gets its groups under their labels, in the order a cut from the end of the section takes them away: the editable entries (first those a signal names, all of them; then, when the turn could not say which spec to change, one line that says every spec this run delivered is editable, the entries the listing caps and the count it left out), the line that allows a new spec on a turn that covers changed lines, and the entries to leave alone, which the listing caps and whose left-out count ends the section. */
import { PROMPT_HEADINGS, SUITE_LISTING_LABELS } from "./prompt-headings.ts";
import type { SuiteListing } from "./suite-listing.ts";

/* What the title of the plain list adds to the count of specs. */
export const PLAIN_LISTING_NOTE = " — do NOT rewrite flows already covered here";

/* The line that says how many entries a cap left out of a group. */
export function leftOutLine(count: number): string {
  return `(+${count} more)`;
}

/* The line that says every spec this run delivered is editable, with the count of files under it. */
export function everyDeliveredLine(count: number): string {
  return `Every spec this run delivered is editable (${count} file(s)):`;
}

const bullets = (entries: SuiteListing["entries"]): string[] => entries.map((entry) => `- ${entry.text}`);

/* The lines of the section in two runs. The head is what a cut from the end of the section must leave standing: the title, the editable label, the entries a signal names and the line that says the others are editable. */
function partsOf(listing: SuiteListing): { head: string[]; rest: string[] } {
  if (listing.entries.length === 0) return { head: [], rest: [] };
  const title = `## ${PROMPT_HEADINGS.existingSuiteManifest} (${listing.entries.length} spec file(s)`;
  if (listing.editable.length === 0) return { head: [`${title}${PLAIN_LISTING_NOTE})`], rest: bullets(listing.entries) };
  const unnamedTotal = listing.unnamed.length + listing.unnamedLeftOut;
  return {
    head: [`${title})`, SUITE_LISTING_LABELS.editable, ...bullets(listing.named), ...(unnamedTotal > 0 ? [everyDeliveredLine(unnamedTotal)] : [])],
    rest: [
      ...bullets(listing.unnamed),
      ...(listing.unnamedLeftOut > 0 ? [leftOutLine(listing.unnamedLeftOut)] : []),
      ...(listing.mayAddSpec ? [SUITE_LISTING_LABELS.newSpec] : []),
      ...(listing.doNotRewrite.length > 0 ? [SUITE_LISTING_LABELS.doNotRewrite, ...bullets(listing.doNotRewrite)] : []),
      ...(listing.leftOut > 0 ? [leftOutLine(listing.leftOut)] : []),
    ],
  };
}

/* The section's content, or an empty text when the listing holds no spec. */
export function renderSuiteListing(listing: SuiteListing): string {
  const { head, rest } = partsOf(listing);
  return [...head, ...rest].join("\n");
}

/* The start of the section that a cut from its end must leave standing, or an empty text when the listing holds no spec. */
export function suiteListingHead(listing: SuiteListing): string {
  return partsOf(listing).head.join("\n");
}
