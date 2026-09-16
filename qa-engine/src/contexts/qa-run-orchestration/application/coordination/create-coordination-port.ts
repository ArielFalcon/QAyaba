import type { CoordinationPort } from "../ports/coordination.port.ts";
import type { CoordinationMode } from "./coordination-mode.ts";
import { OffCoordinationAdapter } from "./off-coordination.adapter.ts";
import { ProposingCoordinationAdapter } from "./proposing-coordination.adapter.ts";

export function createCoordinationPort(mode: CoordinationMode = "off"): CoordinationPort {
  if (mode === "off") return new OffCoordinationAdapter();
  // shadow + active share the deterministic proposer; RunQaUseCase treats shadow as advisory-only
  // and only honors active at explicitly enabled points (Fase 13).
  return new ProposingCoordinationAdapter(mode);
}
