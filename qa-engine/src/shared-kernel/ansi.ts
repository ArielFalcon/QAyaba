/*
 * One shared stripper for the ANSI SGR escape sequences Playwright leaves in a coloured error message, so a string
 * that crosses the model boundary or a span attribute never carries terminal colouring. Applied at the boundaries where
 * untrusted tool output becomes prompt text or an attribute, never to a whole assembled prompt (a spec string literal
 * may legitimately contain ANSI).
 */

/* eslint-disable-next-line no-control-regex */
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
