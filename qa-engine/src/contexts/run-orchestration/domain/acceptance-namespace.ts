/* The execution namespace of a run's n-th regeneration acceptance (counted from 0): the data prefix its dumps are read under, so the sites that execute and those that read the dumps back derive it from this one function. */
export const acceptanceNamespace = (runId: string, call: number): string => `${runId}-acc${call}`;
