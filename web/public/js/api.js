/* ═══════════════════════════════════════════════════════════════════════
   Qayaba Console — data layer (the ONE seam between UI and backend).
   console.js never fetches; it asks window.QayabaConsole.api for data. Two
   adapters implement the same interface:
   • mock — returns window.QayabaMockData; runs the live-run + chat
   simulations locally. Zero backend. Default.
   • live — talks to the ai-pipeline orchestrator over /api/v1/* (same
   origin, Bearer/credentials) and the SSE live feed. Mirrors
   @ai-pipeline/sdk's createClient() method-for-method, so a future
   swap to the real SDK is mechanical.
   Configure by setting window.QAYABA_CONSOLE_CONFIG before this script loads:
   window.QAYABA_CONSOLE_CONFIG = { mode:'live', baseUrl:'', token:null, landingUrl:'/' }
   Interface consumed by console.js:
   api.loadAll() → Promise<ViewModel> (the whole dashboard model)
   api.subscribeRun(id, handlers) → unsubscribe()|null (null ⇒ UI self-simulates)
   api.ask(runId, question) → Promise<string|null> (null ⇒ UI uses canned answer)
   api.createRun({app,mode,sha}) → Promise<any>
   api.cancelRun(runId) → Promise<any>
   See API.md for the full endpoint requirements + field-mapping + gaps.
   ═══════════════════════════════════════════════════════════════════════
 */
window.QayabaConsole = (function () {
  const storedToken = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('qayaba_token') : null;

  const cfg = Object.assign(
    { mode: 'live', baseUrl: '', token: storedToken, landingUrl: '/' },
    window.QAYABA_CONSOLE_CONFIG || {}
  );

  /* ── mock adapter ──────────────────────────────────────────────────────
     loadAll resolves the bundled model. subscribeRun/ask return null so the UI
     keeps its built-in simulations (so the kit looks alive with no server).
   */
  const mock = {
    loadAll() { return Promise.resolve(window.QayabaMockData); },
    subscribeRun() { return null; },
    ask() { return Promise.resolve(null); },
    createRun(input) { return Promise.resolve({ id: 'queued', status: 'enqueued', app: input.app, mode: input.mode }); },
    cancelRun(id) { return Promise.resolve({ id: id, status: 'cancelled' }); },
    continueRun(id) { return Promise.resolve({ id: 'queued', parentRunId: id }); },
    runReport() { return Promise.resolve(null); },
    turns() { return Promise.resolve([]); },
  };

  /* ── live adapter ──────────────────────────────────────────────────────
     Real transport to /api/v1/*. Reads map the contract → the dashboard view
     model (see mapModel). Anything the contract does not yet provide is marked
     TODO(server) here and listed in API.md so the backend can be extended.
   */
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
    agentConfig: () => req('GET', '/agent/config'),
    runReport: (id) => req('GET', '/runs/' + encodeURIComponent(id) + '/report'),
    turns: (id) => req('GET', '/runs/' + encodeURIComponent(id) + '/turns'),
    /* Multi-agent coordination audit tail: one bounded request per dashboard load; the
       JSONL ledger it reads is the same artifact the engine writes (read-only tail, cap 1000).
     */
    coordinationEvents: () => req('GET', '/coordination-events?limit=1000'),
  };

  const live = {
    /* Composes the whole dashboard model from the control API. For a fleet of a
       few apps this fan-out is cheap; lazily-load per view later if it grows.
     */
    async loadAll() {
      const [apps, queue, signals, coordination, agentConfig] = await Promise.all([
        ep.listApps(), ep.queue(), ep.signals().catch(() => null), ep.coordinationEvents().catch(() => null), ep.agentConfig().catch(() => null),
      ]);
      const names = apps.map((a) => a.name);
      const perApp = await Promise.all(names.map((n) => Promise.all([
        ep.listRuns(n, 20).catch(() => []),
        ep.trends(n).catch(() => null),
        ep.intelligence(n).catch(() => null),
        ep.report(n).catch(() => null),
      ])));
      const runsByApp = {}, trendsByApp = {}, intelByApp = {}, reportsByApp = {};
      names.forEach((n, i) => { runsByApp[n] = perApp[i][0]; trendsByApp[n] = perApp[i][1]; intelByApp[n] = perApp[i][2]; reportsByApp[n] = perApp[i][3]; });
      let runningRecord = null;
      if (queue && queue.running && queue.running.id) {
        const fromApp = (runsByApp[queue.running.app] || []).find((r) => r.id === queue.running.id);
        runningRecord = fromApp || await ep.getRun(queue.running.id).catch(() => null);
      }
      return mapModel({ apps, queue, signals, coordination, agentConfig, runsByApp, trendsByApp, intelByApp, reportsByApp, runningRecord });
    },
    /* SSE live feed → normalized handlers the UI applies. Maps the 15 RunEventBody
       variants onto {onStep,onPlan,onCase,onLog,onVerdict}.
     */
    /* SSE live feed → normalized handlers the UI applies. Maps the 15 RunEventBody
       variants onto {onStep,onPlan,onCase,onLog,onVerdict}. Transport is a fetch stream,
       not EventSource: the control plane is Bearer-authed and EventSource cannot send an
       Authorization header, so every stream 401'd and the live view froze. Runs on the
       same Last-Event-ID resumable protocol the server already ships (replay from seq).
     */
    subscribeRun(runId, h) {
      h = h || {};
      const ctrl = new AbortController();
      let lastSeq = null;
      let sawTerminal = false;
      const handleMessage = (ev) => {
        const b = ev && ev.body ? ev.body : ev; if (!b || !b.type) return;
        if (typeof ev === 'object' && ev !== null && typeof ev.seq === 'number') lastSeq = ev.seq;
        if (b.type === 'run.verdict') sawTerminal = true;
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
          default: break; /* run.started / agent.activity / spec.written / test.discovered / reviewer.verdict / coverage.computed */
        }
      };
      const stream = async () => {
        try {
          const res = await fetch(API + '/runs/' + encodeURIComponent(runId) + '/events', {
            headers: headers(),
            credentials: 'include',
            signal: ctrl.signal,
          });
          if (res.status === 401) {
            if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('qayaba_token');
            window.location.hash = '#login';
            throw new Error('Authentication required');
          }
          if (!res.ok || !res.body) { h.onError && h.onError(); return; }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
              /* SSE frame data: one JSON object per line(s) after a "data:" prefix */
              const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'));
              if (!dataLines.length) continue;
              const payload = dataLines.map((l) => l.slice(5).trim()).join('\n');
              let ev; try { ev = JSON.parse(payload); } catch (e) { continue; }
              handleMessage(ev);
            }
          }
          /* Stream ended: the server closes on run.verdict (terminal — do NOT reconnect, else
             the resubscribe loop hammers a finished run) or on a dropped connection mid-run
             (retry resumably via the Last-Event-ID replay the durable poll already ships). */
          if (sawTerminal) return;
          if (lastSeq != null) await new Promise((r) => setTimeout(r, 1000));
          if (!ctrl.signal.aborted) return stream();
        } catch (err) {
          if (ctrl.signal.aborted) return;
          h.onError && h.onError();
          /* transient network drop — resume through the durable poll (Last-Event-ID replay) */
          await new Promise((r) => setTimeout(r, 2000));
          if (!ctrl.signal.aborted) return stream();
        }
      };
      /* send the resume point from the start so a RE-subscribe never loses events */
      const headers = function () {
        const h2 = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
        if (lastSeq != null) h2['Last-Event-ID'] = String(lastSeq);
        const t = cfg.token || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('qayaba_token') : null);
        if (t) h2.Authorization = 'Bearer ' + t;
        return h2;
      };
      stream();
      return () => ctrl.abort();
    },
    ask(runId, question) { return ep && req('POST', '/runs/' + encodeURIComponent(runId) + '/ask', { question: question }).then((r) => (r && r.answer) || null); },
    createRun(input) { return req('POST', '/runs', {
      app: input.app,
      mode: input.mode,
      sha: input.sha || undefined,
      target: input.target || 'e2e',
      commits: input.commits || undefined,
      guidance: input.guidance || undefined,
    }); },
    cancelRun(id) { return req('DELETE', '/runs/' + encodeURIComponent(id)); },
    /* Human-in-the-loop continuation: re-run fixing the parent's failed cases (server caps the
       chain depth). Body {} = all failed cases; `cases` narrows; `guidance` nudges generation. */
    continueRun(id, input) {
      input = input || {};
      return req('POST', '/runs/' + encodeURIComponent(id) + '/continue', {
        cases: input.cases && input.cases.length ? input.cases : undefined,
        guidance: input.guidance || undefined,
      });
    },
    /* Run-scoped post-run summary: {current: ReportView, evolution: ReportView|null}. */
    runReport(id) { return ep.runReport(id); },
    /* Chronological agent turns (role, round, prompt/output, tokens) for one run. */
    turns(id) { return ep.turns(id); },
  };

  function logGlyph(level) { return level === 'error' ? '✗' : level === 'warn' ? '~' : level === 'ok' ? '✓' : '›'; }

  /* Map the /api/v1 contract responses onto the dashboard's internal view model.
     Implemented for the fields the contract clearly provides; everything else is
     flagged TODO(server) and itemised in API.md.
   */
  function mapModel(raw) {
    const m = (window.QayabaMockData) || {};
    const apps = raw.apps.map((a) => ({
      name: a.name, repo: a.repo, stack: '', /* TODO(server): AppView has no `stack` label */
      shadow: a.shadow, watching: true,
      baseBranch: 'main', devUrl: a.baseUrl, target: a.code ? 'code' : 'e2e',
      status: a.shadow ? 'shadow' : a.code ? 'code-mode' : 'live',
      /* TODO(server): vmix, value, coverage, reviewerPass, errClasses, trend come from /apps/:name/trends + /intelligence */
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
    /* Coordination workforce: attach to every run the events describe. Producer comes from the
       run's outcome (the authoritative boundary), the rest from its delegation samples.
     */
    const coordinationEvents = (raw.coordination && raw.coordination.events)
      || (window.QayabaMockData && window.QayabaMockData.coordinationEvents) || [];
    const coordByRun = {};
    coordinationEvents.forEach((e) => { (coordByRun[e.runId] = coordByRun[e.runId] || []).push(e); });
    runs.forEach((r) => { r.workforce = deriveWorkforce(coordByRun[r.id]); });
    const runningRef = raw.queue && raw.queue.running;
    const rawRunning = raw.runningRecord
      || (runningRef && (raw.runsByApp[runningRef.app] || []).find((r) => r.id === runningRef.id))
      || null;
    /* __live marks the mapped record as the REAL in-flight run: the live detail view must
       stay off the mock simulation (mock path never reaches mapModel).
     */
    const mappedRunning = rawRunning ? Object.assign(mapRun(rawRunning), { __live: true }) : null;
    const F = window.QayabaFormat || {};
    const running = F.mergeLiveRun
      ? F.mergeLiveRun(mappedRunning, m.running)
      : mappedRunning;
    /* Fleet 7d rollups derived from the per-app run feeds already fetched (each feed is the
       most recent 20 runs, so the window covers whatever of the last 7d those feeds reach).
       openIssues has no endpoint yet — keeps the mock value.
    */
    const allRuns = [];
    Object.keys(raw.runsByApp).forEach((a) => (raw.runsByApp[a] || []).forEach((r) => allRuns.push(r)));
    const weekRuns = allRuns.filter((r) => (Date.parse(r.at) || 0) >= Date.now() - 7 * 86400000);
    const finishedRuns = weekRuns.filter((r) => ['pass', 'fail', 'flaky', 'infra-error'].indexOf(r.verdict) >= 0);
    const stats = weekRuns.length ? Object.assign({}, m.stats, {
      runs7d: weekRuns.length,
      passRate: finishedRuns.length ? weekRuns.filter((r) => r.verdict === 'pass').length / finishedRuns.length : m.stats.passRate,
      specsAdded: weekRuns.reduce((s, r) => s + (r.specs || []).length, 0),
      watching: raw.apps.length,
    }) : m.stats;
    const VERDICTS = ['pass', 'fail', 'flaky', 'infra-error', 'skipped'];
    const verdictMix = weekRuns.length
      ? VERDICTS.map((v) => ({ v: v, n: weekRuns.filter((r) => (r.verdict || 'running') === v).length })).filter((x) => x.n > 0)
      : m.verdictMix;
    /* Reports: the first app whose /report returns insights replaces the mock exec blocks —
       headline/detail/weight come from the contract; viz renders honestly (see console.js).
       Templates stay client-side presets (API.md §6: "✗ new (or keep client-side presets)").
    */
    let liveInsights = null;
    Object.keys(raw.reportsByApp || {}).some((a) => {
      const rv = raw.reportsByApp[a];
      if (!rv || !rv.insights || !rv.insights.length) return false;
      liveInsights = rv.insights.map((ins) => ({
        real: true,
        metric: ins.id,
        shape: ins.chart === 'gauge' ? 'gauge'
          : (ins.chart === 'ranked-bars' || ins.chart === 'paired-bars' || ins.chart === 'stacked-bar' || ins.chart === 'donut') ? 'bars'
          : (ins.chart === 'line' || ins.chart === 'area') ? 'sparkline'
          : (ins.chart === 'big-number' && ins.multiplier != null) ? 'multiplier' : 'note',
        headline: ins.title,
        detail: ins.caption || (ins.value == null ? ins.title
          : 'current ' + (Math.round(ins.value * 1000) / 1000) + (ins.unit === 'percent' ? '%' : ins.unit === 'ratio' ? '' : ' ' + (ins.unit || ''))
            + (ins.delta == null ? '' : ' (' + (ins.delta > 0 ? '+' : '') + (Math.round(ins.delta * 1000) / 1000) + ')')),
        weight: ins.score == null ? 0 : ins.score,
      }));
      return true;
    });
    const reports = Object.assign({}, m.reports, liveInsights ? { insights: liveInsights } : {});
    return {
      models: raw.agentConfig && raw.agentConfig.assignments ? {
        generator: raw.agentConfig.assignments.primary.model,
        reviewer: raw.agentConfig.assignments.reviewer.model,
        chat: raw.agentConfig.assignments.chat.model,
      } : m.models,
      apps: apps,
      running: running,
      runs: runs,
      stats: stats,
      live: mapLive(raw.queue), /* partial; health/sessions/mirrors/webhook need an engine-status endpoint */
      verdictMix: verdictMix,
      signals: mapSignals(raw.signals) || m.signals, /* see API.md: SignalsView is leaner than the hero needs */
      coordination: {
        byRun: coordByRun,
        signals: (raw.signals && raw.signals.coordination) || (window.QayabaMockData && window.QayabaMockData.coordinationSignals) || null,
      },
      fleetErrorClasses: m.fleetErrorClasses, /* TODO(server): fleet-wide ErrorClass rollup */
      flywheel: m.flywheel,     /* TODO(server): learning flywheel counters */
      gates: m.gates,           /* TODO(server): 4-layer quality-gate effectiveness */
      histories: m.histories,   /* TODO(server): per-app health history (per-run checkpoints) */
      suite: m.suite,           /* TODO(server): committed suite per app */
      engram: m.engram,         /* TODO(server): per-app episodic memory */
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
      },   /* TODO(server): suite-health/trust rollup */
      reports: reports,         /* insights from /apps/:name/report (first app with data); templates stay client-side presets */
      modes: m.modes, rules: m.rules, trend: m.trend,
    };
  }
  function mapRun(r) {
    /* Runs still in flight carry no verdict — map them to 'running' so the fleet list renders
       a live tag instead of an empty verdict cell that reads like a cancelled run.
     */
    const statusVerdict = !r.verdict && r.status === 'running' ? 'running' : r.verdict;
    const cases = (r.cases || []).map((c) => ({
      name: c.name,
      s: c.status === 'pass' ? 'pass' : c.status === 'running' ? 'running' : (c.status || '').toLowerCase() === 'flaky' ? 'fail' : 'fail',
      ms: c.durationMs,
    }));
    return {
      id: r.id, app: r.app, sha: r.sha, verdict: statusVerdict, mode: r.mode,
      message: r.note || r.step || '', author: '', time: relTime(r.at), _at: Date.parse(r.at) || 0,
      mins: mapRunElapsed(r.stepStartedAt || r.startedAt || r.at), _step: r.step || '',
      specs: (r.specs || []).length, reviewer: '—', decision: r.note || '',
      branch: r.ref || 'DEV', duration: '', coverage: '—', oracle: '—',
      stages: pipelineStageStates(r.step), cases: cases, step: r.step || '',
      changed: [], newSpecs: (r.specs || []).map((s) => ({ file: s.name, status: r.verdict, n: 1 })),
      log: (r.logs || []).map((l) => ['›', l]),
    };
  }
  /* Canonical stage order — real RunRecords expose only the CURRENT step; progress renders by
     position (mirrors the engine's own run flow order). 'step' strings vary; aliases normalize.
   */
  const PIPELINE_STAGES = ['classify', 'setup', 'generate', 'validate', 'execute', 'decide'];
  function pipelineStageStates(currentStep) {
    const normalized = String(currentStep || '').toLowerCase();
    const idx = PIPELINE_STAGES.indexOf(normalized);
    const cur = idx >= 0 ? idx : (currentStep ? PIPELINE_STAGES.length - 1 : -1);
    return PIPELINE_STAGES.map((n, i) => [n, cur < 0 ? 'pending' : (i < cur ? 'done' : i === cur ? 'active' : 'pending')]);
  }
  function mapRunElapsed(at) {
    const t = Date.parse(at); return t ? Math.round((Date.now() - t) / 1000) : 0;
  }
  /* Derive the run's workforce from its coordination events. Absent events → null (pre-coordination
     runs, or a run whose router chose direct without delegating). producer: sidekick only when the
     outcome says delegate — a sidekick whose result was rejected falls back to lead, honestly.
   */
  function deriveWorkforce(events) {
    if (!events || !events.length) return null;
    let producer = 'lead';
    let delegations = 0, repairs = 0, failures = 0, lastMs = null;
    const times = [];
    events.forEach((e) => {
      if (e.kind === 'outcome' && e.action === 'delegate') producer = 'sidekick';
      if (e.kind === 'delegation') {
        delegations++;
        if (typeof e.durationMs === 'number') times.push(e.durationMs);
        if (String(e.delegationId || '').indexOf('fix-loop') >= 0) repairs++;
        if (/status=failed/.test(String(e.reason || ''))) failures++;
      }
    });
    if (!delegations && producer === 'lead') return null;
    const avgMs = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
    return { producer: producer, delegations: delegations, repairs: repairs, failures: failures, avgMs: avgMs };
  }
  function mapLive(queue) {
    const m = (window.QayabaMockData && window.QayabaMockData.live) || {};
    return Object.assign({}, m, { queue: { running: queue && queue.running ? 1 : 0, queued: (queue && queue.pending) || 0 } });
  }
  function mapSignals(s) {
    if (!s) return null;
    /* SignalsView → the hero's six KPI tiles. prev/series/suitesGreen/prsAutoMerged/issuesOpen
       are NOT in SignalsView today → see API.md "Overview gap".
     */
    const vo = s.valueOracle || {};
    const rp = s.reviewer || {};
    const co = s.coordination || null;
    const mock = (window.QayabaMockData && window.QayabaMockData.signals) || {};
    const score = vo.avgScore;
    const passRate = rp.passRate;
    return Object.assign({}, mock, {
      valueOracle: { v: score == null ? null : score, prev: score == null ? null : score, baseline: score == null ? null : score, series: score == null ? [] : [score] },
      reviewerPass: { v: passRate == null ? null : passRate, prev: passRate == null ? null : passRate, series: passRate == null ? [] : [passRate] },
      runs: { measured: vo.measuredRuns || 0, total: vo.totalRuns || 0, prevMeasured: vo.measuredRuns || 0, prevTotal: vo.totalRuns || 0, series: [vo.measuredRuns || 0] },
      coordination: co,
      suitesGreen: mock.suitesGreen || { v: 0, total: 0, prev: 0, series: [0] },
      prsAutoMerged: mock.prsAutoMerged || { v: 0, prev: 0, series: [0] },
      issuesOpen: mock.issuesOpen || { v: 0, prev: 0, series: [0] },
      window: mock.window || 'last 7d',
      prevWindow: mock.prevWindow || 'previous 7d',
    });
  }
  function mapLedger(intelByApp) {
    const rules = [];
    const arch = {};
    Object.keys(intelByApp || {}).forEach((app) => {
      const iv = intelByApp[app]; if (!iv || !iv.rules) return;
      iv.rules.forEach((r, i) => rules.push({
        id: 'R-' + app.slice(0, 2) + i, status: r.status === 'medium' ? 'active' : r.status,
        trigger: r.trigger, action: r.action, errorClass: r.errorClass,
        confidence: r.confidence === 'medium' ? 'med' : r.confidence,
        usage: r.usageCount, outcomes: r.outcomeCount, success: r.successRate,
      }));
      ((iv.curriculum && iv.curriculum.archetypes) || []).forEach((a) => {
        const slot = arch[a.archetype] || (arch[a.archetype] = { name: a.archetype, caughtRealBug: false, promotions: 0 });
        slot.promotions += a.promotionCount || 0;
        if (a.caughtRealBug) slot.caughtRealBug = true;
      });
    });
    if (!rules.length && !Object.keys(arch).length) return null;
    /* Governance audit log has no endpoint yet (API.md §6) — empty, never fake. */
    return { rules: rules, archetypes: Object.keys(arch).map((k) => arch[k]), audit: [] };
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
