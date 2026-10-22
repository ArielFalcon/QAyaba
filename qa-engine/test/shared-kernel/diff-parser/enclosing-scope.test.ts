/* The containers a changed template line sits in, named the way the DOM capture names a page's containers, so the two can be matched. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { enclosingScope } from "@kernel/diff-parser/enclosing-scope.ts";

const LIST_TEMPLATE = [
  `<section class="restaurant-list">`,                 // 1
  `  <div class="applied-filters">`,                   // 2
  `    <button type="button">Cambiar filtros</button>`, // 3
  `  </div>`,                                          // 4
  `  <nm-infinite-scroll`,                             // 5
  `    class="restaurant-list__grid"`,                 // 6
  `    [hasMore]="restaurantStore.hasMore()"`,         // 7
  `    endActionLabel="Cambiar filtros"`,              // 8
  `    (endAction)="goToSearchToChangeFilters()"`,     // 9
  `  >`,                                               // 10
  `  </nm-infinite-scroll>`,                           // 11
  `</section>`,                                        // 12
].join("\n");

test("an attribute line of a custom element's opening tag is in that element", () => {
  assert.deepEqual(enclosingScope(LIST_TEMPLATE, 8), ["nm-infinite-scroll"]);
});

test("a line after a closed custom element is not in it", () => {
  assert.deepEqual(enclosingScope(LIST_TEMPLATE, 3), []);
});

test("an id or a test id names a container before its tag, nearest container first", () => {
  const source = [
    `<app-shell>`,
    `  <nm-panel id="filters">`,
    `    <div data-testid="chips">`,
    `      <button>`,
    `        Cambiar filtros`,
    `      </button>`,
    `    </div>`,
    `  </nm-panel>`,
    `</app-shell>`,
  ].join("\n");
  assert.deepEqual(enclosingScope(source, 5), ['[data-testid="chips"]', "#filters", "app-shell"]);
});

test("the test id attribute is the app's own", () => {
  const source = [`<div data-cy="bar">`, `  <span>Hola</span>`, `</div>`].join("\n");
  assert.deepEqual(enclosingScope(source, 2, "data-cy"), ['[data-cy="bar"]']);
  assert.deepEqual(enclosingScope(source, 2), []);
});

test("an attribute line of a self-closing custom element is in that element", () => {
  const source = [`<section>`, `  <app-empty-state`, `    ctaLabel="Cambiar filtros"`, `  />`, `  Texto`, `</section>`].join("\n");
  assert.deepEqual(enclosingScope(source, 3), ["app-empty-state"]);
  assert.deepEqual(enclosingScope(source, 5), []);
});

test("a self-closing element and a bound id name no container", () => {
  const source = [`<div [id]="dynamicId">`, `  <nm-icon name="x" />`, `  Texto`, `</div>`].join("\n");
  assert.deepEqual(enclosingScope(source, 3), []);
});

test("a line outside the source names no container", () => {
  assert.deepEqual(enclosingScope(LIST_TEMPLATE, 0), []);
  assert.deepEqual(enclosingScope(LIST_TEMPLATE, 99), []);
});
