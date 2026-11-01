/*
 * Which submit tool each agent session may call right now. The engine arms a session for the one prompt whose answer is a contract's
 * submission, and the tools endpoint finds the armed contract by the session id the tool reports. A session no prompt armed, a call
 * from another role, a call of another contract's tool and a call after the answer was accepted find nothing to write. The first
 * accepted answer is the prompt's answer; a call writes nothing else and runs nothing.
 */

import type { SubmissionContract, SubmissionEnd, SubmissionError, SubmissionPort, SubmissionReport, SubmissionSlot } from "@kernel/submission.ts";
import { MAX_ERROR_PATH_CHARS, MAX_ERROR_REASON_CHARS, MAX_ERRORS_RETURNED, type SubmitRequest, type SubmitResponse } from "../domain/submission.ts";

export interface LiveSubmission {
  call(request: SubmitRequest): SubmitResponse;
}

interface Armed {
  agent: string;
  contract: SubmissionContract<unknown>;
  calls: number;
  accepted?: { value: unknown };
  lastRejection: readonly SubmissionError[];
  closed: boolean;
}

export interface SubmissionRegistryDeps {
  /* Redacts what the model typed that an error quotes; the model reads the errors, so the run's secrets never go back to it. */
  redact(text: string): string;
}

export class SubmissionRegistry implements SubmissionPort {
  private readonly armed = new Map<string, Armed>();

  constructor(private readonly deps: SubmissionRegistryDeps) {}

  arm(sessionId: string, agent: string, contract: SubmissionContract<unknown>): SubmissionSlot {
    const state: Armed = { agent, contract, calls: 0, lastRejection: [], closed: false };
    this.armed.set(sessionId, state);
    return {
      report: (end: SubmissionEnd): SubmissionReport =>
        state.accepted ? { accepted: true, value: state.accepted.value, calls: state.calls } : { accepted: false, calls: state.calls, errors: state.lastRejection, end },
      close: () => {
        state.closed = true;
        if (this.armed.get(sessionId) === state) this.armed.delete(sessionId);
      },
    };
  }

  find(sessionId: string): LiveSubmission | undefined {
    const state = this.armed.get(sessionId);
    if (state === undefined || state.closed) return undefined;
    return { call: (request) => this.serve(state, request) };
  }

  get size(): number {
    return this.armed.size;
  }

  private serve(state: Armed, request: SubmitRequest): SubmitResponse {
    if (request.agent !== state.agent) return { ok: false, code: "wrong-agent", message: "this tool is available only to the role the session was opened for" };
    if (request.tool !== state.contract.tool) return { ok: false, code: "wrong-tool", message: `this turn is answered with ${state.contract.tool}, not ${request.tool}` };
    if (state.accepted) return { ok: false, code: "already-submitted", message: `your answer was accepted by ${state.contract.tool}; stop, nothing more is read` };
    state.calls += 1;
    const checked = state.contract.check(request.answer);
    if (checked.ok) {
      state.accepted = { value: checked.value };
      return { ok: true, message: `accepted: ${state.contract.tool} is your answer; end the turn` };
    }
    const errors = checked.errors.slice(0, MAX_ERRORS_RETURNED).map((error) => ({
      path: this.deps.redact(error.path).slice(0, MAX_ERROR_PATH_CHARS),
      reason: this.deps.redact(error.reason).slice(0, MAX_ERROR_REASON_CHARS),
    }));
    state.lastRejection = errors;
    return { ok: false, code: "invalid-answer", message: `${state.contract.tool} was not accepted: fix every error and call it again with the whole answer`, errors };
  }
}
