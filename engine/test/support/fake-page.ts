import vm from "node:vm";

/*
 * A synthetic page for the in-page readers of the login discovery child: just enough of a DOM (a
 * flat list of elements with attributes, classes, a box, a computed style, a parent and a form owner)
 * to run a reader's own source in a fresh context. It knows a small selector language (tags, classes,
 * attribute presence, equality and substring, comma lists) and nothing of any real page.
 */

export interface FakeStyle {
  visibility: string;
  display: string;
  opacity: string;
}

export interface FakeElementInit {
  tag: string;
  attrs?: Record<string, string>;
  classes?: string[];
  /** The element's box; a real one by default. */
  box?: { width: number; height: number };
  style?: Partial<FakeStyle>;
  disabled?: boolean;
  readOnly?: boolean;
  text?: string;
  parent?: FakeElement;
  /** The form the element belongs to. */
  form?: FakeElement;
}

const SIMPLE = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/;
const ATTRIBUTE = /\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g;

export class FakeElement {
  readonly tagName: string;
  readonly parent: FakeElement | null;
  readonly form: FakeElement | null;
  readonly disabled: boolean;
  readOnly: boolean;
  readonly textContent: string;
  readonly style: FakeStyle;
  private readonly attrs: Record<string, string>;
  private readonly classes: readonly string[];
  private readonly box: { width: number; height: number };

  constructor(init: FakeElementInit) {
    this.tagName = init.tag.toUpperCase();
    this.attrs = { ...init.attrs };
    this.classes = init.classes ?? [];
    this.box = init.box ?? { width: 120, height: 24 };
    this.style = { visibility: "visible", display: "block", opacity: "1", ...init.style };
    this.disabled = init.disabled === true;
    this.readOnly = init.readOnly === true;
    this.textContent = init.text ?? "";
    this.parent = init.parent ?? null;
    this.form = init.form ?? null;
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? (this.attrs[name] ?? null) : null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = String(value);
  }

  getBoundingClientRect(): { width: number; height: number } {
    return this.box;
  }

  closest(selector: string): FakeElement | null {
    for (let element: FakeElement | null = this; element !== null; element = element.parent) {
      if (element.matches(selector)) return element;
    }
    return null;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => this.matchesSimple(part.trim()));
  }

  private matchesSimple(selector: string): boolean {
    const parsed = SIMPLE.exec(selector);
    if (parsed === null) throw new Error(`the fake page does not understand the selector ${selector}`);
    const [, tag = "", classes = "", attributes = ""] = parsed;
    if (tag !== "" && tag !== this.tagName.toLowerCase()) return false;
    for (const cls of classes.split(".").filter((name) => name !== "")) if (!this.classes.includes(cls)) return false;
    for (const attribute of attributes.matchAll(ATTRIBUTE)) {
      const [, name = "", operator, expected = ""] = attribute;
      const actual = this.getAttribute(name);
      if (actual === null) return false;
      if (operator === "=" && actual !== expected) return false;
      if (operator === "*=" && !actual.includes(expected)) return false;
    }
    return true;
  }
}

export class FakeDocument {
  readonly elements: FakeElement[] = [];
  readonly forms: FakeElement[] = [];

  constructor(readonly baseURI: string) {}

  add(init: FakeElementInit): FakeElement {
    const element = new FakeElement(init);
    this.elements.push(element);
    if (element.tagName === "FORM") this.forms.push(element);
    return element;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.elements.filter((element) => element.matches(selector));
  }
}

/** Runs a reader's own source against a fake page and returns what it produced, as plain data. */
export function runReader<T>(source: string, name: string, document: FakeDocument, origin: string, ...args: unknown[]): T {
  const context = vm.createContext({ document, getComputedStyle: (element: FakeElement) => element.style, location: { origin }, URL });
  const reader = vm.runInContext(`${source}\n${name}`, context) as (...readerArgs: unknown[]) => unknown;
  return JSON.parse(JSON.stringify(reader(...args))) as T;
}
