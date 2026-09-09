/* ═══════════════════════════════════════════════════════════════════════
   Qayaba Console — data layer (the ONE seam between UI and backend).

   console.js never fetches; it asks window.QayabaConsole.api for data. Two
   adapters implement the same interface:

     • mock  — returns window.QayabaMockData; runs the live-run + chat
               simulations locally. Zero backend. Default.
     • live  — talks to the ai-pipeline orchestrator over /api/v1/* (same
               origin, Bearer/credentials) and the SSE live feed. Mirrors
               @ai-pipeline/sdk's createClient() method-for-method, so a future
               swap to the real SDK is mechanical.

   Configure by setting window.QAYABA_CONSOLE_CONFIG before this script loads:
     window.QAYABA_CONSOLE_CONFIG = { mode:'live', baseUrl:'', token:null, landingUrl:'/' }

   Interface consumed by console.js:
     api.loadAll()                  → Promise<ViewModel>   (the whole dashboard model)
     api.subscribeRun(id, handlers) → unsubscribe()|null   (null ⇒ UI self-simulates)
     api.ask(runId, question)       → Promise<string|null> (null ⇒ UI uses canned answer)
     api.createRun({app,mode,sha})  → Promise<any>
     api.cancelRun(runId)           → Promise<any>

   See API.md for the full endpoint requirements + field-mapping + gaps.
   ═══════════════════════════════════════════════════════════════════════ */
window.QayabaConsole = (function () {
  const storedToken = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('qayaba_token') : null;
  
  const cfg = Object.assign(
    { mode: 'live', baseUrl: '', token: storedToken, landingUrl: '/' },
    window.QAYABA_CONSOLE_CONFIG || {}
  );

  /* ── mock adapter ──────────────────────────────────────────────────────
     loadAll resolves the bundled model. subscribeRun/ask return null so the UI
     keeps its built-in simulations (so the kit looks alive with no server). */
  const mock = {
    loadAll() { return Promise.resolve(window.QayabaMockData); },
    subscribeRun() { return null; },
    ask() { return Promise.resolve(null); },
    createRun(input) { return Promise.resolve({ id: 'queued', status: 'enqueued', app: input.app, mode: input.mode }); },
    cancelRun(id) { return Promise.resolve({ id: id, status: 'cancelled' }); },
  };

  /* ── live adapter ──────────────────────────────────────────────────────
     Real transport to /api/v1/*. Reads map the contract → the dashboard view
     model (see mapModel). Anything the contract does not yet provide is marked
     TODO(server) here and listed in API.md so the backend can be extended. */
  const API = cfg.baseUrl + '/api/v1';
  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (cfg.token) h.Authorization = 'Bearer ' + cfg.token;
    return h;
  }
  function req(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: headers(),
      credentials: 'include',
      body: body == null ? undefined : JSON.stringify(body),
    }).then((r) => {
      if (r.status === 401) {
        // Token invalid or expired → clear and redirect to login
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.removeItem('qayaba_token');
        }
        window.location.hash = '#login';
        throw new Error('Authentication required');
      }
      if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status);
      return r.status === 204 ? null : r.json();
    });
  }
  // SDK-mirroring calls (1:1 with @ai-pipeline/sdk createClient()).
  const ep = {
    version: () => req('GET', '/version'),
    signals: () => req('GET', '/signals'),
    queue: () => req('GET', '/queue'),
    listApps: () => req('GET', '/apps'),
    getApp: (name) => req('GET', '/apps/' + encodeURIComponent(name)),
    listRuns: (app, limit) => req('GET', '/runs?app=' + encodeURIComponent(app) + '&limit=' + (limit || 20)),
    getRun: (id) => req('GET', '/runs/' + encodeURIComponent(id)),
    trends: (app) => req('GET', '/apps/' + encodeURIComponent(app) + '/trends'),
    intelligence: (app) => req('GET', '/apps/' + encodeURIComponent(app) + '/intelligence'),
    report: (app) => req('GET', '/apps/' + encodeURIComponent(app) + '/report'),
    agentModels: (provider) => req('GET', '/agent/models?provider=' + encodeURIComponent(provider || '')),
  };

  const live = {
    // Composes the whole dashboard model from the control API. For a fleet of a
    // few apps this fan-out is cheap; lazily-load per view later if it grows.
    async loadAll() {
      const [apps, queue, signals] = await Promise.all([
        ep.listApps(), ep.queue(), ep.signals().catch(() => null),
      ]);
      const names = apps.map((a) => a.name);
      const perApp = await Promise.all(names.map((n) => Promise.all([
        ep.listRuns(n, 20).catch(() => []),
        ep.trends(n).catch(() => null),
        ep.intelligence(n).catch(() => null),
      ])));
      const runsByApp = {}, trendsByApp = {}, intelByApp = {};
      names.forEach((n, i) => { runsByApp[n] = perApp[i][0]; trendsByApp[n] = perApp[i][1]; intelByApp[n] = perApp[i][2]; });
      return mapModel({ apps, queue, signals, runsByApp, trendsByApp, intelByApp });
    },
    // SSE live feed → normalized handlers the UI applies. Maps the 15 RunEventBody
    // variants onto {onStep,onPlan,onCase,onLog,onVerdict}.
    subscribeRun(runId, h) {
      h = h || {};
      const es = new EventSource(API + '/runs/' + encodeURIComponent(runId) + '/events');
      es.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
        const b = ev && ev.body ? ev.body : ev; if (!b || !b.type) return;
        switch (b.type) {
          case 'step.changed': h.onStep && h.onStep(b.step, b.detail); break;
          case 'plan.updated': h.onPlan && h.onPlan(b.todos); break;
          case 'test.started': h.onCase && h.onCase(b.name, 'running'); break;
          case 'test.passed': h.onCase && h.onCase(b.name, 'pass', b.durationMs); break;
          case 'test.failed': h.onCase && h.onCase(b.name, 'fail', b.durationMs, b.detail); break;
          case 'test.flaky': h.onCase && h.onCase(b.name, 'flaky'); break;
          case 'log.line': h.onLog && h.onLog(logGlyph(b.level), b.text); break;
          case 'run.verdict': h.onVerdict && h.onVerdict(b.verdict, b); break;
          case 'agent.error': h.onLog && h.onLog('!', b.detail); break;
          default: break; // run.started / agent.activity / spec.written / test.discovered / reviewer.verdict / coverage.computed
        }
      };
      es.onerror = () => { h.onError && h.onError(); };
      return () => es.close();
    },
    ask(runId, question) { return ep && req('POST', '/runs/' + encodeURIComponent(runId) + '/ask', { question: question }).then((r) => (r && r.answer) || null); },
    createRun(input) { return req('POST', '/runs', { app: input.app, mode: input.mode, sha: input.sha || undefined, target: input.target || 'e2e' }); },
    cancelRun(id) { return req('DELETE', '/runs/' + encodeURIComponent(id)); },
  };

  function logGlyph(level) { return level === 'error' ? '✗' : level === 'warn' ? '~' : level === 'ok' ? '✓' : '›'; }

  /* Map the /api/v1 contract responses onto the dashboard's internal view model.
     Implemented for the fields the contract clearly provides; everything else is
     flagged TODO(server) and itemised in API.md. */
  function mapModel(raw) {
    const m = (window.QayabaMockData) || {};
    const apps = raw.apps.map((a) => ({
      name: a.name, repo: a.repo, stack: '', // TODO(server): AppView has no `stack` label
      shadow: a.shadow, watching: true,
      baseBranch: 'main', devUrl: a.baseUrl, target: a.code ? 'code' : 'e2e',
      status: a.shadow ? 'shadow' : a.code ? 'code-mode' : 'live',
      // TODO(server): vmix, value, coverage, reviewerPass, errClasses, trend come from /apps/:name/trends + /intelligence
      vmix: trendVmix(raw.trendsByApp[a.name]) || [],
      value: pick(raw.trendsByApp[a.name], 'valueOracle.avgScore'),
      coverage: pick(raw.trendsByApp[a.name], 'coverage.measured') ? pick(raw.trendsByApp[a.name], 'coverage.ratio') : null,
      coverageMin: pick(raw.trendsByApp[a.name], 'coverage.minRatio', 0.7),
      reviewerPass: pick(raw.trendsByApp[a.name], 'reviewerPassRate', 0),
      errClasses: (pick(raw.trendsByApp[a.name], 'errorClasses', []) || []).map((e) => [e.errorClass, e.count]),
      coverageMode: a.code ? 'off' : 'signal', oracle: a.code ? 'code' : 'e2e',
      valueSeries: pick(raw.trendsByApp[a.name], 'valueOracle.series', null),
      coverageSeries: pick(raw.trendsByApp[a.name], 'coverage.series', null),
    }));
    const runs = [].concat.apply([], raw.apps.map((a) => (raw.runsByApp[a.name] || []).map(mapRun)))
      .sort((x, y) => (y._at || 0) - (x._at || 0));
    const runningRef = raw.queue && raw.queue.running;
    const running = runningRef ? (runs.find((r) => r.id === runningRef.id) || null) : null;
    return {
      models: m.models, // TODO(server): expose generator/reviewer model ids (see /agent/config)
      apps: apps,
      running: running || m.running, // TODO(server): live run needs plan/currentTest/liveLog (getRun on the running id)
      runs: runs,
      stats: m.stats,           // TODO(server): runs7d/passRate/specsAdded/openIssues — fleet rollup endpoint
      live: mapLive(raw.queue), // partial; health/sessions/mirrors/webhook need an engine-status endpoint
      verdictMix: m.verdictMix, // TODO(server): fleet 7d verdict distribution
      signals: mapSignals(raw.signals) || m.signals, // see API.md: SignalsView is leaner than the hero needs
      fleetErrorClasses: m.fleetErrorClasses, // TODO(server): fleet-wide ErrorClass rollup
      flywheel: m.flywheel,     // TODO(server): learning flywheel counters
      gates: m.gates,           // TODO(server): 4-layer quality-gate effectiveness
      histories: m.histories,   // TODO(server): per-app health history (per-run checkpoints)
      suite: m.suite,           // TODO(server): committed suite per app
      engram: m.engram,         // TODO(server): per-app episodic memory
      ledger: mapLedger(raw.intelByApp) || m.ledger,
      integrity: m.integrity || {
        flakyRate: { v: 0, prev: 0, series: [0] },
        infraErrorRate: { v: 0, prev: 0, series: [0] },
        invalidRate: { v: 0, prev: 0, series: [0] },
        timeToGreen: { v: 0, prev: 0 },
        determinism: 0,
        phases: [],
        gates: {
          enforceHeld: { v: '0%', desc: 'enforce gate held' },
          regenRecovered: { v: '0%', desc: 'regen recovered' },
          staticRejected: { v: '0%', desc: 'static rejected' },
        },
      },   // TODO(server): suite-health/trust rollup
      reports: m.reports,       // partial; /apps/:name/report → ReportView (see API.md)
      modes: m.modes, rules: m.rules, trend: m.trend,
    };
  }
  function mapRun(r) {
    return {
      id: r.id, app: r.app, sha: r.sha, verdict: r.verdict, mode: r.mode,
      message: r.note || r.step || '', author: '', time: relTime(r.at), _at: Date.parse(r.at) || 0,
      specs: (r.specs || []).length, reviewer: '—', decision: r.note || '',
      branch: r.ref || 'DEV', duration: '', coverage: '—', oracle: '—',
      stages: [], // TODO(server): pipeline stage states — derive from RunRecord.step or activity
      changed: [], newSpecs: (r.specs || []).map((s) => ({ file: s.name, status: r.verdict, n: 1 })),
      log: (r.logs || []).map((l) => ['›', l]),
    };
  }
  function mapLive(queue) {
    const m = (window.QayabaMockData && window.QayabaMockData.live) || {};
    return Object.assign({}, m, { queue: { running: queue && queue.running ? 1 : 0, queued: (queue && queue.pending) || 0 } });
  }
  function mapSignals(s) {
    if (!s) return null;
    // SignalsView → the hero's six KPI tiles. prev/series/suitesGreen/prsAutoMerged/issuesOpen
    // are NOT in SignalsView today → see API.md "Overview gap".
    const vo = s.valueOracle || {};
    const rp = s.reviewer || {};
    const mock = (window.QayabaMockData && window.QayabaMockData.signals) || {};
    const score = vo.avgScore;
    const passRate = rp.passRate;
    return Object.assign({}, mock, {
      valueOracle: { v: score == null ? null : score, prev: score == null ? null : score, baseline: score == null ? null : score, series: score == null ? [] : [score] },
      reviewerPass: { v: passRate == null ? null : passRate, prev: passRate == null ? null : passRate, series: passRate == null ? [] : [passRate] },
      runs: { measured: vo.measuredRuns || 0, total: vo.totalRuns || 0, prevMeasured: vo.measuredRuns || 0, prevTotal: vo.totalRuns || 0, series: [vo.measuredRuns || 0] },
      suitesGreen: mock.suitesGreen || { v: 0, total: 0, prev: 0, series: [0] },
      prsAutoMerged: mock.prsAutoMerged || { v: 0, prev: 0, series: [0] },
      issuesOpen: mock.issuesOpen || { v: 0, prev: 0, series: [0] },
      window: mock.window || 'last 7d',
      prevWindow: mock.prevWindow || 'previous 7d',
    });
  }
  function mapLedger(intelByApp) {
    const rules = [];
    Object.keys(intelByApp || {}).forEach((app) => {
      const iv = intelByApp[app]; if (!iv || !iv.rules) return;
      iv.rules.forEach((r, i) => rules.push({
        id: 'R-' + app.slice(0, 2) + i, status: r.status === 'medium' ? 'active' : r.status,
        trigger: r.trigger, action: r.action, errorClass: r.errorClass,
        confidence: r.confidence === 'medium' ? 'med' : r.confidence,
        usage: r.usageCount, outcomes: r.outcomeCount, success: r.successRate,
      }));
    });
    if (!rules.length) return null;
    return { rules: rules, archetypes: [], audit: [] }; // TODO(server): archetypes (curriculum) + governance audit log
  }
  function trendVmix(t) { return t && t.verdictMix ? Object.keys(t.verdictMix).map((v) => ({ v: v, n: t.verdictMix[v] })) : null; }
  function pick(obj, path, dflt) {
    if (!obj) return dflt;
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    return v == null ? dflt : v;
  }
  function relTime(iso) {
    const t = Date.parse(iso); if (!t) return '';
    const s = Math.max(1, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago';
  }

  return { config: cfg, api: cfg.mode === 'live' ? live : mock };
})();
