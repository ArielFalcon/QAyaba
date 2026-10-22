/* The kernel half of the egress filter, written as the documents `iptables-restore --noflush` and `ip6tables-restore --noflush` read. The sandbox uid is matched in the jumps from OUTPUT (bin/egress-init.sh creates them, with the chain already closed, before any run); everything here is the content of the QA_EGRESS chains:
     nat     redirect the uid's DNS (udp/53) to the DNS filter and each allowed upstream tcp port to the proxy listener for it;
     filter  accept only the proxy listeners and the DNS filter on loopback, then reject everything else (tcp with a reset, so a client fails at once rather than hanging), which closes every other loopback port (the API, the tools port) and every other destination;
     ip6     reject everything, loopback included: the filter works on IPv4 names and the DNS filter never returns an AAAA record.
   The chain is flushed and refilled inside one COMMIT per table, so there is never a moment in which it is empty and the uid is unfiltered. Pure: the rules are text, checked as text. */

export const EGRESS_CHAIN = "QA_EGRESS";

export interface RulesetInput {
  /* The sandbox uid. Only validated here: the owner match lives in the jump. */
  uid: number;
  dnsPort: number;
  redirects: ReadonlyArray<{ upstream: number; local: number }>;
}

function port(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`invalid ${what} port ${String(value)}: must be 1-65535`);
  return value;
}

export function buildRestoreDocuments(input: RulesetInput): { v4: string; v6: string } {
  if (!Number.isInteger(input.uid) || input.uid <= 0) throw new Error(`invalid sandbox uid ${String(input.uid)}: root cannot be the filtered uid`);
  const dns = port(input.dnsPort, "DNS filter");
  const redirects = input.redirects.map((r) => ({ upstream: port(r.upstream, "upstream"), local: port(r.local, "listener") }));
  const chain = EGRESS_CHAIN;

  const nat = [
    `-F ${chain}`,
    `-A ${chain} -p udp --dport 53 -j REDIRECT --to-ports ${dns}`,
    ...redirects.map((r) => `-A ${chain} -p tcp --dport ${r.upstream} -j REDIRECT --to-ports ${r.local}`),
  ];
  const filter = [
    `-F ${chain}`,
    ...redirects.map((r) => `-A ${chain} -p tcp -d 127.0.0.1 --dport ${r.local} -j ACCEPT`),
    `-A ${chain} -p udp -d 127.0.0.1 --dport ${dns} -j ACCEPT`,
    `-A ${chain} -p tcp -j REJECT --reject-with tcp-reset`,
    `-A ${chain} -j REJECT --reject-with icmp-port-unreachable`,
  ];
  const v4 = ["*nat", `:${chain} - [0:0]`, ...nat, "COMMIT", "*filter", `:${chain} - [0:0]`, ...filter, "COMMIT", ""].join("\n");
  const v6 = ["*filter", `:${chain} - [0:0]`, `-F ${chain}`, `-A ${chain} -j REJECT --reject-with icmp6-port-unreachable`, "COMMIT", ""].join("\n");
  return { v4, v6 };
}
