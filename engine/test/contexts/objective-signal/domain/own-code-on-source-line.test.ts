/* buildAddedDecision() tells a decision the build added beside the change from the change's own, by the source it is placed in. Fixtures are the sources and the decisions of a real Angular development build. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAddedDecision, decisionSourceOf } from "@contexts/objective-signal/domain/own-code-on-source-line.ts";

const COMPONENT = [
  "export class AppNavbarComponent {",
  "  readonly items = input<NavbarItem[] | null>(null)",
  "  private readonly isNative = inject(PlatformService).isNative",
  "  private readonly baseItems: NavbarItem[] = [",
  "    ...(this.isNative",
  "      ? [{ icon: 'pi-camera', label: 'Subir' }]",
  "      : []),",
  "  ]",
  "  protected readonly ready = this.items() !== null",
  "    && this.auth.hasSessionHint()",
  "}",
].join("\n");

const TEMPLATE = ["<nm-filter", '  [(value)]="filterCuisines"', "/>", "@if (isNative && introCardOpen()) {", "  <nm-intro />", "}"].join("\n");

test("a decision none of whose names is in its file is the build's: a framework's development guard placed on the line of an input", () => {
  const source = decisionSourceOf(COMPONENT);

  assert.equal(buildAddedDecision({ expression: "ngDevMode" }, 2, source), "not-in-source");
});

test("a decision whose line holds a name of it but not its operator is the build's: a two-way binding's setter placed on the binding", () => {
  const source = decisionSourceOf(TEMPLATE);

  const setter = { expression: "ɵɵtwoWayBindingSet(ctx.filterCuisines, $event) || (ctx.filterCuisines = $event)", operator: "||" };
  const guard = { expression: "ctx.isNative && ctx.introCardOpen()", operator: "&&" };

  assert.equal(buildAddedDecision(setter, 2, source), "not-in-source-line");
  assert.equal(buildAddedDecision(guard, 4, source), undefined, "the template's own @if holds its operator");
});

test("a decision placed on a line that holds none of its names stays: a map places a multi-line decision on any of its lines", () => {
  const source = decisionSourceOf(COMPONENT);

  assert.equal(buildAddedDecision({ expression: "this.isNative" }, 6, source), undefined, "the arm line of a ternary");
  assert.equal(buildAddedDecision({ expression: "this.isNative", operator: "===" }, 7, source), undefined, "even for a condition with an operator, a line that names nothing of it says nothing");
});

test("an operator that leads the next line belongs to the decision placed on the line before", () => {
  const source = decisionSourceOf(COMPONENT);

  const ready = { expression: "this.items() !== null && this.auth.hasSessionHint()", operator: "&&" };

  assert.equal(buildAddedDecision(ready, 9, source), undefined);
});

test("a decision with no name of its own, or placed beyond its source, stays", () => {
  const source = decisionSourceOf(COMPONENT);

  assert.equal(buildAddedDecision({ expression: "1 < 2", operator: "<" }, 2, source), undefined);
  assert.equal(buildAddedDecision({ expression: "this.items() ?? []", operator: "??" }, 400, source), undefined);
});
