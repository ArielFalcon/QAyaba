import { test } from "node:test";
import assert from "node:assert/strict";

import {
  captureDom,
  captureDomForRoutes,
  captureDomByRoute,
  captureRouteTrees,
  buildChangedMarker,
  type CaptureDomDeps,
} from "@contexts/generation/infrastructure/dom-snapshot.ts";

/* The config-declared testIdAttribute MUST reach the DOM capture layer. resolveTestIdAttribute(app)
   must flow to capture as well as execution — every capture function must call render() with the
   convention, or the in-page attribute walk queries the hardcoded default ("data-testid") and emits
   no hints for apps using a different convention, and the agent fabricates. ANTI-DRIFT GUARD: each
   of the four capture entry points must forward its testIdAttribute to render(). Parametrized over
   NON-DEFAULT conventions on purpose — the bug is invisible on the "data-testid" default.
 */

const NON_DEFAULT_CONVENTIONS = ["data-cy", "data-test", "data-qa"] as const;
const SPEC_WITH_ROUTE = [`test('t', async ({ page }) => { await page.goto('/owners'); });`];

function recordingDeps(): { deps: CaptureDomDeps; seen: (string | undefined)[] } {
  const seen: (string | undefined)[] = [];
  const deps: CaptureDomDeps = {
    render: async (_e2eDir, _baseUrl, _routes, testIdAttribute) => {
      seen.push(testIdAttribute);
      return [];
    },
  };
  return { deps, seen };
}

for (const convention of NON_DEFAULT_CONVENTIONS) {
  test(`captureDom forwards testIdAttribute=${convention} to render`, async () => {
    const { deps, seen } = recordingDeps();
    await captureDom(
      { e2eDir: "/e", baseUrl: "http://dev", specContents: SPEC_WITH_ROUTE, testIdAttribute: convention },
      deps,
    );
    assert.deepEqual(seen, [convention]);
  });

  test(`captureRouteTrees forwards testIdAttribute=${convention} to render`, async () => {
    const { deps, seen } = recordingDeps();
    await captureRouteTrees(
      { e2eDir: "/e", baseUrl: "http://dev", specContents: SPEC_WITH_ROUTE, testIdAttribute: convention },
      deps,
    );
    assert.deepEqual(seen, [convention]);
  });

  test(`captureDomForRoutes forwards testIdAttribute=${convention} to render`, async () => {
    const { deps, seen } = recordingDeps();
    await captureDomForRoutes(["/owners"], { e2eDir: "/e", baseUrl: "http://dev", testIdAttribute: convention }, deps);
    assert.deepEqual(seen, [convention]);
  });

  test(`captureDomByRoute forwards testIdAttribute=${convention} to render`, async () => {
    const { deps, seen } = recordingDeps();
    await captureDomByRoute(["/owners"], { e2eDir: "/e", baseUrl: "http://dev", testIdAttribute: convention }, deps);
    assert.deepEqual(seen, [convention]);
  });
}

/* Pillar 1 — the [CHANGED:] marker must name the CONFIGURED test-id attribute, not a hardcoded one.
   A marker that says "data-cy=" on a data-testid app misleads the agent about which attribute is live.
 */
test("buildChangedMarker names the configured testIdAttribute (not a hardcoded one)", () => {
  const attr = { testId: "submit" } as unknown as Parameters<typeof buildChangedMarker>[1];
  const changed = [{ testId: "submit" }] as unknown as Parameters<typeof buildChangedMarker>[2];
  assert.equal(buildChangedMarker("button: Go", attr, changed, "data-cy"), " [CHANGED: added data-cy=submit]");
  assert.equal(buildChangedMarker("button: Go", attr, changed, "data-testid"), " [CHANGED: added data-testid=submit]");
});
