/* Applies the egress documents with iptables-restore (one atomic commit per table) and checks that the jumps from OUTPUT that bin/egress-init.sh created are still there. The only module of the egress layer that starts a process; the command runner is injected so the commands are testable without root. */

import { execFileSync } from "node:child_process";
import { EGRESS_CHAIN, buildRestoreDocuments, type RulesetInput } from "./iptables-ruleset.ts";

export type CommandRunner = (command: string, args: readonly string[], input?: string) => void;

const defaultRunner: CommandRunner = (command, args, input) => {
  execFileSync(command, [...args], { ...(input !== undefined ? { input } : {}), stdio: ["pipe", "ignore", "pipe"], timeout: 15_000 });
};

export interface IptablesApplier {
  apply(input: RulesetInput): void;
  /* The first thing wrong with the jumps from OUTPUT to the chains, or undefined when all are in place. */
  verifyJumps(uid: number): string | undefined;
}

export function createIptablesApplier(run: CommandRunner = defaultRunner): IptablesApplier {
  return {
    apply(input) {
      const { v4, v6 } = buildRestoreDocuments(input);
      run("iptables-restore", ["--noflush", "--wait"], v4);
      run("ip6tables-restore", ["--noflush", "--wait"], v6);
    },
    verifyJumps(uid) {
      const owner = ["-m", "owner", "--uid-owner", String(uid), "-j", EGRESS_CHAIN];
      const checks: Array<[string, string[]]> = [
        ["iptables", ["--wait", "-t", "filter", "-C", "OUTPUT", ...owner]],
        ["iptables", ["--wait", "-t", "nat", "-C", "OUTPUT", ...owner]],
        ["ip6tables", ["--wait", "-t", "filter", "-C", "OUTPUT", ...owner]],
      ];
      for (const [command, args] of checks) {
        try {
          run(command, args);
        } catch {
          return `${command} ${args.slice(1, 4).join(" ")}: the jump from OUTPUT to ${EGRESS_CHAIN} for uid ${uid} is missing`;
        }
      }
      return undefined;
    },
  };
}
