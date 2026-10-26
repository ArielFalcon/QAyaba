import type { SpecContractExtraction } from "../../domain/test-intent-contract.ts";

/* Reads the test-intent contract of one spec file: its tests and the locators and assertions each one makes. Absent from a run: the intent lock has nothing to judge and never rejects. */
export interface IntentContractPort {
  extract(file: string, source: string): SpecContractExtraction;
}
