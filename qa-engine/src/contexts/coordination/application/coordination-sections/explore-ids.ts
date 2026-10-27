/* The question id a delegation id names: `<run>-explore-<id>`. */
export const exploreDelegationId = (runId: string, questionId: string): string => `${runId}-explore-${questionId}`;
export const questionIdOf = (delegationId: string): string => delegationId.replace(/^.*-explore-/, "");
