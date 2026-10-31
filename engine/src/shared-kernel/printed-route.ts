/* How a page is named wherever it is printed (a prompt, a record, a pull request): its address, and the template of the map it was opened from when it was. */

const INSTANCE_OF = "instance of";

/** The text that separates a page's address from its template. */
export const INSTANCE_OF_SEPARATOR = ` (${INSTANCE_OF} `;

/** A printed page as a regular expression source: the address is group 1 and the template, when there is one, group 2. */
export const PRINTED_ROUTE_SOURCE = String.raw`(\S+?)(?: \(${INSTANCE_OF} (\S+?)\))?`;

/** The page as printed; `render` is applied to each part for a medium that marks them up. */
export function printedRoute(page: { readonly route: string; readonly template?: string | undefined }, render: (part: string) => string = (part) => part): string {
  return page.template === undefined ? render(page.route) : `${render(page.route)}${INSTANCE_OF_SEPARATOR}${render(page.template)})`;
}
