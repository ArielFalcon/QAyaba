import type { IntentContractExtractionView } from "../../domain/intent-contract.ts";

export interface IntentContractPort {
  extract(file: string, source: string): IntentContractExtractionView;
}
