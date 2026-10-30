/*
 * A request address a producer outside the orchestrator cut (the seed's ledgers and observations, in the app's test process, which
 * holds none of the run's secrets), read by the orchestrator, which does. The cut keeps whole path segments only (`address-cut.ts`),
 * but a run secret that holds a `/` and stands raw in the path is split by it at its own slash, and the kept part before the slash
 * is no longer found by value. So the segments that begin a value the address stops short of are dropped too. An address the
 * producer did not cut holds the secret whole, and is redacted by value where it leaves.
 */

import { cutAddress, wholeSegmentsOfProducerCut } from "../../../shared-kernel/address-cut.ts";
import { partialSecretStartByValue } from "../../../shared-kernel/run-secret-redaction.ts";

export function addressOfProducerCut(address: string, bound: number): string {
  let kept = wholeSegmentsOfProducerCut(address, bound);
  if (kept === address) return kept;
  for (let start = partialSecretStartByValue(kept); start !== undefined; start = partialSecretStartByValue(kept)) {
    const shorter = cutAddress(kept, start);
    if (shorter.length >= kept.length) break;
    kept = shorter;
  }
  return kept;
}
