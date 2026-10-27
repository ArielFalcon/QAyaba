/* How a listing of the suite is written into a prompt. Pure: it writes the text of the entries a listing hands out, and nothing else of them, so what an agent wrote reaches a prompt only as the sanitized text the listing was built with.
   A turn with nothing editable gets the plain list of the suite: the title with its note, then every entry. A turn with specs to change gets its groups under their labels: the editable entries (first those a signal names; then, when the turn could not say which spec to change, one line that says every spec this run delivered is editable and the entries of the specs it delivered), the line that allows a new spec on a turn that covers changed lines, and the entries to leave alone. Every entry is listed while the prompt fits its role's window. Over it the listing gives way in steps (`suiteListingDegrade`): the entries to leave alone become the directories they are in with a count each, then the unnamed editable entries are left to the line that says they are all editable. The entries a signal names, and the head of the section, are never given up. */
import { PROMPT_HEADINGS, SUITE_LISTING_LABELS } from "./prompt-headings.ts";
import type { SuiteListing } from "./suite-listing.ts";
import { NOT_SHOWN, countByDirectory, stepsDegrade } from "./window-fit-references.ts";
import { suiteEntryFile } from "./suite-entry.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import type { SectionDegradation } from "@kernel/prompt-sections.ts";

/* What the title of the plain list adds to the count of specs. */
export const PLAIN_LISTING_NOTE = " — do NOT rewrite flows already covered here";

/* The line that says every spec this run delivered is editable, with the count of files under it. */
export function everyDeliveredLine(count: number): string {
  return `Every spec this run delivered is editable (${count} file(s)):`;
}

const bullets = (entries: SuiteListing["entries"]): string[] => entries.map((entry) => `- ${entry.text}`);

/* How much of the listing a render gives up: nothing, the entries to leave alone, or those and the unnamed editable ones. */
type Reduction = 0 | 1 | 2;

/* The entries a reduced render names by the directory they are in. */
const directories = (entries: SuiteListing["entries"]): string[] => [...countByDirectory(entries.map((entry) => normalizeSpecPath(suiteEntryFile(entry.text)))), `(The specs themselves are ${NOT_SHOWN}; read the directories.)`];

/* The lines of the section in two runs. The head is what a reduction must leave standing: the title, the editable label, the entries a signal names and the line that says the others are editable. */
function partsOf(listing: SuiteListing, reduction: Reduction = 0): { head: string[]; rest: string[] } {
  if (listing.entries.length === 0) return { head: [], rest: [] };
  const title = `## ${PROMPT_HEADINGS.existingSuiteManifest} (${listing.entries.length} spec file(s)`;
  if (listing.editable.length === 0) return { head: [`${title}${PLAIN_LISTING_NOTE})`], rest: reduction === 0 ? bullets(listing.entries) : directories(listing.entries) };
  return {
    head: [`${title})`, SUITE_LISTING_LABELS.editable, ...bullets(listing.named), ...(listing.unnamed.length > 0 ? [everyDeliveredLine(listing.unnamed.length)] : [])],
    rest: [
      ...(reduction < 2 ? bullets(listing.unnamed) : listing.unnamed.length > 0 ? [`(Their entries are ${NOT_SHOWN}.)`] : []),
      ...(listing.mayAddSpec ? [SUITE_LISTING_LABELS.newSpec] : []),
      ...(listing.doNotRewrite.length > 0 ? [SUITE_LISTING_LABELS.doNotRewrite, ...(reduction === 0 ? bullets(listing.doNotRewrite) : directories(listing.doNotRewrite))] : []),
    ],
  };
}

/* The section's content, or an empty text when the listing holds no spec. */
export function renderSuiteListing(listing: SuiteListing): string {
  const { head, rest } = partsOf(listing);
  return [...head, ...rest].join("\n");
}

/* The start of the section that a reduction must leave standing, or an empty text when the listing holds no spec. */
export function suiteListingHead(listing: SuiteListing): string {
  return partsOf(listing).head.join("\n");
}

/* The listing over the window: its entries to leave alone as directories, then its unnamed editable entries as the line that names them all. Each step is a whole render and records how many entries it leaves out. */
export function suiteListingDegrade(listing: SuiteListing): (step: number) => SectionDegradation | undefined {
  const render = (reduction: Reduction): string => {
    const { head, rest } = partsOf(listing, reduction);
    return [...head, ...rest].join("\n");
  };
  const plain = listing.editable.length === 0;
  const aside = plain ? listing.entries.length : listing.doNotRewrite.length;
  return stepsDegrade([
    ...(aside > 0 ? [{ content: render(1), items: aside }] : []),
    ...(!plain && listing.unnamed.length > 0 ? [{ content: render(2), items: aside + listing.unnamed.length }] : []),
  ]);
}
