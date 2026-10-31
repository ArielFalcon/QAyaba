/* A recorded data contradiction as the suites that carry one around need it: the field `category`, expected by the consumer's code and carried by no response of the by-region operation. */
import type { DataContradiction } from "@kernel/data-contradiction.ts";

export function contradictionFact(extra: Partial<DataContradiction> = {}): DataContradiction {
  return {
    route: "/browse",
    key: "category",
    operation: "GET https://app.example/api/items/by-region/ES",
    items: 12,
    provider: "provider-undeclared",
    consumer: { callSite: "src/api.ts:12", callSites: 1, declaredType: "Item[]", reads: ["src/list.ts:4"], readCount: 1 },
    alsoCarriedBy: ["GET https://app.example/api/items"],
    ...extra,
  };
}
