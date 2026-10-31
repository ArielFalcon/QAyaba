/*
 * What a consumer's own code expects of the answer to a request. A call site (the code that issues a request) declares the type
 * of the answer it receives; the fields of that type that non-test code reads, and nothing in the program ever writes, are
 * fields the consumer expects the provider to serve. Several call sites can serve one operation: an expectation that holds for
 * the operation is one every call site shares, and an operation one of whose call sites could not be read has no expectation
 * (what the consumer expects of it is not known, which is not the same as nothing). A field is named, never typed or valued.
 * Pure: the extractors of a language's declared types produce the call sites; this module only joins them.
 */

/* A place in the consumer's source, `file` below the repository, 1-based `line`. */
export interface SourceSite {
  file: string;
  line: number;
}

/* A field the consumer expects and where it reads it: at most MAX_READ_SITES_LISTED sites, the rest only counted. */
export interface ExpectedField {
  name: string;
  reads: SourceSite[];
  readCount: number;
}

/* The most read sites listed for one field. */
export const MAX_READ_SITES_LISTED = 5;

/* One call site and what its declared answer type makes the consumer expect. */
export interface CallSiteExpectation {
  site: SourceSite;
  /* The enclosing function the request is issued from, when it has a name. */
  symbol?: string;
  /* The declared type of the answer as written in the source (cut to a bound), so a reader can find it. */
  declaredType: string;
  fields: ExpectedField[];
}

/* What the consumer expects of one operation: every call site that serves it, and the fields all of them expect. */
export interface OperationExpectation {
  callSites: CallSiteExpectation[];
  fields: ExpectedField[];
}

/* The expectation of the operation a request is answered by, or undefined when no call site is known to serve it or one that does could not be read. */
export type ConsumerExpectationsOf = (request: { method: string; path: string }) => OperationExpectation | undefined;

/*
 * The expectation of an operation from the call sites that serve it: the fields every call site expects, with the read sites of all
 * of them. No call site, or one that could not be read (undefined), is no expectation.
 */
export function joinExpectations(callSites: ReadonlyArray<CallSiteExpectation | undefined>): OperationExpectation | undefined {
  if (callSites.length === 0) return undefined;
  const known: CallSiteExpectation[] = [];
  for (const callSite of callSites) {
    if (callSite === undefined) return undefined;
    known.push(callSite);
  }
  const shared = known[0]!.fields.filter((field) => known.every((other) => other.fields.some((f) => f.name === field.name)));
  const fields = shared.map((field): ExpectedField => {
    const sites = new Map<string, SourceSite>();
    let readCount = 0;
    for (const other of known) {
      const held = other.fields.find((f) => f.name === field.name)!;
      readCount = Math.max(readCount, held.readCount);
      for (const site of held.reads) sites.set(`${site.file}:${site.line}`, site);
    }
    const reads = [...sites.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).slice(0, MAX_READ_SITES_LISTED);
    return { name: field.name, reads, readCount };
  });
  return { callSites: known, fields: fields.sort((a, b) => a.name.localeCompare(b.name)) };
}
