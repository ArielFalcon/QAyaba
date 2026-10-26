/*
 * Across repos, a walk that starts at the frontend call site of a contract link the stitcher found reached: the page proof
 * applies from there, the link's own description opening the evidence. A link without a call-site symbol claims nothing. Pure.
 */
import { pageFiles } from "../page-files.ts";
import { pageHitsOfWalk } from "./file-implements-page.ts";
import type { ProofInput, ReachHit, ReachProof } from "../reach-proof.ts";

export const crossRepoCallSite: ReachProof = {
  id: "cross-repo-call-site",
  prove(input: ProofInput): readonly ReachHit[] {
    const { files } = pageFiles(input.map, input.pageRoutes);
    return input.walks.filter((w) => w.prefixOf !== undefined).flatMap((w) => pageHitsOfWalk(w, files, () => "call-site"));
  },
};
