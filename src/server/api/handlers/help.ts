/* POST /help: the product assistant. */

import type { ApiContext } from "../context";
import { JsonFieldsSchema, parseJsonBody } from "../request";
import type { ApiResult } from "../respond";
import { answerHelp } from "../use-cases/ask";

export function help(ctx: ApiContext): Promise<ApiResult> {
  return answerHelp(ctx.deps, () => parseJsonBody(ctx.req, JsonFieldsSchema, { bare: true }));
}
