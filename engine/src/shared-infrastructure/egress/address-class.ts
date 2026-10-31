/* Which kind of address an IP is, for the question the transparent proxy asks after it has resolved a declared name: may the sandbox be taken there? Only `public` goes without a further word. The others are the places a name must not lead a sandboxed child unless the app declared that very address: the machine itself, the private networks (which include the docker networks and a container's own interface), the link-local range the cloud metadata service lives in, carrier-grade NAT, multicast, the IPv6 unique-local range and the reserved blocks. Pure. */

export type AddressClass = "public" | "loopback" | "private" | "link-local" | "cgnat" | "multicast" | "unique-local" | "reserved";

interface V4Range {
  from: number;
  bits: number;
  kind: Exclude<AddressClass, "public" | "unique-local">;
}

const ip = (a: number, b: number, c: number, d: number): number => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

/* Most specific first is not needed: the ranges do not overlap. */
const V4_RANGES: readonly V4Range[] = [
  { from: ip(0, 0, 0, 0), bits: 8, kind: "loopback" }, /* "this host": a connect to 0.0.0.0 reaches the machine itself */
  { from: ip(10, 0, 0, 0), bits: 8, kind: "private" },
  { from: ip(100, 64, 0, 0), bits: 10, kind: "cgnat" },
  { from: ip(127, 0, 0, 0), bits: 8, kind: "loopback" },
  { from: ip(169, 254, 0, 0), bits: 16, kind: "link-local" },
  { from: ip(172, 16, 0, 0), bits: 12, kind: "private" },
  { from: ip(192, 0, 0, 0), bits: 24, kind: "reserved" },
  { from: ip(192, 168, 0, 0), bits: 16, kind: "private" },
  { from: ip(198, 18, 0, 0), bits: 15, kind: "reserved" },
  { from: ip(224, 0, 0, 0), bits: 4, kind: "multicast" },
  { from: ip(240, 0, 0, 0), bits: 4, kind: "reserved" }, /* includes the broadcast address */
];

function parseV4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return undefined;
  return ip(Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3]));
}

function classifyV4(value: number): AddressClass {
  for (const range of V4_RANGES) {
    const mask = range.bits === 0 ? 0 : (~0 << (32 - range.bits)) >>> 0;
    if ((value & mask) >>> 0 === range.from) return range.kind;
  }
  return "public";
}

/* The first group of an IPv6 address as a number, and whether the address is well formed enough to be classified. */
function firstGroup(address: string): number | undefined {
  if (!/^[0-9a-f:]+$/i.test(address) || !address.includes(":")) return undefined;
  const first = address.split(":")[0]!;
  return first === "" ? 0 : Number.parseInt(first, 16);
}

export function classifyAddress(address: string): AddressClass {
  const text = address.trim().toLowerCase();
  const direct = parseV4(text);
  if (direct !== undefined) return classifyV4(direct);
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) {
    const inner = parseV4(mapped[1]!);
    return inner === undefined ? "reserved" : classifyV4(inner);
  }
  if (text === "::" || text === "::1") return "loopback";
  const first = firstGroup(text);
  if (first === undefined) return "reserved";
  if ((first & 0xff00) === 0xff00) return "multicast";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xfe00) === 0xfc00) return "unique-local";
  return "public";
}
