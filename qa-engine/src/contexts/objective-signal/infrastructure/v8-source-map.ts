/* The source-map and script primitives the V8 coverage readers share: the shape of a dump's entry, the bounds past which a dump is not decoded, the decoding of a source map's mappings and the line starts of a script. Pure; no I/O. */

export interface RawSourceMap {
  version?: number;
  sources: string[];
  sourcesContent?: (string | null)[];
  mappings: string;
  sourceRoot?: string;
}

export interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

export interface V8Entry {
  url?: string;
  source?: string;
  functions?: Array<{ ranges?: V8Range[] }>;
  map?: RawSourceMap;
}

/* A script an app serves has some lines per kilobyte at the most, and a file of its sources some hundreds of thousands of lines: past these a dump is not decoded, which leaves the set of dumps unused. */
export const MAX_V8_SCRIPT_LINES = 1_000_000;
export const MAX_V8_COVERED_LINES_PER_FILE = 1_000_000;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* The numbers of one segment of a source map: base-64 digits of five bits each, the sixth bit saying that another digit follows and the lowest bit of the whole saying that the number is negative. A character that is no digit is skipped. */
function decodeVlq(segment: string): number[] {
  const result: number[] = [];
  let shift = 0;
  let value = 0;
  for (const ch of segment) {
    const digit = B64.indexOf(ch);
    if (digit === -1) continue;
    const hasContinuation = digit & 32;
    value += (digit & 31) << shift;
    if (hasContinuation) {
      shift += 5;
    } else {
      const negate = value & 1;
      value >>= 1;
      result.push(negate ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return result;
}

/* Where a segment of a source map starts in the generated script, and the line and column (both 0-based) of the source it comes from. */
export interface MappingSegment {
  genLine: number;
  genCol: number;
  sourceIndex: number;
  origLine: number;
  origCol: number;
}

const SEMICOLON = 59;
const COMMA = 44;

/* The segments of a source map's `mappings`, in the order of the generated script, one at a time and in one pass over the string: none is kept, and no list of lines or of segments is made, however many there are. A segment of four fields or five (the fifth is the index of a name) maps; one of fewer only moves the column. */
export function* decodeMappings(mappings: string): Generator<MappingSegment> {
  let sourceIndex = 0;
  let origLine = 0;
  let origCol = 0;
  let genLine = 0;
  let genCol = 0;
  let segmentStart = 0;
  for (let at = 0; at <= mappings.length; at++) {
    const code = at < mappings.length ? mappings.charCodeAt(at) : SEMICOLON;
    if (code !== COMMA && code !== SEMICOLON) continue;
    const fields = decodeVlq(mappings.slice(segmentStart, at));
    if (fields.length > 0) {
      genCol += fields[0]!;
      if (fields.length >= 4) {
        sourceIndex += fields[1]!;
        origLine += fields[2]!;
        origCol += fields[3]!;
        yield { genLine, genCol, sourceIndex, origLine, origCol };
      }
    }
    segmentStart = at + 1;
    if (code === SEMICOLON) {
      genLine += 1;
      genCol = 0;
    }
  }
}

/* Where each line of a script starts. The count is bounded before the list is made: a script of nothing but line breaks would otherwise make a list of its own length. */
export function lineStartOffsets(source: string): Int32Array {
  let count = 1;
  for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1)) {
    count += 1;
    if (count > MAX_V8_SCRIPT_LINES) throw new RangeError();
  }
  const starts = new Int32Array(count);
  let line = 1;
  for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1)) starts[line++] = at + 1;
  return starts;
}

/* Whether the time the decoding was given is spent. It is asked as the decoding goes, so that a dump made to be slow to decode costs that time at the most and not what its numbers say. */
export type TimeSpent = () => boolean;

