import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DESCRIBE_PAGE_SOURCE,
  NO_VISIBLE_PASSWORD_SOURCE,
  PAGE_TEXT_MAX,
} from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.page-readers.ts";
import { FakeDocument, runReader, type FakeElement, type FakeElementInit, type FakeStyle } from "../../../../support/fake-page.ts";

const ORIGIN = "https://app.stub.test";
const ATTRIBUTE = "data-tagged";

interface Described {
  fields: Array<{ i: number; tag: string; type: string; visible: boolean; disabled: boolean; form: number }>;
  forms: Array<{ sameOrigin: boolean }>;
  baseSameOrigin: boolean;
  alerts: string[];
  secondFactorVisible: boolean;
}

const describe = (page: FakeDocument): Described => runReader<Described>(DESCRIBE_PAGE_SOURCE, "describePage", page, ORIGIN, ATTRIBUTE);
const noVisiblePassword = (page: FakeDocument): boolean => runReader<boolean>(NO_VISIBLE_PASSWORD_SOURCE, "noVisiblePassword", page, ORIGIN);

const pageAt = (baseURI = `${ORIGIN}/login`): FakeDocument => new FakeDocument(baseURI);
const input = (page: FakeDocument, type: string, over: Partial<FakeElementInit> = {}): FakeElement => page.add({ tag: "input", attrs: { type }, ...over });

/* Each way an element can fail to show, one row per way. */
const HIDDEN: ReadonlyArray<[string, Partial<FakeElementInit>]> = [
  ["a zero width", { box: { width: 0, height: 20 } }],
  ["a zero height", { box: { width: 100, height: 0 } }],
  ["visibility hidden", { style: { visibility: "hidden" } satisfies Partial<FakeStyle> }],
  ["display none", { style: { display: "none" } satisfies Partial<FakeStyle> }],
  ["zero opacity", { style: { opacity: "0" } satisfies Partial<FakeStyle> }],
];

test("every input and button is described by what it is and tagged with its index", () => {
  const page = pageAt();
  const form = page.add({ tag: "form" });
  input(page, "email", { form });
  input(page, "password", { form });
  page.add({ tag: "button", form });
  input(page, "text");
  const seen = describe(page);
  assert.deepEqual(seen.fields.map((field) => [field.i, field.tag, field.type, field.form]), [[0, "input", "email", 0], [1, "input", "password", 0], [2, "button", "submit", 0], [3, "input", "text", -1]]);
  assert.deepEqual(page.elements.filter((element) => element.getAttribute(ATTRIBUTE) !== null).map((element) => element.getAttribute(ATTRIBUTE)), ["0", "1", "2", "3"]);
});

for (const [label, over] of HIDDEN) {
  test(`an element with ${label} is not visible, to the page reader and to the password poll alike`, () => {
    const page = pageAt();
    input(page, "password", over);
    assert.equal(describe(page).fields[0]?.visible, false);
    assert.equal(noVisiblePassword(page), true);
  });
}

test("a showing password field is visible to the page reader and stops the password poll", () => {
  const page = pageAt();
  input(page, "password");
  assert.equal(describe(page).fields[0]?.visible, true);
  assert.equal(noVisiblePassword(page), false);
});

test("a field the user cannot type in is reported as disabled, whether it is disabled or read-only", () => {
  const page = pageAt();
  input(page, "text", { disabled: true });
  input(page, "text", { readOnly: true });
  input(page, "text");
  assert.deepEqual(describe(page).fields.map((field) => field.disabled), [true, true, false]);
});

test("a form whose action, or whose submitter's own action, leaves the page's origin does not stay home", () => {
  const page = pageAt();
  const relative = page.add({ tag: "form", attrs: { action: "/session" } });
  const absolute = page.add({ tag: "form", attrs: { action: `${ORIGIN}/session` } });
  const none = page.add({ tag: "form" });
  const other = page.add({ tag: "form", attrs: { action: "https://idp.stub.test/session" } });
  const protocolRelative = page.add({ tag: "form", attrs: { action: "//idp.stub.test/session" } });
  const submitterElsewhere = page.add({ tag: "form", attrs: { action: "/session" } });
  page.add({ tag: "button", attrs: { formaction: "https://idp.stub.test/collect" }, form: submitterElsewhere });
  const submitterHome = page.add({ tag: "form", attrs: { action: "/session" } });
  page.add({ tag: "button", attrs: { formaction: "/other" }, form: submitterHome });
  const seen = describe(page);
  const stays = (form: FakeElement): boolean | undefined => seen.forms[page.forms.indexOf(form)]?.sameOrigin;
  assert.deepEqual([relative, absolute, none, submitterHome].map(stays), [true, true, true, true]);
  assert.deepEqual([other, protocolRelative, submitterElsewhere].map(stays), [false, false, false]);
});

test("a formaction on a button of one form does not taint another form", () => {
  const page = pageAt();
  const first = page.add({ tag: "form", attrs: { action: "/session" } });
  const second = page.add({ tag: "form", attrs: { action: "/session" } });
  page.add({ tag: "button", attrs: { formaction: "https://idp.stub.test/collect" }, form: second });
  const seen = describe(page);
  assert.deepEqual([seen.forms[page.forms.indexOf(first)]?.sameOrigin, seen.forms[page.forms.indexOf(second)]?.sameOrigin], [true, false]);
});

test("a base address on another origin is reported, and it takes a relative action with it", () => {
  const page = pageAt("https://cdn.stub.test/");
  const form = page.add({ tag: "form", attrs: { action: "/session" } });
  const seen = describe(page);
  assert.equal(seen.baseSameOrigin, false);
  assert.equal(seen.forms[page.forms.indexOf(form)]?.sameOrigin, false);
  assert.equal(describe(pageAt()).baseSameOrigin, true);
});

test("an alert is handed over whole up to the page text bound, and only alerts that are showing", () => {
  const page = pageAt();
  page.add({ tag: "div", attrs: { role: "alert" }, text: "x".repeat(PAGE_TEXT_MAX + 50) });
  page.add({ tag: "div", attrs: { role: "alert" }, text: "hidden alert", style: { display: "none" } });
  page.add({ tag: "div", attrs: { role: "alert" }, text: `  padded  ` });
  const seen = describe(page);
  assert.deepEqual(seen.alerts.map((text) => text.length), [PAGE_TEXT_MAX, "padded".length]);
});

test("at most five alerts are read", () => {
  const page = pageAt();
  for (let n = 0; n < 8; n++) page.add({ tag: "div", attrs: { role: "alert" }, text: `alert ${n}` });
  assert.equal(describe(page).alerts.length, 5);
});

test("a second-factor input is reported only while it is showing", () => {
  const showing = pageAt();
  input(showing, "text", { attrs: { type: "text", autocomplete: "one-time-code" } });
  assert.equal(describe(showing).secondFactorVisible, true);
  const hidden = pageAt();
  input(hidden, "text", { attrs: { type: "text", autocomplete: "one-time-code" }, style: { display: "none" } });
  assert.equal(describe(hidden).secondFactorVisible, false);
});

/* A captcha widget as the page reader sees it: present when a provider's own element is there, visible only when a real challenge is showing. */
const captchaOf = (page: FakeDocument): { present: boolean; visible: boolean } => (describe(page) as unknown as { captcha: { present: boolean; visible: boolean } }).captcha;

test("an invisible captcha's trigger button is a widget that is present but not a visible challenge", () => {
  const page = pageAt();
  page.add({ tag: "button", classes: ["g-recaptcha"], attrs: { "data-sitekey": "site-key", "data-callback": "onSubmit" } });
  assert.deepEqual(captchaOf(page), { present: true, visible: false });
});

test("a container with the button role that carries a site key is a trigger, not a visible challenge", () => {
  const page = pageAt();
  page.add({ tag: "div", attrs: { role: "button", "data-sitekey": "site-key" }, box: { width: 200, height: 40 } });
  assert.deepEqual(captchaOf(page), { present: true, visible: false });
});

test("a challenge that is an iframe from a captcha provider, or a container with a real box, is visible", () => {
  const iframe = pageAt();
  iframe.add({ tag: "iframe", attrs: { src: "https://www.google.com/recaptcha/api2/bframe" }, box: { width: 400, height: 580 } });
  assert.deepEqual(captchaOf(iframe), { present: true, visible: true });
  const container = pageAt();
  container.add({ tag: "div", classes: ["cf-turnstile"], attrs: { "data-sitekey": "site-key" }, box: { width: 300, height: 65 } });
  assert.deepEqual(captchaOf(container), { present: true, visible: true });
});

test("a widget with no box, or hidden, is present but not a visible challenge", () => {
  for (const over of [{ box: { width: 0, height: 0 } }, { style: { display: "none" } }] as const) {
    const page = pageAt();
    page.add({ tag: "div", classes: ["h-captcha"], attrs: { "data-sitekey": "site-key" }, ...over });
    assert.deepEqual(captchaOf(page), { present: true, visible: false });
  }
});

test("the floating badge of an invisible captcha is not a visible challenge, nor is anything inside it", () => {
  const page = pageAt();
  const badge = page.add({ tag: "div", classes: ["grecaptcha-badge"] });
  page.add({ tag: "iframe", attrs: { src: "https://www.google.com/recaptcha/api2/anchor" }, parent: badge });
  assert.deepEqual(captchaOf(page), { present: true, visible: false });
});

test("a page with no captcha element reports none", () => {
  const page = pageAt();
  page.add({ tag: "div" });
  assert.deepEqual(captchaOf(page), { present: false, visible: false });
});
