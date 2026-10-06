/*
 * The code the discovery child runs inside the page. Each reader is a self-contained function source:
 * the browser serializes a function on its own, so a helper it needs is written into its body. The
 * sources live here as text so the child script embeds them and a test can run the very same code
 * against a synthetic page. Readers return plain data (what each input and button is, never what it
 * holds). This module is a protected path: what these readers report decides where the account is typed.
 */

import { runInNewContext } from "node:vm";

/** The most page text a reader hands over (an alert): the Node side removes the account from the whole text before it cuts any of it. */
export const PAGE_TEXT_MAX = 4_000;

/* One rule for "is this element showing", shared by every reader that needs it. */
const VISIBLE_SOURCE = String.raw`function visible(el) {
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}`;

/**
 * What makes a captcha widget a challenge the visitor has to deal with: a frame or a plain container that
 * is showing, outside the floating badge. A control (a button, an input, a link, anything with the button
 * role) that carries a site key is the trigger of an invisible captcha, not a challenge, however big it is.
 * The source is written into the page reader and compiled here, so a test runs the very same rule.
 */
export const IS_VISIBLE_CHALLENGE_SOURCE = String.raw`function isVisibleChallenge(candidate) {
  const control = ["button", "input", "a"].indexOf(candidate.tag) >= 0 || candidate.role === "button";
  return candidate.showing && !candidate.inBadge && !control;
}`;

/** A widget element as plain data: its tag (lower case), its role attribute, whether it sits inside the floating badge, and whether it is showing. */
export interface ChallengeCandidate {
  tag: string;
  role: string | null;
  inBadge: boolean;
  showing: boolean;
}

export const isVisibleChallenge = runInNewContext(`${IS_VISIBLE_CHALLENGE_SOURCE}\nisVisibleChallenge`) as (candidate: ChallengeCandidate) => boolean;

/**
 * Reads a page's structure. Takes only the name of the attribute to tag inputs and buttons with (so the
 * Node side addresses exactly the elements it was told about). Reports, per form, whether its action and
 * every submitter's own action stay on the page's origin, and whether the base address does.
 */
export const DESCRIBE_PAGE_SOURCE = [
  "function describePage(attribute) {",
  VISIBLE_SOURCE,
  IS_VISIBLE_CHALLENGE_SOURCE,
  String.raw`  const all = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };
  /* An address counts as the app's when it resolves, against the page's base, to the page's own origin. */
  const sameOrigin = function (href) {
    try { return new URL(href, document.baseURI).origin === location.origin; } catch (_bad) { return false; }
  };
  const forms = Array.prototype.slice.call(document.forms);
  const formsStayHome = forms.map(function () { return true; });
  const fields = all("input, button").map(function (el, i) {
    el.setAttribute(attribute, String(i));
    const formIndex = el.form ? forms.indexOf(el.form) : -1;
    const ownAction = el.getAttribute("formaction");
    if (formIndex >= 0 && ownAction !== null && !sameOrigin(ownAction)) formsStayHome[formIndex] = false;
    return {
      i: i,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute("type") || (el.tagName === "BUTTON" ? "submit" : "text")).toLowerCase(),
      visible: visible(el),
      disabled: el.disabled === true || el.readOnly === true,
      form: formIndex,
    };
  });
  const formsInfo = forms.map(function (form, n) {
    const action = form.getAttribute("action");
    return { sameOrigin: formsStayHome[n] && (action === null || sameOrigin(action)) };
  });
  const links = all("a[href]").slice(0, 50).map(function (a) {
    return { href: a.getAttribute("href"), text: (a.textContent || "").trim().slice(0, 60) };
  });
  /* A challenge widget by its provider's own element; the floating badge of an invisible one is not a challenge. */
  const widgets = all('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]');
  const captcha = {
    present: widgets.length > 0,
    visible: widgets.some(function (el) {
      return isVisibleChallenge({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), inBadge: el.closest(".grecaptcha-badge") !== null, showing: visible(el) });
    }),
  };
  const alerts = all('[role="alert"]').filter(visible).slice(0, 5).map(function (el) { return (el.textContent || "").trim().slice(0, ` + PAGE_TEXT_MAX + String.raw`); });
  return {
    fields: fields,
    forms: formsInfo,
    baseSameOrigin: sameOrigin(document.baseURI),
    links: links,
    captcha: captcha,
    alerts: alerts,
    secondFactorVisible: all('input[autocomplete="one-time-code"]').some(visible),
  };
}`,
].join("\n");

/** Polled in the page until it returns true: no password field is showing. */
export const NO_VISIBLE_PASSWORD_SOURCE = [
  "function noVisiblePassword() {",
  VISIBLE_SOURCE,
  String.raw`  return Array.prototype.slice.call(document.querySelectorAll('input[type="password"]')).every(function (el) { return !visible(el); });
}`,
].join("\n");

/** Run once, just before the submit: listens, in the capture phase, for the submit event of any form on the page. */
export const INSTALL_SUBMIT_WATCH_SOURCE = String.raw`function installSubmitWatch() {
  window.__qaSubmitFired = false;
  document.addEventListener("submit", function () { window.__qaSubmitFired = true; }, true);
}`;

/** Whether a form's submit event fired since the watch was installed; false when the page was replaced meanwhile. */
export const SUBMIT_WATCH_FIRED_SOURCE = String.raw`function submitWatchFired() {
  return window.__qaSubmitFired === true;
}`;
