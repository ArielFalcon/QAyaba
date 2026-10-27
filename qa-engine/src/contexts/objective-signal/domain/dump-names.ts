/* Which spec file wrote a coverage dump, told by the dump's name. Pure; no I/O.
   The seed's coverage fixture names a dump `${titlePath.join("-")}` with every run of other characters made one dash, cut at sixty characters; a test's title path starts with its spec file's path. */

/* How many characters of the title path a dump's name keeps. */
const DUMP_TITLE_CHARS = 60;

const dashed = (text: string): string => text.replace(/[^a-z0-9]+/gi, "-");

/* Whether `dump` was written by a test of `specFile`: its name starts with the file's dashed path, followed by the next part of the title, or the path fills the whole kept title. */
export function isDumpOfSpecFile(dump: string, specFile: string): boolean {
  const key = dashed(specFile);
  return dump.startsWith(key.slice(0, DUMP_TITLE_CHARS)) && (key.length >= DUMP_TITLE_CHARS || dump.charAt(key.length) === "-");
}

const FIXTURE_DUMP = /^(.+)-\d+-\d+\.json$/;

/* The test that wrote `dump`, named as the coverage fixture names it (`<title path dashed and cut>-<worker>-<repeat>.json`): its dashed, cut title path; undefined for a name the fixture does not write. */
export function testOfDump(dump: string): string | undefined {
  return FIXTURE_DUMP.exec(dump)?.[1];
}
