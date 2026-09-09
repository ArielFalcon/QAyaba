// Mock dataset for the Qayaba Console — used when config.mode === 'mock'
// (standalone dev, no server). api.js reads window.QayabaMockData; the live
// adapter ignores this file. The shape here is the dashboard's internal view
// model — see API.md for how each field maps to the /api/v1/* server contract.
window.QayabaMockData = (function () {
  const models = { generator: 'deepseek-v4-pro', reviewer: 'minimax-m3' };

  const apps = [
    {
      name: 'portfolio', repo: 'ArielFalcon/portfolio', stack: 'Astro · Vercel',
      shadow: true, watching: true, health: 'healthy', baseBranch: 'main',
      devUrl: 'dev.portfolio.internal', gate: 'signal', oracle: 'off',
      lastVerdict: 'skipped', passRate: 0.91, specs: 6,
      trend: [0.88, 0.9, 0.89, 0.92, 0.9, 0.93, 0.91],
      target: 'e2e', status: 'shadow', value: null, coverage: null,
      coverageMode: 'signal', coverageMin: 0.7, reviewerPass: 0.94,
      valueSeries: null, coverageSeries: null,
      vmix: [{ v: 'pass', n: 14 }, { v: 'skipped', n: 22 }, { v: 'flaky', n: 1 }],
      errClasses: [['timing-flake', 3], ['selector-fragile', 2], ['assertion-trivial', 1]],
    },
    {
      name: 'checkout-api', repo: 'acme/checkout-api', stack: 'Spring · K8s',
      shadow: false, watching: true, health: 'degraded', baseBranch: 'main',
      devUrl: 'dev.checkout-api.internal', gate: 'enforce', oracle: 'code',
      lastVerdict: 'fail', passRate: 0.78, specs: 14,
      trend: [0.82, 0.8, 0.79, 0.77, 0.81, 0.76, 0.78],
      target: 'code', status: 'code-mode', value: null, coverage: null,
      coverageMode: 'off', coverageMin: 0.7, reviewerPass: 0.88,
      valueSeries: null, coverageSeries: null,
      vmix: [{ v: 'pass', n: 9 }, { v: 'fail', n: 5 }, { v: 'infra-error', n: 2 }],
      errClasses: [['assertion-trivial', 5], ['env-drift', 3], ['auth-flow', 2]],
    },
    {
      name: 'web-app', repo: 'acme/web-app', stack: 'Angular · Vercel',
      shadow: false, watching: true, health: 'healthy', baseBranch: 'main',
      devUrl: 'dev.web-app.internal', gate: 'enforce', oracle: 'e2e',
      lastVerdict: 'pass', passRate: 0.89, specs: 21,
      trend: [0.84, 0.85, 0.86, 0.85, 0.88, 0.87, 0.89],
      target: 'e2e', status: 'live', value: 0.82, coverage: 0.92,
      coverageMode: 'enforce', coverageMin: 0.7, reviewerPass: 0.91,
      valueSeries: [0.69, 0.72, 0.74, 0.70, 0.76, 0.79, 0.82],
      coverageSeries: [0.84, 0.86, 0.80, 0.88, 0.90, 0.90, 0.92],
      vmix: [{ v: 'pass', n: 73 }, { v: 'fail', n: 6 }, { v: 'flaky', n: 3 }, { v: 'skipped', n: 4 }],
      errClasses: [['timing-flake', 6], ['selector-fragile', 4], ['coverage-miss', 3], ['auth-flow', 2]],
    },
  ];

  // The run that is executing right now — the heartbeat of mission control.
  const running = {
    id: 'r-1842', app: 'web-app', sha: 'aa17c93', mode: 'diff', branch: 'DEV',
    message: 'feat(search): debounce query input', author: 'maria',
    stage: 'execute', startedAt: 92, specsTotal: 3, specsDone: 2,
    stageNote: 'executing 3 specs against dev.web-app.internal',
    stages: [['classify', 'done'], ['generate', 'done'], ['validate', 'done'], ['execute', 'active'], ['decide', 'pending']],
    changed: ['src/app/search/search.component.ts', 'src/app/search/query.service.ts'],
    // The agent's action plan for this run.
    plan: [
      { t: 'Classify commit · feat → targeted generation', s: 'done' },
      { t: 'Map blast radius · search.component.ts → /search', s: 'done' },
      { t: 'Recall rules · R-198, R-204 injected into prompt', s: 'done' },
      { t: 'Generate 3 specs · reviewer (minimax-m3) approved', s: 'done' },
      { t: 'Static gate · tsc · lint · manifest', s: 'done' },
      { t: 'Execute suite against DEV', s: 'active' },
      { t: 'Oracle · mutation / fault-injection', s: 'pending' },
      { t: 'Decide · PR with auto-merge, or Issue', s: 'pending' },
    ],
    // The spec the agent is working on right now.
    currentTest: {
      file: 'e2e/search/debounce.spec.ts', phase: 'executing', specIndex: 3,
      code: [
        "import { test, expect } from '@playwright/test';",
        "",
        "test('debounces input by 300ms', async ({ page }) => {",
        "  await page.goto('/search');",
        "  await page.fill('[data-test=q]', 'pan');",
        "  await page.waitForTimeout(150);",
        "  await expect(page).not.toHaveURL(/q=pan/);",
        "  await page.waitForTimeout(200);",
        "  await expect(page).toHaveURL(/q=pan/);",
        "});",
      ],
      cases: [
        { name: 'debounces input by 300ms before querying', s: 'pass', ms: 412 },
        { name: 'cancels in-flight request on new keystroke', s: 'pass', ms: 338 },
        { name: 'shows spinner while a query is pending', s: 'running' },
        { name: 'renders empty-state for zero results', s: 'pending' },
      ],
    },
    // Log already emitted.
    liveLog: [
      ['$', 'qayaba qa --app web-app --sha aa17c93'],
      ['›', 'classify · feat → generate targeted'],
      ['›', 'blast radius · search.component.ts → /search route'],
      ['›', 'recall · injected R-198, R-204 into prompt'],
      ['›', 'generate · wrote 3 specs · reviewer approved'],
      ['›', 'static gate · tsc ok · lint ok · manifest ok'],
      ['›', 'execute · debounce.spec.ts → DEV'],
      ['✓', 'execute · debounces input by 300ms · 412ms'],
      ['✓', 'execute · cancels in-flight request · 338ms'],
      ['›', 'execute · shows spinner while pending …'],
    ],
    // Lines the live view streams in next (the future of this run).
    liveQueue: [
      ['✓', 'execute · shows spinner while pending · 274ms'],
      ['›', 'execute · renders empty-state for zero results …'],
      ['✓', 'execute · renders empty-state · 221ms'],
      ['›', 'execute · 4 passed · 0 flaky · 11.8s'],
      ['›', 'oracle · mutation testing · 18 mutants'],
      ['✓', 'oracle · 15/18 caught · valueScore 0.83'],
      ['✓', 'verdict PASS → opening PR with auto-merge'],
    ],
  };

  const runs = [
    {
      id: 'r-1841', app: 'web-app', sha: '9f6edf2', verdict: 'pass', mode: 'diff',
      message: 'feat(map): cluster nearby pins at low zoom', author: 'maria',
      time: '4m ago', specs: 4, reviewer: 'approved', decision: 'PR #182 · auto-merge',
      branch: 'DEV', duration: '2m 18s', coverage: 'covered', oracle: '0.82',
      stages: [['classify', 'done'], ['generate', 'done'], ['validate', 'done'], ['execute', 'done'], ['decide', 'done']],
      changed: ['src/app/map/map.component.ts', 'src/app/map/cluster.service.ts'],
      newSpecs: [
        { file: 'e2e/map/cluster-pins.spec.ts', status: 'pass', n: 3 },
        { file: 'e2e/map/zoom-bounds.spec.ts', status: 'pass', n: 1 },
      ],
      log: [
        ['$', 'qayaba qa --app web-app --sha 9f6edf2'],
        ['›', 'classify · feat → generate targeted'],
        ['›', 'blast radius · map.component.ts → /map route'],
        ['›', 'fe↔be · getPins() → GET /pins (checkout-api)'],
        ['›', 'generate · wrote 4 specs · reviewer approved'],
        ['›', 'execute · 4 passed · 0 flaky · 12.4s'],
        ['›', 'oracle · mutation 0.82 → promotes R-204'],
        ['✓', 'verdict PASS → PR #182 opened, auto-merge enabled'],
      ],
    },
    {
      id: 'r-1840', app: 'checkout-api', sha: 'a1b2c3d', verdict: 'fail', mode: 'diff',
      message: 'fix(cart): reject negative quantities', author: 'devon',
      time: '22m ago', specs: 2, reviewer: 'approved', decision: 'Issue #91',
      branch: 'DEV', duration: '1m 47s', coverage: 'covered', oracle: '—',
      stages: [['classify', 'done'], ['generate', 'done'], ['validate', 'done'], ['execute', 'fail'], ['decide', 'done']],
      changed: ['src/cart/CartController.java', 'src/cart/CartService.java'],
      newSpecs: [
        { file: 'e2e/cart/negative-qty.spec.ts', status: 'fail', n: 2 },
      ],
      log: [
        ['$', 'qayaba qa --app checkout-api --sha a1b2c3d'],
        ['›', 'classify · fix → generate targeted'],
        ['›', 'generate · wrote 2 specs · reviewer approved'],
        ['✗', 'execute · 1 failed · expected 400, got 200'],
        ['›', 'reflect · produced rule candidate · validation gap'],
        ['✗', 'verdict FAIL → Issue #91 opened with sanitized logs'],
      ],
    },
    {
      id: 'r-1839', app: 'web-app', sha: 'd4e5f6a', verdict: 'flaky', mode: 'diff',
      message: 'refactor(auth): extract token refresh', author: 'maria',
      time: '1h ago', specs: 1, reviewer: 'approved', decision: 'quarantined',
      branch: 'DEV', duration: '3m 02s', coverage: 'covered', oracle: '—',
      stages: [['classify', 'done'], ['generate', 'done'], ['validate', 'done'], ['execute', 'flaky'], ['decide', 'done']],
      changed: ['src/app/auth/token.service.ts'],
      newSpecs: [{ file: 'e2e/auth/token-refresh.spec.ts', status: 'flaky', n: 1 }],
      log: [
        ['$', 'qayaba qa --app web-app --sha d4e5f6a'],
        ['›', 'classify · refactor → regression-only'],
        ['~', 'execute · passed on retry 2/3 → flaky'],
        ['~', 'verdict FLAKY → quarantined, no Issue'],
      ],
    },
    {
      id: 'r-1838', app: 'portfolio', sha: 'c0ffee1', verdict: 'skipped', mode: 'diff',
      message: 'style: format with prettier', author: 'ariel',
      time: '2h ago', specs: 0, reviewer: '—', decision: 'no tokens spent',
      branch: 'DEV', duration: '0.3s', coverage: '—', oracle: '—',
      stages: [['classify', 'skip'], ['generate', 'skip'], ['validate', 'skip'], ['execute', 'skip'], ['decide', 'skip']],
      changed: ['src/**/*.astro'],
      newSpecs: [],
      log: [
        ['$', 'qayaba qa --app portfolio --sha c0ffee1'],
        ['›', 'classify · style: no logic change'],
        ['·', 'verdict SKIPPED → 0 tokens spent'],
      ],
    },
    {
      id: 'r-1837', app: 'checkout-api', sha: 'b4dc0de', verdict: 'infra-error', mode: 'diff',
      message: 'chore(deps): bump spring-boot', author: 'devon',
      time: '3h ago', specs: 0, reviewer: '—', decision: 'DEV unhealthy',
      branch: 'DEV', duration: '90s timeout', coverage: '—', oracle: '—',
      stages: [['classify', 'done'], ['generate', 'done'], ['validate', 'done'], ['execute', 'infra'], ['decide', 'skip']],
      changed: ['pom.xml'],
      newSpecs: [],
      log: [
        ['$', 'qayaba qa --app checkout-api --sha b4dc0de'],
        ['›', 'health pre-flight · DEV /health → 503'],
        ['!', 'verdict INFRA-ERROR → not a code bug, no Issue'],
      ],
    },
    {
      id: 'r-1836', app: 'web-app', sha: 'feed123', verdict: 'pass', mode: 'complete',
      message: 'coverage sweep · uncovered flows', author: 'qayaba',
      time: '5h ago', specs: 7, reviewer: 'approved', decision: 'PR #180 · auto-merge',
      branch: 'DEV', duration: '6m 41s', coverage: 'covered', oracle: '0.74',
      stages: [['classify', 'done'], ['generate', 'done'], ['validate', 'done'], ['execute', 'done'], ['decide', 'done']],
      changed: ['(whole repo)'],
      newSpecs: [
        { file: 'e2e/profile/edit.spec.ts', status: 'pass', n: 3 },
        { file: 'e2e/search/filters.spec.ts', status: 'pass', n: 4 },
      ],
      log: [
        ['$', 'qayaba qa --app web-app --mode complete'],
        ['›', 'analyze · 11 routes · 6 uncovered flows'],
        ['›', 'generate · wrote 7 specs · reviewer approved'],
        ['✓', 'verdict PASS → PR #180 opened'],
      ],
    },
  ];

  // Headline counters.
  const stats = { runs7d: 128, passRate: 0.86, specsAdded: 41, openIssues: 3, watching: 3 };

  // Live engine telemetry — the Prometheus gauges + health poller from the engine.
  const live = {
    status: 'operational',
    health: { ok: true, last: '38s ago', interval: '60s' },
    queue: { running: 1, queued: 0 },
    sessions: 2,
    mirrors: '4h ago',
    webhook: 'github · verified',
  };

  // Verdict distribution over the last 7 days. Order = severity narrative.
  const verdictMix = [
    { v: 'pass', n: 96 },
    { v: 'fail', n: 14 },
    { v: 'flaky', n: 7 },
    { v: 'infra-error', n: 4 },
    { v: 'skipped', n: 7 },
  ];

  // 14-point daily trends.
  const trend = {
    passRate: [0.79, 0.81, 0.80, 0.84, 0.83, 0.85, 0.82, 0.86, 0.85, 0.88, 0.86, 0.87, 0.84, 0.86],
    specs: [2, 4, 3, 5, 6, 4, 7, 5, 8, 6, 9, 7, 4, 11],
  };

  // Execution-mode breakdown (7d).
  const modes = [
    { m: 'diff', n: 92, note: 'webhook · per commit' },
    { m: 'complete', n: 21, note: 'coverage gaps' },
    { m: 'exhaustive', n: 6, note: 'full audit' },
    { m: 'manual', n: 5, note: 'operator prompt' },
    { m: 'code', n: 4, note: 'backend suite' },
  ];

  // The learning flywheel — five ledger components.
  const flywheel = [
    { id: 'labeler', label: 'labeler', icon: 'tags', stat: '128', unit: 'runs classed', note: 'no LLM · error class' },
    { id: 'oracle', label: 'oracle', icon: 'shield-check', stat: '0.78', unit: 'mean valueScore', note: 'mutation · fault-inject' },
    { id: 'reflector', label: 'reflector', icon: 'lightbulb', stat: '25', unit: 'reflections', note: 'on every failure' },
    { id: 'distiller', label: 'distiller', icon: 'filter', stat: '18', unit: 'rules distilled', note: 'deduped & reusable' },
    { id: 'curriculum', label: 'curriculum', icon: 'graduation-cap', stat: '9', unit: 'archetypes proven', note: 'injected into prompts' },
  ];

  // Promoted rules in the ledger.
  const rules = [
    { id: 'R-204', app: 'web-app', conf: 'high', source: 'oracle', hits: 6, text: 'Map tiles lazy-load — assert pins after networkidle, not on load.' },
    { id: 'R-198', app: 'web-app', conf: 'high', source: 'oracle', hits: 9, text: 'Login posts to Keycloak; wait for redirect to /dashboard before asserting.' },
    { id: 'R-187', app: 'checkout-api', conf: 'med', source: 'prevention', hits: 4, text: 'Cart totals round half-up; expect "12.35" string, not float 12.345.' },
    { id: 'R-176', app: 'portfolio', conf: 'med', source: 'prevention', hits: 3, text: 'Astro bundles assets — URL→source coverage unmeasurable, report unknown.' },
  ];

  // The four-layer quality gate. Layers 1–2 block; 3 blocks only on enforce; 4 never blocks.
  const gates = [
    { n: 1, label: 'static analysis', icon: 'file-check-2', mode: 'blocks', pass: 128, of: 128, desc: 'compiles · lint · valid test list · manifest' },
    { n: 2, label: 'reviewer ai', icon: 'scan-eye', mode: 'blocks', pass: 119, of: 128, desc: 'real value · asserts · robust selectors' },
    { n: 3, label: 'change-coverage', icon: 'crosshair', mode: 'signal', pass: 102, of: 124, desc: 'green test executes the changed lines' },
    { n: 4, label: 'mutation / oracle', icon: 'bug', mode: 'signal', pass: 71, of: 96, desc: 'detects injected bugs → valueScore' },
  ];

  // ── Per-app health history ─────────────────────────────────────────────
  // Each checkpoint = one run. Fields:
  //  id, time, verdict, health(0-100), passRate, specs, coverage%, oracle, flaky, issues, durSec
  function ck(a) {
    return { id: a[0], sha: a[1], time: a[2], verdict: a[3], health: a[4], passRate: a[5],
      specs: a[6], coverage: a[7], oracle: a[8], flaky: a[9], issues: a[10], durSec: a[11] };
  }
  const histories = {
    'web-app': [
      ['r-1801', '3c1aa20', '7d', 'pass', 80, 0.81, 13, 84, 0.69, 2, 2, 128],
      ['r-1808', '7b22e4f', '6d', 'pass', 83, 0.84, 15, 86, 0.72, 1, 1, 121],
      ['r-1815', 'e90c155', '5d', 'fail', 71, 0.76, 15, 80, 0.0, 1, 3, 140],
      ['r-1822', '4ad7be1', '4d', 'pass', 85, 0.86, 17, 88, 0.74, 1, 1, 118],
      ['r-1829', '1f0d9a2', '3d', 'pass', 87, 0.87, 18, 90, 0.76, 1, 1, 124],
      ['r-1836', 'feed123', '5h', 'pass', 88, 0.86, 20, 90, 0.74, 0, 1, 401],
      ['r-1839', 'd4e5f6a', '1h', 'flaky', 84, 0.85, 20, 90, 0.0, 2, 1, 182],
      ['r-1841', '9f6edf2', '4m', 'pass', 91, 0.89, 21, 92, 0.82, 0, 1, 138],
    ].map(ck),
    'checkout-api': [
      ['r-1790', '0aa11b2', '7d', 'pass', 79, 0.82, 11, 82, 0.0, 1, 1, 96],
      ['r-1797', '5cc02de', '5d', 'pass', 77, 0.80, 12, 80, 0.0, 2, 2, 104],
      ['r-1810', 'bb31f07', '4d', 'flaky', 72, 0.79, 13, 78, 0.0, 2, 2, 150],
      ['r-1820', '9d40a18', '2d', 'fail', 68, 0.77, 13, 76, 0.0, 2, 3, 141],
      ['r-1833', '7e5b9c0', '1d', 'pass', 74, 0.78, 14, 79, 0.0, 1, 2, 112],
      ['r-1837', 'b4dc0de', '3h', 'infra-error', 60, 0.78, 14, 76, 0.0, 2, 3, 90],
      ['r-1840', 'a1b2c3d', '22m', 'fail', 64, 0.78, 14, 76, 0.0, 3, 3, 107],
    ].map(ck),
    'portfolio': [
      ['r-1780', 'aa0b1c2', '6d', 'pass', 90, 0.90, 5, 86, 0.0, 0, 0, 72],
      ['r-1788', 'c1d2e30', '5d', 'skipped', 90, 0.90, 5, 86, 0.0, 0, 0, 1],
      ['r-1802', 'd3e4f51', '3d', 'pass', 92, 0.92, 6, 88, 0.0, 0, 0, 80],
      ['r-1818', 'e5f6a72', '2d', 'skipped', 91, 0.91, 6, 88, 0.0, 0, 0, 1],
      ['r-1831', 'f7a8b93', '1d', 'pass', 93, 0.93, 6, 90, 0.0, 0, 0, 78],
      ['r-1838', 'c0ffee1', '2h', 'skipped', 91, 0.91, 6, 88, 0.0, 0, 0, 1],
    ].map(ck),
  };

  // ── The committed suite (shared by Suite view + App detail) ────────────
  const suite = [
    { file: 'e2e/search/debounce.spec.ts', app: 'web-app', status: 'pass', n: 4, coverage: 'covered' },
    { file: 'e2e/map/cluster-pins.spec.ts', app: 'web-app', status: 'pass', n: 3, coverage: 'covered' },
    { file: 'e2e/map/zoom-bounds.spec.ts', app: 'web-app', status: 'pass', n: 1, coverage: 'covered' },
    { file: 'e2e/profile/edit.spec.ts', app: 'web-app', status: 'pass', n: 3, coverage: 'covered' },
    { file: 'e2e/search/filters.spec.ts', app: 'web-app', status: 'pass', n: 4, coverage: 'covered' },
    { file: 'e2e/auth/token-refresh.spec.ts', app: 'web-app', status: 'flaky', n: 1, coverage: 'covered' },
    { file: 'e2e/cart/negative-qty.spec.ts', app: 'checkout-api', status: 'fail', n: 2, coverage: 'covered' },
    { file: 'e2e/cart/coupon.spec.ts', app: 'checkout-api', status: 'pass', n: 5, coverage: 'covered' },
    { file: 'e2e/home/hero.spec.ts', app: 'portfolio', status: 'pass', n: 2, coverage: 'unknown' },
  ];

  // ── Engram · episodic memory (shared) ──────────────────────────────────
  const engram = [
    { app: 'web-app', text: 'Login form posts to Keycloak; wait for redirect to /dashboard before asserting.' },
    { app: 'web-app', text: 'Map tiles lazy-load — assert pins after networkidle, not on load.' },
    { app: 'web-app', text: 'Search debounces 300ms — wait before asserting the URL query param.' },
    { app: 'checkout-api', text: 'Cart totals round half-up; expect "12.35" not "12.345".' },
    { app: 'checkout-api', text: 'DEV returns 503 during spring-boot restarts — treat as infra, not fail.' },
    { app: 'portfolio', text: 'Astro bundles assets — URL→source coverage unmeasurable, report unknown.' },
  ];

  // ── Fleet signals · period-over-period (ground-truth first) ────────────
  const signals = {
    window: 'last 64 runs', prevWindow: 'prev 64',
    valueOracle: { v: 0.78, prev: 0.71, baseline: 0.49, series: [0.68, 0.70, 0.69, 0.72, 0.74, 0.73, 0.76, 0.78] },
    reviewerPass: { v: 0.93, prev: 0.90, series: [0.88, 0.89, 0.90, 0.89, 0.91, 0.92, 0.92, 0.93] },
    runs: { measured: 96, total: 128, prevMeasured: 88, prevTotal: 120, series: [12, 14, 11, 15, 13, 16, 14, 18] },
    suitesGreen: { v: 2, total: 3, prev: 2, series: [2, 2, 1, 2, 2, 2, 2, 2] },
    prsAutoMerged: { v: 23, prev: 18, series: [2, 3, 2, 4, 3, 3, 2, 4] },
    issuesOpen: { v: 3, prev: 5, series: [5, 4, 5, 4, 3, 4, 3, 3] },
  };

  // Where the guardrails fire — fleet ErrorClass distribution.
  const fleetErrorClasses = [
    ['timing-flake', 9], ['assertion-trivial', 6], ['selector-fragile', 6],
    ['auth-flow', 4], ['env-drift', 3], ['coverage-miss', 3],
  ];

  // ── Learning ledger · governed rules, archetypes, audit ────────────────
  const ledger = {
    rules: [
      { id: 'R-204', status: 'active', trigger: 'lazy-loaded content on /map', action: 'await networkidle before asserting pins', errorClass: 'timing-flake', confidence: 'high', usage: 6, outcomes: 6, success: 1.0 },
      { id: 'R-198', status: 'active', trigger: 'Keycloak login redirect', action: 'wait for /dashboard before asserting', errorClass: 'auth-flow', confidence: 'high', usage: 9, outcomes: 8, success: 0.89 },
      { id: 'R-176', status: 'active', trigger: 'Astro bundled assets', action: 'report coverage unknown, never block', errorClass: 'coverage-miss', confidence: 'med', usage: 3, outcomes: 3, success: 1.0 },
      { id: 'R-187', status: 'active', trigger: 'cart total rounding', action: 'expect 2dp string, not float', errorClass: 'assertion-trivial', confidence: 'med', usage: 4, outcomes: 3, success: 0.75 },
      { id: 'R-211', status: 'candidate', trigger: 'search debounce 300ms', action: 'wait before asserting URL query param', errorClass: 'timing-flake', confidence: 'low', usage: 1, outcomes: 1, success: 1.0 },
      { id: 'R-215', status: 'candidate', trigger: 'paginated list tail', action: 'assert last page boundary explicitly', errorClass: 'assertion-trivial', confidence: 'low', usage: 0, outcomes: 0, success: 0 },
      { id: 'R-152', status: 'deprecated', trigger: 'old selector data-qa', action: 'use data-test instead', errorClass: 'selector-fragile', confidence: 'low', usage: 12, outcomes: 7, success: 0.58 },
      { id: 'R-149', status: 'superseded', trigger: 'generic wait 1000ms', action: 'superseded by R-204', errorClass: 'timing-flake', confidence: 'low', usage: 8, outcomes: 4, success: 0.50 },
    ],
    archetypes: [
      { name: 'auth redirect flow', caughtRealBug: true, promotions: 5 },
      { name: 'lazy-loaded list', caughtRealBug: true, promotions: 4 },
      { name: 'form validation boundary', caughtRealBug: true, promotions: 3 },
      { name: 'pagination edge', caughtRealBug: false, promotions: 2 },
      { name: 'empty-state render', caughtRealBug: false, promotions: 1 },
    ],
    audit: [
      { rule: 'R-152', issue: 'successRate 0.58 below floor → demoted to deprecated', level: 'demoted' },
      { rule: 'R-149', issue: 'malformed canonical trigger → superseded by R-204', level: 'resolved' },
    ],
  };

  // ── Suite health / integrity (the trust page) ──────────────────────────
  const integrity = {
    flakyRate: { v: 0.055, prev: 0.070, series: [0.08, 0.07, 0.09, 0.06, 0.05, 0.06, 0.055] },
    infraErrorRate: { v: 0.031, prev: 0.020, series: [0.02, 0.03, 0.02, 0.04, 0.03, 0.03, 0.031] },
    invalidRate: { v: 0.0, prev: 0.010, series: [0.01, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0] },
    timeToGreen: { v: 138, prev: 150 },
    determinism: 0.98,
    phases: [['classify', 3], ['generate', 46], ['validate', 12], ['execute', 62], ['coverage', 15]],
    gates: {
      enforceHeld: { v: 7, desc: 'PRs blocked by the coverage-gate (enforce)' },
      regenRecovered: { v: 11, desc: 'runs where regeneration recovered coverage' },
      staticRejected: { v: 4, desc: 'invalid specs caught by the static gate' },
    },
  };

  // ── Reports · ad-hoc generator (NL templates, interestingness-ranked) ──
  const reports = {
    templates: [
      { id: 'exec', name: 'Executive value summary', desc: 'Ground-truth value and trust, period-over-period, for the team under test.', blocks: 5, schedule: 'weekly · Slack', channel: 'slack' },
      { id: 'health', name: 'Suite-health deep-dive', desc: 'Flakiness, infra vs code, gate effectiveness and determinism.', blocks: 6, schedule: 'on-demand', channel: 'email' },
    ],
    insights: [
      { metric: 'value-oracle', shape: 'multiplier', headline: 'Value-oracle ×1.6 vs last sprint', detail: 'Mutation kill-rate 0.78 — up from a 0.49 baseline window. Generated tests are catching real injected bugs.', weight: 0.94 },
      { metric: 'change-coverage', shape: 'gauge', headline: 'Coverage 92%, above the 70% enforce floor', detail: 'web-app coverage held on every enforce run; no PR shipped without exercising the diff.', weight: 0.88 },
      { metric: 'where-guardrails-fire', shape: 'bars', headline: 'timing-flake leads guardrail trips', detail: '9 of 29 rejections were timing-related; R-204 now intercepts most of them.', weight: 0.71 },
      { metric: 'flaky', shape: 'sparkline', headline: 'Flaky rate down to 5.5%', detail: 'From 7.0% — quarantine policy plus R-204 promotion. Determinism holding at 0.98.', weight: 0.66 },
      { metric: 'infra', shape: 'note', headline: 'Infra-error rate up to 3.1% — not the code', detail: 'checkout-api DEV restarts during spring-boot bumps; surfaced as infra, never counted as a failure.', weight: 0.41 },
    ],
  };

  return { models, apps, running, runs, stats, live, verdictMix, trend, modes, flywheel, rules, gates,
    histories, suite, engram, signals, fleetErrorClasses, ledger, integrity, reports };
})();
