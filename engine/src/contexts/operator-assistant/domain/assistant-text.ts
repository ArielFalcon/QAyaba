/*
 * What the assistant's texts borrow from outside the context. Both are parameters so the domain imports nothing outward: the
 * redaction every text passes through on its way to the assistant (infra-enforced, never trusted to the agent), and the plain sentence for
 * an infra-error class.
 */

export interface AssistantTextDeps {
  /* Takes secrets and personal data out of a text bound for the assistant's prompt. */
  readonly sanitize: (text: string) => string;
  /* One plain sentence for an infra-error run, by the class that closed it. */
  readonly infraErrorGloss: (errorClass: string) => string;
}
