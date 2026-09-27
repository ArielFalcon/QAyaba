/* ═══════════════════════════════════════════════════════════════════════
   Qayaba Console — data layer (the ONE seam between UI and backend).
   console.js never fetches; it asks window.QayabaConsole.api for data. Two
   adapters implement the same interface:
   • mock — returns window.QayabaMockData; runs the live-run + chat
   simulations locally. Zero backend. Default.
   • live — talks to the ai-pipeline orchestrator over /api/v1/* (same
   origin, Bearer/credentials) and the SSE live feed. Mirrors
   @qayaba/sdk's createClient() method-for-method, so a future
   swap to the real SDK is mechanical.
   Configure by setting window.QAYABA_CONSOLE_CONFIG before this script loads:
   window.QAYABA_CONSOLE_CONFIG = { mode:'live', baseUrl:'', token:null, landingUrl:'/' }
   Interface consumed by console.js:
   api.loadAll() → Promise<ViewModel> (the whole dashboard model)
   api.subscribeRun(id, handlers) → unsubscribe()|null (null ⇒ UI self-simulates)
   api.ask(runId, question) → Promise<string|null> (null ⇒ UI uses canned answer)
   api.createRun({app,mode,sha}) → Promise<any>
   api.cancelRun(runId) → Promise<any>
   QayabaConsole.onAuthRequired(fn) → fn() runs whenever the server answers 401 (session gone)
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
  /* A 401 means the operator's session is gone: forget the token (so no later request keeps
     sending it) and tell whoever shows the login prompt. */
  const authListeners = [];
  function onAuthRequired(fn) { authListeners.push(fn); }
  function authLost() {
    cfg.token = null;
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('qayaba_token');
    authListeners.forEach((fn) => { try { fn(); } catch (e) { /* a listener must not break the caller */ } });
  }
  /* err.status is the HTTP status; err.reason the server's own explanation ({error} body), when
     it sent one — what an operator should read when an action is refused. */
  function httpError(message, status, reason) {
    const err = new Error(message);
    err.status = status;
    if (reason) err.reason = reason;
    return err;
  }
  function serverReason(r) {
    return r.text().then(
      (text) => { try { const body = JSON.parse(text); return body && typeof body.error === 'string' ? body.error : null; } catch (e) { return null; } },
      () => null,
    );
  }
  function req(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: headers(),
      credentials: 'include',
      body: body == null ? undefined : JSON.stringify(body),
    }).then((r) => {
      if (r.status === 401) {
        authLost();
        throw httpError('Authentication required', 401);
      }
      if (!r.ok) return serverReason(r).then((reason) => { throw httpError(method + ' ' + path + ' → ' + r.status, r.status, reason); });
      return r.status === 204 ? null : r.json();
    });
  }
  const ep = {
    version: () => req('GET', '/version'),
    /* Liveness of the orchestrator process ({ok, openSessions}) — the only engine status the API
       serves today (API.md §1); the console claims "operational" only when this answers ok. */
    health: () => req('GET', '/health'),
    signals: () => req('GET', '/signals'),
    queue: () => req('GET', '/queue'),
    listApps: () => req('GET', '/apps'),
    getApp: (name) => req('GET', '/apps/' + encodeURIComponent(name)),
    listRuns: (app, limit) => req('GET', '/runs?app=' + encodeURIComponent(app) + '&limit=' + (limit || 20)),
    getRun: (id) => req('GET', '/runs/' + encodeURIComponent(id)),
    trends: (app) => req('GET', '/apps/' + encodeURIComponent(app) + '/trends'),
    intelligence: (app) => req('GET', '/apps/' + encodeURIComponent(app) + '/intelligence'),
    /* FE<->BE architecture map persisted from the app's last successful mode:context run.
       404 (no stored map yet) surfaces as a rejected promise, same as trends/intelligence/report
       when unavailable — callers `.catch(() => null)` it. */
    contextMap: (app) => req('GET', '/apps/' + encodeURIComponent(app) + '/context-map'),
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
      const [apps, queue, signals, coordination, agentConfig, health] = await Promise.all([
        ep.listApps(), ep.queue(), ep.signals().catch(() => null), ep.coordinationEvents().catch(() => null), ep.agentConfig().catch(() => null),
        ep.health().catch(() => null),
      ]);
      const names = apps.map((a) => a.name);
      const perApp = await Promise.all(names.map((n) => Promise.all([
        ep.listRuns(n, 20).catch(() => []),
        ep.trends(n).catch(() => null),
        ep.intelligence(n).catch(() => null),
        ep.report(n).catch(() => null),
        ep.contextMap(n).catch(() => null),
      ])));
      const runsByApp = {}, trendsByApp = {}, intelByApp = {}, reportsByApp = {}, contextMapByApp = {};
      names.forEach((n, i) => { runsByApp[n] = perApp[i][0]; trendsByApp[n] = perApp[i][1]; intelByApp[n] = perApp[i][2]; reportsByApp[n] = perApp[i][3]; contextMapByApp[n] = perApp[i][4]; });
      let runningRecord = null;
      if (queue && queue.running && queue.running.id) {
        const fromApp = (runsByApp[queue.running.app] || []).find((r) => r.id === queue.running.id);
        runningRecord = fromApp || await ep.getRun(queue.running.id).catch(() => null);
      }
      return mapModel({ apps, queue, health, signals, coordination, agentConfig, runsByApp, trendsByApp, intelByApp, reportsByApp, contextMapByApp, runningRecord });
    },
    /* SSE live feed → normalized handlers the UI applies. Maps the 15 RunEventBody
       variants onto {onStep,onPlan,onCase,onLog,onVerdict}. Transport is a fetch stream,
       not EventSource: the control plane is Bearer-authed and EventSource cannot send an
       Authorization header, so every stream 401'd and the live view froze. Runs on the
       same Last-Event-ID resumable protocol the server already ships (replay from seq).
     */
    subscribeRun(runId, h) {
      h = h || {};
      const ctrl = new AbortController();
      const BASE_DELAY = 1000;
      const MAX_DELAY = 30000;
      /* Backstop for when the run's record cannot be read after a clean close: a few clean,
         zero-byte closes in a row mean there is nothing left to stream. */
      const MAX_EMPTY_CLOSES = 3;
      let lastSeq = null;
      let retryDelay = BASE_DELAY;
      let emptyCloses = 0;
      const following = () => !ctrl.signal.aborted;
      /* Abortable wait: unsubscribing ends a pending backoff at once instead of leaving a timer behind. */
      const wait = (ms) => new Promise((resolve) => {
        if (ctrl.signal.aborted) return resolve();
        const done = () => { clearTimeout(timer); ctrl.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms);
        ctrl.signal.addEventListener('abort', done);
      });
      const backoff = () => {
        const delay = retryDelay;
        retryDelay = window.QayabaFormat.nextSseRetryDelay(retryDelay, MAX_DELAY);
        return wait(delay);
      };
      const handleMessage = (ev) => {
        const b = ev && ev.body ? ev.body : ev; if (!b || !b.type) return false;
        if (typeof ev === 'object' && ev !== null && typeof ev.seq === 'number') lastSeq = ev.seq;
        switch (b.type) {
          case 'step.changed': h.onStep && h.onStep(b.step, b.detail); break;
          case 'plan.updated': h.onPlan && h.onPlan(b.todos); break;
          case 'test.started': h.onCase && h.onCase(b.name, 'running'); break;
          case 'test.passed': h.onCase && h.onCase(b.name, 'pass', b.durationMs); break;
          case 'test.failed': h.onCase && h.onCase(b.name, 'fail', b.durationMs, b.detail); break;
          case 'test.flaky': h.onCase && h.onCase(b.name, 'flaky'); break;
          case 'log.line': h.onLog && h.onLog(logGlyph(b.level), b.text); break;
          case 'run.verdict': h.onVerdict && h.onVerdict(b.verdict, b); return true;
          case 'agent.error': h.onLog && h.onLog('!', b.detail); break;
          default: break; /* run.started / agent.activity / spec.written / test.discovered / reviewer.verdict / coverage.computed */
        }
        return false;
      };
      /* Reads one connection to its end. Returns 'verdict' (the run finished on this stream),
         'closed' (the server closed it cleanly) or 'dropped' (it broke mid-flight), and whether
         any byte arrived. Stops reading as soon as the verdict lands, so the connection is
         released even when the server keeps it open. */
      const readStream = async (body) => {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let sawBytes = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return { end: 'closed', sawBytes: sawBytes };
            if (value && value.length) sawBytes = true;
            buf += decoder.decode(value, { stream: true }).replace(/\r/g, '');
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
              /* SSE frame data: one JSON object per line(s) after a "data:" prefix */
              const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'));
              if (!dataLines.length) continue;
              const payload = dataLines.map((l) => l.slice(5).trim()).join('\n');
              let ev; try { ev = JSON.parse(payload); } catch (e) { continue; }
              if (handleMessage(ev)) return { end: 'verdict', sawBytes: true };
            }
          }
        } catch (err) {
          return { end: 'dropped', sawBytes: sawBytes };
        } finally {
          /* cancel() settles with a rejection when the stream already errored (an abort) — swallow it. */
          try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (e) { /* already released */ }
        }
      };
      /* After a clean close without a verdict the server has nothing more to replay: either a
         proxy dropped an idle connection mid-run, or the run is over and its verdict was never
         streamed (cancelled while enqueued, interrupted by a restart). The run record says which. */
      const readRecord = () => ep.getRun(runId).then(
        (record) => ({ record: record }),
        (err) => ({ status: err && err.status }),
      );
      /* Follow policy, the same guards as @qayaba/sdk's streamRunEvents:
         - every reconnect waits first (bounded exponential backoff, reset once bytes flow), so a
           server that closes instantly can never be hammered in a loop;
         - 401/403/404 are final — the session is gone, access is refused, or the run does not exist;
         - a run.verdict ends the feed, and so does a clean close whose run record is done (the
           record's verdict is reported instead);
         - when the record cannot be read, a few clean zero-byte closes in a row end the feed.
         A live run is followed through any number of transient errors and idle closes. */
      const follow = async () => {
        while (following()) {
          let res;
          try {
            res = await fetch(API + '/runs/' + encodeURIComponent(runId) + '/events', {
              headers: streamHeaders(),
              credentials: 'include',
              signal: ctrl.signal,
            });
          } catch (err) {
            if (!following()) return;
            h.onError && h.onError();
            await backoff();
            continue;
          }
          if (res.status === 401) { authLost(); h.onError && h.onError(); return; }
          if (res.status === 403 || res.status === 404) { h.onError && h.onError(); return; }
          if (!res.ok || !res.body) { h.onError && h.onError(); await backoff(); continue; }
          const read = await readStream(res.body);
          if (read.end === 'verdict' || !following()) return;
          if (read.sawBytes) { retryDelay = BASE_DELAY; emptyCloses = 0; }
          if (read.end === 'closed') {
            const found = await readRecord();
            if (!following()) return;
            if (found.status === 401 || found.status === 403 || found.status === 404) { h.onError && h.onError(); return; }
            const record = found.record;
            if (record && record.status === 'done') {
              if (record.verdict && h.onVerdict) h.onVerdict(record.verdict, { type: 'run.verdict', verdict: record.verdict, outcome: record.note });
              return;
            }
            if (!record && !read.sawBytes && ++emptyCloses >= MAX_EMPTY_CLOSES) return;
          }
          await backoff();
        }
      };
      /* send the resume point from the start so a RE-subscribe never loses events */
      const streamHeaders = function () {
        const h2 = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
        if (lastSeq != null) h2['Last-Event-ID'] = String(lastSeq);
        const t = cfg.token || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('qayaba_token') : null);
        if (t) h2.Authorization = 'Bearer ' + t;
        return h2;
      };
      follow();
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

  const QUALITY_VERDICTS = ['pass', 'fail', 'flaky', 'invalid'];
  function logGlyph(level) { return level === 'error' ? '✗' : level === 'warn' ? '~' : level === 'ok' ? '✓' : '›'; }

  /* Report templates are a UI preset (which blocks/schedule a report offers), not measured
     system data — API.md §6 explicitly allows keeping them client-side. Kept as a plain
     constant here (never window.QayabaMockData) so live mode shows this real feature without
     ever routing through the mock dataset.
   */
  const REPORT_TEMPLATES = [
    { id: 'exec', name: 'Executive value summary', desc: 'Ground-truth value and trust, period-over-period, for the team under test.', blocks: 5, schedule: 'weekly · Slack', channel: 'slack' },
    { id: 'health', name: 'Suite-health deep-dive', desc: 'Flakiness, infra vs code, gate effectiveness and determinism.', blocks: 6, schedule: 'on-demand', channel: 'email' },
  ];
  /* Honest empty integrity rollup — there is no /api/v1/integrity endpoint yet (API.md §6),
     so live mode always reports every figure unavailable rather than a fabricated zero.
   */
  function emptyIntegrity() {
    return {
      flakyRate: { v: null, prev: null, series: [] },
      infraErrorRate: { v: null, prev: null, series: [] },
      invalidRate: { v: null, prev: null, series: [] },
      timeToGreen: { v: null, prev: null },
      determinism: null,
      phases: [],
      gates: {
        enforceHeld: { v: null, desc: 'PRs blocked by the coverage-gate (enforce)' },
        regenRecovered: { v: null, desc: 'runs where regeneration recovered coverage' },
        staticRejected: { v: null, desc: 'invalid specs caught by the static gate' },
      },
    };
  }

  /* Map the /api/v1 contract responses onto the dashboard's internal view model.
     Implemented for the fields the contract clearly provides; everything else is
     flagged TODO(server) and itemised in API.md.
   */
  function mapModel(raw) {
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
      /* Stored FE<->BE architecture map (Batch F). null when the app has never completed a
         mode:context run — the console renders that as an honest empty state, never a mock map. */
      contextMap: (raw.contextMapByApp && raw.contextMapByApp[a.name]) || null,
    }));
    const runs = [].concat.apply([], raw.apps.map((a) => (raw.runsByApp[a.name] || []).map(mapRun)))
      .sort((x, y) => (y._at || 0) - (x._at || 0));
    /* Coordination workforce: attach to every run the events describe. Producer comes from the
       run's outcome (the authoritative boundary), the rest from its delegation samples.
     */
    const coordinationEvents = (raw.coordination && raw.coordination.events) || [];
    const coordByRun = {};
    coordinationEvents.forEach((e) => { (coordByRun[e.runId] = coordByRun[e.runId] || []).push(e); });
    runs.forEach((r) => { r.workforce = deriveWorkforce(coordByRun[r.id]); });
    const runningRef = raw.queue && raw.queue.running;
    const rawRunning = raw.runningRecord
      || (runningRef && (raw.runsByApp[runningRef.app] || []).find((r) => r.id === runningRef.id))
      || null;
    /* __live marks the mapped record as the REAL in-flight run: the live detail view must
       stay off the mock simulation (mock path never reaches mapModel). Never merge in the
       mock `running` record here — real runs render through viewLiveDetailReal, which reads
       only record fields, so a mock plan/currentTest/author would sit unused but would still
       be mock data presented as live if anything ever inspected it.
     */
    const mappedRunning = rawRunning ? Object.assign(mapRun(rawRunning), { __live: true }) : null;
    /* Fleet 7d rollups derived from the per-app run feeds already fetched (each feed is the
       most recent 20 runs, so the window covers whatever of the last 7d those feeds reach).
       openIssues has no fleet-wide endpoint yet (API.md §2) — reported honestly unavailable,
       never the mock demo count.
    */
    const allRuns = [];
    Object.keys(raw.runsByApp).forEach((a) => (raw.runsByApp[a] || []).forEach((r) => allRuns.push(r)));
    const weekRuns = allRuns.filter((r) => (Date.parse(r.at) || 0) >= Date.now() - 7 * 86400000);
    /* Same rule as the control API's signals view (src/server/signals-view.ts): the rate is taken
       over runs that produced a QUALITY verdict (pass/fail/flaky/invalid). skipped (a clean no-op)
       and infra-error (the environment, not the code) are left out. */
    const qualityRuns = weekRuns.filter((r) => QUALITY_VERDICTS.indexOf(r.verdict) >= 0);
    const stats = {
      runs7d: weekRuns.length,
      passRate: qualityRuns.length ? qualityRuns.filter((r) => r.verdict === 'pass').length / qualityRuns.length : null,
      specsAdded: weekRuns.reduce((s, r) => s + (r.specs || []).length, 0),
      openIssues: null,
      watching: raw.apps.length,
    };
    const VERDICTS = ['pass', 'fail', 'flaky', 'invalid', 'infra-error', 'skipped'];
    const verdictMix = VERDICTS.map((v) => ({ v: v, n: weekRuns.filter((r) => (r.verdict || 'running') === v).length })).filter((x) => x.n > 0);
    /* Reports: every app's /report insights, each attributed to its app (the console ranks them
       together by weight) — headline/detail/weight come from the contract; viz renders honestly
       (see console.js). Templates stay client-side presets (API.md §6: "✗ new (or keep client-side presets)").
    */
    const liveInsights = [];
    Object.keys(raw.reportsByApp || {}).forEach((a) => {
      const rv = raw.reportsByApp[a];
      if (!rv || !rv.insights) return;
      rv.insights.forEach((ins) => liveInsights.push({
        real: true,
        app: a,
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
    });
    const reports = { templates: REPORT_TEMPLATES, insights: liveInsights };
    return {
      models: raw.agentConfig && raw.agentConfig.assignments ? {
        generator: raw.agentConfig.assignments.primary.model,
        reviewer: raw.agentConfig.assignments.reviewer.model,
        chat: raw.agentConfig.assignments.chat.model,
      } : { generator: 'n/a', reviewer: 'n/a', chat: 'n/a' }, /* /agent/config unavailable — never the mock model ids */
      apps: apps,
      running: mappedRunning,
      runs: runs,
      stats: stats,
      live: mapLive(raw.queue, raw.health), /* partial; mirrors/webhook need an engine-status endpoint (API.md §1) */
      verdictMix: verdictMix,
      signals: mapSignals(raw.signals) || emptySignals(), /* see API.md: SignalsView is leaner than the hero needs */
      coordination: {
        byRun: coordByRun,
        signals: (raw.signals && raw.signals.coordination) || null,
      },
      fleetErrorClasses: [], /* TODO(server): fleet-wide ErrorClass rollup (API.md §1) */
      flywheel: [],          /* TODO(server): learning flywheel counters (API.md §6) */
      gates: [],             /* TODO(server): 4-layer quality-gate effectiveness (API.md §6) */
      histories: {},         /* TODO(server): per-app health history — per-run checkpoints (API.md §5) */
      suite: [],             /* TODO(server): committed suite per app (API.md §5) */
      engram: [],            /* TODO(server): per-app episodic memory (API.md §5) */
      ledger: mapLedger(raw.intelByApp) || { rules: [], archetypes: [], audit: [] },
      integrity: emptyIntegrity(), /* TODO(server): suite-health/trust rollup — no endpoint yet (API.md §6) */
      reports: reports,         /* insights from every app's /apps/:name/report; templates are client-side presets, never simulated data (API.md §6) */
      modes: [], rules: [], trend: { passRate: [], specs: [] }, /* unused by the current UI; kept honestly empty rather than the mock fleet trend */
    };
  }
  function mapRun(r) {
    /* Runs still in flight carry no verdict — map them to 'running' so the fleet list renders
       a live tag instead of an empty verdict cell that reads like a cancelled run.
     */
    const statusVerdict = !r.verdict && r.status === 'running' ? 'running' : r.verdict;
    const cases = (r.cases || []).map((c) => ({
      name: c.name,
      s: c.status === 'pass' ? 'pass' : c.status === 'running' ? 'running' : 'fail',
      ms: c.durationMs,
    }));
    return {
      id: r.id, app: r.app, sha: r.sha, verdict: statusVerdict, mode: r.mode,
      message: r.note || r.step || '', author: '', time: relTime(r.at), _at: Date.parse(r.at) || 0,
      /* elapsed since the run was created — the run's own clock, never its current step's */
      mins: mapRunElapsed(r.at), _step: r.step || '',
      specs: (r.specs || []).length, reviewer: '—', decision: r.note || '',
      /* A continuation re-runs the FAILED cases of a finished run — the server refuses anything else. */
      canContinue: r.status === 'done' && (r.cases || []).some((c) => c.status === 'fail'),
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
    let delegations = 0, repairs = 0, failures = 0;
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
  function mapLive(queue, health) {
    /* Queue counts and the process health check ({ok, openSessions}) are real; the health-poller
       cadence, last mirror-prune and webhook status are not in the contract yet (API.md §1) —
       reported honestly unavailable. No health answer → status unknown, never "operational".
     */
    const ok = health ? health.ok === true : null;
    return {
      status: ok === true ? 'operational' : ok === false ? 'degraded' : null,
      health: { ok: ok, last: null, interval: null },
      sessions: health && typeof health.openSessions === 'number' ? health.openSessions : null,
      mirrors: null,
      webhook: null,
      queue: { running: queue && queue.running ? 1 : 0, queued: (queue && queue.pending) || 0 },
    };
  }
  /* Honest empty SignalsView shape — used when the /signals request fails outright, and as the
     base for the fields SignalsView does not carry yet (see mapSignals below).
   */
  function emptySignals() {
    return {
      valueOracle: { v: null, prev: null, baseline: null, series: [] },
      reviewerPass: { v: null, prev: null, series: [] },
      runs: { measured: 0, total: 0, prevMeasured: null, prevTotal: null, series: [] },
      coordination: null,
      suitesGreen: { v: null, prev: null, series: [] },
      prsAutoMerged: { v: null, prev: null, series: [] },
      issuesOpen: { v: null, prev: null, series: [] },
      window: null,
      prevWindow: null,
    };
  }
  function mapSignals(s) {
    if (!s) return null;
    /* SignalsView → the hero's six KPI tiles. prev/series/suitesGreen/prsAutoMerged/issuesOpen
       are NOT in SignalsView today → see API.md "Overview gap". Report them honestly
       unavailable instead of the mock demo numbers.
     */
    const vo = s.valueOracle || {};
    const rp = s.reviewer || {};
    const score = vo.avgScore;
    const passRate = rp.passRate;
    /* Current-window values only: there is no previous window or baseline to compare against, so
       prev/baseline stay null (the console then shows no change) — never the current value
       copied in, which rendered a fabricated "+0 pts" / "×1.0". */
    const base = emptySignals();
    base.valueOracle = { v: score == null ? null : score, prev: null, baseline: null, series: score == null ? [] : [score] };
    base.reviewerPass = { v: passRate == null ? null : passRate, prev: null, series: passRate == null ? [] : [passRate] };
    base.runs = { measured: vo.measuredRuns || 0, total: vo.totalRuns || 0, prevMeasured: null, prevTotal: null, series: [vo.measuredRuns || 0] };
    base.coordination = s.coordination || null;
    return base;
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

  return { config: cfg, api: cfg.mode === 'live' ? live : mock, onAuthRequired: onAuthRequired };
})();
