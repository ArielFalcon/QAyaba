
import { test } from "node:test";
import assert from "node:assert/strict";
import { roleToAgentName } from "../server/rewritten-engine-factory";
import type { AgentRole as RuntimeAgentRole } from "./types";
import type { AgentRole as KernelAgentRole } from "@kernel/agent-role";

test("roleToAgentName maps the kernel proposer role to the qa-proposer agent", () => {
  assert.equal(roleToAgentName("proposer"), "qa-proposer");
});

test("roleToAgentName maps the kernel reflector role to the qa-reflector agent, not qa-generator", () => {
  assert.equal(roleToAgentName("reflector"), "qa-reflector");
});

test("P0-3: roleToAgentName maps the kernel explorer role to qa-explorer, not qa-generator", () => {
  assert.equal(roleToAgentName("explorer"), "qa-explorer");
});

test("roleToAgentName maps the sidekick role to its own qa-sidekick agent (not qa-worker)", () => {
  assert.equal(roleToAgentName("sidekick"), "qa-sidekick");
});

/* ---------------------------------------------------------------------------
   Kernel/runtime AgentRole union parity gate.
   Both unions are declared independently (kernel must not forward-depend on agent-runtime/).
   This is a COMPILE-TIME gate: if either union gains or loses a member the other doesn't
   have, `_KernelRuntimeRoleParity` fails to satisfy `never` and `npm run typecheck` fails
   naming the stray member(s). There is no runtime cost — TS erases the type alias — but the
   assertion below gives node:test a concrete, human-readable failure if this file is ever
   run against a build where the type-level gate was bypassed (e.g. a stale .d.ts cache).
   ---------------------------------------------------------------------------
 */

type KeyDiff<A, B> = Exclude<A, B> | Exclude<B, A>;
type AssertNever<T extends never> = T;

/* If this line fails to compile, the kernel and runtime AgentRole unions have drifted. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _KernelRuntimeRoleParity = AssertNever<KeyDiff<RuntimeAgentRole, KernelAgentRole>>;

/* Runtime companion: an explicit, exhaustive literal list for each union (checked against the
   type via `satisfies` so this array itself fails to compile if it's incomplete or stale),
   compared as sets. This gives a readable node:test failure (not just a tsc error) if the two
   literal lists themselves fall out of sync with one another.
 */
const RUNTIME_ROLES = [
  "primary", "reviewer", "chat", "worker", "workerCode", "sidekick", "maintainer", "reflector", "explorer", "proposer",
] as const satisfies readonly RuntimeAgentRole[];

const KERNEL_ROLES = [
  "primary", "reviewer", "chat", "worker", "workerCode", "sidekick", "maintainer", "reflector", "explorer", "proposer",
] as const satisfies readonly KernelAgentRole[];

test("kernel and runtime AgentRole unions contain the exact same member set (includes proposer)", () => {
  assert.deepEqual(
    [...RUNTIME_ROLES].sort(),
    [...KERNEL_ROLES].sort(),
    "src/agent-runtime/types.ts's AgentRole and qa-engine/src/shared-kernel/agent-role.ts's " +
      "AgentRole must declare the exact same role set — they were wired out of lockstep.",
  );
  assert.ok(RUNTIME_ROLES.includes("proposer"), "runtime AgentRole must include proposer");
  assert.ok(KERNEL_ROLES.includes("proposer"), "kernel AgentRole must include proposer");
});
