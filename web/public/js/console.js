/* ═══════════════════════════════════════════════════════════════════════
   qayaba console — vanilla render of the QA control panel.
   Mission-control Fleet, runs feed, run detail + the live run, app detail,
   integrity, learning, reports. Deep-linkable via ?run=<id> and #<section>.

   All data comes from window.QayabaConsole.api (see api.js). The UI never
   fetches directly; swap config.mode mock↔live to connect to the server.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  let D = null; // the view model; populated by api.loadAll() before first render
  const root = document.getElementById('app');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const refreshIcons = () => { try { window.lucide && lucide.createIcons(); } catch (e) {} };
  const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CFG = (window.QayabaConsole && window.QayabaConsole.config) || { mode: 'mock', landingUrl: '/' };
  const F = window.QayabaFormat || {
    fixed: function (n, d, e) { return (typeof n === 'number' && isFinite(n)) ? n.toFixed(d) : (e || 'n/a'); },
    multiplierLabel: function (c, p) { return (!p || typeof c !== 'number') ? 'n/a' : '×' + (c / p).toFixed(1); },
    uniqueAbbrevs: function (shas, min) { return (shas || []).map(function (s) { return String(s || '').slice(0, min || 7); }); },
    shortRepo: function (repo) {
      var s = String(repo == null ? '' : repo);
      var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
      return i >= 0 ? s.slice(i + 1).replace(/\.git$/, '') : s;
    },
    renderMarkdown: function (md) { return String(md == null ? '' : md).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); },
    pickChatAnswer: function (o) { return { text: o.apiAnswer || o.canned, kind: o.apiAnswer ? 'assistant' : 'canned' }; },
    triggerExtras: function (mode) {
      return { sha: mode === 'diff', delta: mode === 'diff', guidance: mode === 'manual' };
    },
    clampDiffCommits: function (n) {
      var v = parseInt(String(n), 10);
      if (!isFinite(v) || v < 1) return 1;
      return v > 20 ? 20 : v;
    },
    triggerPayload: function (input) {
      var extras = { sha: input.mode === 'diff', delta: input.mode === 'diff', guidance: input.mode === 'manual' };
      var body = { app: input.app, mode: input.mode };
      if (extras.sha && input.sha) body.sha = input.sha;
      if (extras.delta && input.commits > 1) body.commits = input.commits;
      if (extras.guidance && input.guidance) body.guidance = String(input.guidance).trim();
      return body;
    },
  };
  function liveRun() { return D && D.running ? D.running : null; }
  function refreshShaAbbrevs() {
    if (!D) return;
    const shas = (D.runs || []).map(function (r) { return r.sha; });
    if (D.running && D.running.sha) shas.push(D.running.sha);
    const abbr = F.uniqueAbbrevs(shas, 7);
    const map = Object.create(null);
    shas.forEach(function (s, i) { map[s] = abbr[i]; });
    D._shaAbbrev = map;
  }
  function shaOf(sha) {
    if (!sha) return '';
    return (D && D._shaAbbrev && D._shaAbbrev[sha]) || String(sha).slice(0, 7);
  }
  function runRepoLabel(r) {
    const app = (D.apps || []).find(function (a) { return a.name === r.app; });
    return F.shortRepo(app && app.repo) || r.app || '';
  }
  function runRepoTitle(r) {
    const app = (D.apps || []).find(function (a) { return a.name === r.app; });
    return (app && app.repo) || r.app || '';
  }
  function DevBadge() {
    return '<div class="dev-badge"><span class="dev-badge__tag">En desarrollo</span><span class="dev-badge__note">· datos mock · backend pendiente</span></div>';
  }
  const apiOf = () => (window.QayabaConsole && window.QayabaConsole.api) || null;
  // Asset URLs resolved relative to THIS script, so the dashboard works whether it
  // is served from the site root (standalone) or mounted at /app (ai-pipeline).
  const ASSET_BASE = (function () {
    try { return new URL('../assets/', (document.currentScript && document.currentScript.src) || location.href).href; }
    catch (e) { return 'assets/'; }
  })();
  const MARK = ASSET_BASE + 'qayaba-mark.svg';
  const MARK_LIGHT = ASSET_BASE + 'qayaba-mark-light.svg';

  /* ── inline-style helper (translates JSX style objects faithfully) ─────── */
  const UNITLESS = { opacity: 1, fontWeight: 1, zIndex: 1, lineHeight: 1, flex: 1, flexGrow: 1, flexShrink: 1, order: 1, strokeWidth: 1, fillOpacity: 1, animationDelay: 1 };
  function sty(o) {
    let s = '';
    for (const k in o) {
      let v = o[k];
      if (v == null || v === false) continue;
      const prop = k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
      if (typeof v === 'number' && !UNITLESS[k]) v = v + 'px';
      s += prop + ':' + v + ';';
    }
    return s;
  }
  // lucide icon, sized
  const I = (n, sz, st) => '<i data-lucide="' + n + '" style="width:' + (sz || 16) + 'px;height:' + (sz || 16) + 'px' + (st ? ';' + st : '') + '"></i>';

  /* ── color maps ────────────────────────────────────────────────────────── */
  const VERDICT_FILL = { pass: 'var(--pass-500)', fail: 'var(--fail-500)', flaky: 'var(--flaky-500)', 'infra-error': 'var(--infra-500)', skipped: 'var(--bone-400)', invalid: 'var(--ink-700)' };
  const STAGE_META = {
    done: { c: 'var(--pass-600)', bg: 'var(--pass-100)', ic: 'check' },
    fail: { c: 'var(--fail-600)', bg: 'var(--fail-100)', ic: 'x' },
    flaky: { c: 'var(--flaky-600)', bg: 'var(--flaky-100)', ic: 'rotate-cw' },
    infra: { c: 'var(--infra-600)', bg: 'var(--infra-100)', ic: 'unplug' },
    skip: { c: 'var(--ink-400)', bg: 'var(--skip-100)', ic: 'minus' },
    active: { c: 'var(--ember-600)', bg: 'var(--ember-100)', ic: 'loader' },
    pending: { c: 'var(--ink-400)', bg: 'transparent', ic: 'circle' },
  };
  const STATUS_META = {
    live: { c: 'var(--pass-600)', bg: 'var(--pass-100)', ic: 'radio', label: 'live' },
    shadow: { c: 'var(--ink-700)', bg: 'var(--skip-100)', ic: 'eye', label: 'shadow' },
    'code-mode': { c: 'var(--infra-600)', bg: 'var(--infra-100)', ic: 'terminal', label: 'code-mode' },
    idle: { c: 'var(--ink-400)', bg: 'var(--bone-200)', ic: 'pause', label: 'idle' },
  };
  const PHASE_COLORS = { classify: 'var(--ink-400)', generate: 'var(--ember-500)', validate: 'var(--flaky-500)', execute: 'var(--pass-500)', coverage: 'var(--infra-500)' };
  const LOG_COLOR = { '$': 'var(--bone-400)', '›': 'var(--bone-400)', '✓': '#7fcf9f', '✗': '#e8908a', '~': '#e4c06b', '!': '#8fb6c9', '·': 'var(--bone-500)' };

  /* ── number helpers ──────────────────────────────────────────────────── */
  const pctPts = (cur, prev) => Math.round((cur - prev) * 100);
  const mult = (cur, prev) => (prev ? cur / prev : null);
  const fmtMMSS = (sec) => Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's';
  const fmtDur = (sec) => (sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's');

  /* ═══ DESIGN-SYSTEM PRIMITIVES ═══════════════════════════════════════════ */
  function VerdictTag(verdict, o) {
    o = o || {};
    const label = o.label != null ? o.label : verdict;
    const cls = 'vtag pa-verdict ' + esc(verdict) + (o.sm ? ' vtag--sm' : '') + (o.dot === false ? ' vtag--nodot' : '');
    return '<span class="' + cls + '"><span class="dot"></span>' + esc(label) + '</span>';
  }
  function Button(o) {
    const v = o.variant || 'secondary';
    const cls = 'dbtn dbtn--' + v + (o.size === 'sm' ? ' dbtn--sm' : '') + (o.block ? ' dbtn--block' : '');
    const da = o.action ? ' data-action="' + o.action + '"' : '';
    const di = o.id ? ' data-id="' + esc(o.id) + '"' : '';
    const ds = o.stop ? ' data-stop="1"' : '';
    return '<button class="' + cls + '"' + da + di + ds + '>' + (o.leadingIcon ? I(o.leadingIcon, 16) : '') + esc(o.label) + '</button>';
  }
  function Card(o) {
    const flush = o.bodyPadding === false;
    const hasHead = o.eyebrow || o.title || o.action;
    const head = hasHead ? '<div class="dcard__head"><div>' +
      (o.eyebrow ? '<div class="dcard__eyebrow">' + esc(o.eyebrow) + '</div>' : '') +
      (o.title ? '<div class="dcard__title">' + esc(o.title) + '</div>' : '') +
      '</div>' + (o.action ? '<div>' + o.action + '</div>' : '') + '</div>' : '';
    const body = '<div class="dcard__body' + (flush ? ' dcard__body--flush' : '') + '">' + (o.children || '') + '</div>';
    const foot = o.footer ? '<div class="dcard__foot">' + o.footer + '</div>' : '';
    return '<div class="dcard' + (flush ? ' dcard--flush' : '') + '">' + head + body + foot + '</div>';
  }
  function Callout(o) {
    const tone = o.tone || 'note';
    const lbl = '<div class="callout__label" style="display:inline-flex;align-items:center;gap:6px">' + (o.icon ? I(o.icon, 13) : '') + esc(o.label) + '</div>';
    return '<div class="callout callout--' + tone + '">' + lbl + '<div class="callout__body">' + (o.children || '') + '</div></div>';
  }
  function Input(o) {
    const id = o.inputId ? ' id="' + esc(o.inputId) + '"' : '';
    return '<div style="display:flex;flex-direction:column;gap:6px"><span class="pa-eyebrow">' + esc(o.label) + '</span>' +
      '<div class="dinput">' + (o.leadingIcon ? I(o.leadingIcon, 15) : '') +
      '<input type="text"' + id + ' placeholder="' + esc(o.placeholder || '') + '" spellcheck="false"></div></div>';
  }
  function Tabs(o) {
    return '<div class="dtabs">' + o.tabs.map((t) =>
      '<button class="dtab' + (t.id === o.value ? ' is-on' : '') + '" data-action="' + o.action + '" data-id="' + t.id + '">' +
      (t.icon ? I(t.icon, 14) : '') + esc(t.label) +
      (t.count != null ? '<span class="dtab__count">' + t.count + '</span>' : '') + '</button>'
    ).join('') + '</div>';
  }

  /* ═══ SHARED PARTS ═══════════════════════════════════════════════════════ */
  function PulseDot(color, size) {
    color = color || 'var(--pass-500)'; size = size || 9;
    return '<span style="' + sty({ position: 'relative', display: 'inline-flex', width: size, height: size, flex: 'none' }) + '">' +
      '<span style="' + sty({ position: 'absolute', inset: 0, borderRadius: '50%', background: color, opacity: 0.45, animation: 'pa-pulse 1.6s var(--ease-out) infinite' }) + '"></span>' +
      '<span style="' + sty({ position: 'relative', width: size, height: size, borderRadius: '50%', background: color }) + '"></span></span>';
  }
  function StageStepper(stages) {
    return '<div style="display:flex;align-items:center;flex-wrap:wrap">' + stages.map(([name, status], i) => {
      const m = STAGE_META[status] || STAGE_META.skip;
      const active = status === 'active', pending = status === 'pending';
      const bc = pending ? 'var(--bone-300)' : 'color-mix(in oklab, ' + m.c + ' ' + (active ? '33%' : '14%') + ', transparent)';
      const box = '<div style="' + sty({ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 'var(--radius-xs)', background: m.bg, border: '1px solid ' + bc, opacity: pending ? 0.6 : 1 }) + '">' +
        '<span style="display:inline-flex;color:' + m.c + (active ? ';animation:pa-spin 1s linear infinite' : '') + '">' + I(m.ic, 13) + '</span>' +
        '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', color: m.c }) + '">' + esc(name) + '</span></div>';
      const sep = i < stages.length - 1 ? '<span style="width:16px;height:1px;background:var(--bone-300);margin:0 2px"></span>' : '';
      return box + sep;
    }).join('') + '</div>';
  }
  function MiniStepper(stages) {
    return '<div style="display:inline-flex;align-items:center;gap:3px">' + stages.map(([name, status]) => {
      const m = STAGE_META[status] || STAGE_META.skip;
      const active = status === 'active';
      const bg = active ? 'var(--ember-500)' : status === 'pending' ? 'var(--bone-300)' : m.c;
      return '<span title="' + esc(name) + '" style="width:7px;height:7px;border-radius:50%;background:' + bg + (active ? ';animation:pa-pulse 1.4s var(--ease-out) infinite' : '') + '"></span>';
    }).join('') + '</div>';
  }
  function Terminal(lines) {
    return '<div class="pa-dot-bg pa-ticks pa-ticks--ink" style="' + sty({ background: 'var(--ink-900)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-4)', border: '1px solid var(--ink-700)' }) + '">' +
      lines.map(([g, t]) => '<div style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.75, color: 'var(--bone-100)', whiteSpace: 'pre-wrap' }) + '">' +
        '<span style="color:' + (LOG_COLOR[g] || 'var(--bone-400)') + ';margin-right:10px">' + esc(g) + '</span>' + esc(t) + '</div>').join('') + '</div>';
  }
  function Stat(label, value, sub, accent) {
    return '<div style="display:flex;flex-direction:column;gap:4px">' +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }) + '">' + esc(label) + '</span>' +
      '<span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 30, letterSpacing: '-0.02em', color: accent || 'var(--text-strong)', lineHeight: 1 }) + '">' + esc(value) + '</span>' +
      (sub ? '<span style="font-size:12px;color:var(--text-muted)">' + esc(sub) + '</span>' : '') + '</div>';
  }
  function Sparkline(data, o) {
    o = o || {};
    if (!data || data.length === 0) return '<svg width="140" height="36" viewBox="0 0 140 36"></svg>';
    const w = o.w || 140, h = o.h || 36, color = o.color || 'var(--ember-500)', area = o.area !== false, pad = o.pad || 3, responsive = !!o.responsive;
    const min = Math.min.apply(null, data), max = Math.max.apply(null, data), span = (max - min) || 1, n = data.length;
    const x = (i) => pad + (i * (w - pad * 2)) / (n - 1);
    const y = (v) => pad + (h - pad * 2) * (1 - (v - min) / span);
    const pts = data.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    const areaPts = pad + ',' + (h - pad) + ' ' + pts + ' ' + (w - pad) + ',' + (h - pad);
    const lx = x(n - 1), ly = y(data[n - 1]);
    const svgStyle = responsive ? 'display:block;width:100%;height:' + h + 'px' : 'display:block;overflow:visible';
    return '<svg ' + (responsive ? '' : 'width="' + w + '" ') + 'height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="' + (responsive ? 'none' : 'xMidYMid meet') + '" style="' + svgStyle + '">' +
      (area ? '<polyline points="' + areaPts + '" fill="' + color + '" opacity="0.10" stroke="none" vector-effect="non-scaling-stroke"/>' : '') +
      '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
      (!responsive ? '<circle cx="' + lx + '" cy="' + ly + '" r="2.6" fill="' + color + '"/><circle cx="' + lx + '" cy="' + ly + '" r="5" fill="' + color + '" opacity="0.18"/>' : '') + '</svg>';
  }
  function VerdictBar(segments, height, gap) {
    height = height || 10; gap = gap == null ? 2 : gap;
    const total = segments.reduce((s, x) => s + x.n, 0) || 1;
    return '<div style="' + sty({ display: 'flex', gap: gap, width: '100%', height: height, borderRadius: 'var(--radius-xs)', overflow: 'hidden' }) + '">' +
      segments.filter((s) => s.n > 0).map((s) => '<div title="' + s.v + ' · ' + s.n + '" style="width:' + ((s.n / total) * 100) + '%;background:' + (VERDICT_FILL[s.v] || 'var(--bone-400)') + '"></div>').join('') + '</div>';
  }
  function VerdictDonut(segments, size, thickness) {
    size = size || 120; thickness = thickness || 13;
    const r = 42, C = 2 * Math.PI * r; let off = 0;
    const arcs = segments.filter((s) => s.n > 0).map((s) => {
      const total = segments.reduce((a, x) => a + x.n, 0) || 1;
      const len = (s.n / total) * C;
      const el = '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="' + (VERDICT_FILL[s.v] || 'var(--bone-400)') + '" stroke-width="' + thickness + '" stroke-dasharray="' + len.toFixed(1) + ' ' + (C - len).toFixed(1) + '" stroke-dashoffset="' + (-off).toFixed(1) + '"/>';
      off += len; return el;
    }).join('');
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 100 100"><g style="transform:rotate(-90deg);transform-origin:50px 50px">' +
      '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="var(--bone-200)" stroke-width="' + thickness + '"/>' + arcs + '</g></svg>';
  }
  function FlowNode(o) {
    return '<div style="' + sty({ display: 'flex', alignItems: 'stretch', flex: '1 1 0', minWidth: 0 }) + '">' +
      '<div style="' + sty({ display: 'flex', flexDirection: 'column', gap: 9, flex: 1, minWidth: 0, padding: '13px 13px 14px', border: 'var(--border-rule)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-page)' }) + '">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px">' +
      '<span style="' + sty({ display: 'inline-flex', width: 26, height: 26, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-xs)', background: 'var(--ember-100)', color: 'var(--ember-600)', flex: 'none' }) + '">' + I(o.icon, 15) + '</span>' +
      '<span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 21, letterSpacing: '-0.02em', color: 'var(--text-strong)', lineHeight: 1 }) + '">' + esc(o.stat) + '</span></div>' +
      '<div style="display:flex;flex-direction:column;gap:2px;min-width:0">' +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.01em', color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) + '">' + esc(o.label) + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:10.5px;color:var(--ember-600)">' + esc(o.unit) + '</span></div>' +
      '<span style="font-size:11px;color:var(--text-muted);line-height:1.35">' + esc(o.note) + '</span></div>' +
      (!o.last ? '<span style="flex:none;display:inline-flex;align-items:center;color:var(--bone-400);padding:0 2px">' + I('chevron-right', 15) + '</span>' : '') + '</div>';
  }
  function FigLabel(n, children) {
    return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700, color: 'var(--ember-600)' }) + '">FIG. ' + esc(n) + '</span>' +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }) + '">' + esc(children) + '</span>' +
      '<span style="flex:1;height:1px;background:var(--bone-300)"></span></div>';
  }
  function DeltaChip(dir, good, text, size) {
    const color = good == null ? 'var(--text-muted)' : good ? 'var(--pass-600)' : 'var(--fail-600)';
    const icn = dir === 'down' ? 'arrow-down' : dir === 'flat' ? 'minus' : 'arrow-up';
    const fs = size === 'sm' ? 10.5 : 11.5;
    return '<span style="' + sty({ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'var(--font-mono)', fontSize: fs, color: color, whiteSpace: 'nowrap' }) + '">' + I(icn, 12) + esc(text) + '</span>';
  }
  function KpiCard(o) {
    const big = o.big;
    return '<div' + (o.onClick ? ' data-action="' + o.onClick + '"' + (o.onId ? ' data-id="' + esc(o.onId) + '"' : '') : '') +
      ' style="' + sty({ padding: big ? '16px 18px' : '14px 16px', background: 'var(--surface-raised)', border: 'var(--border-rule)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: big ? 10 : 8, cursor: o.onClick ? 'pointer' : 'default', minWidth: 0 }) + '">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) + '">' + esc(o.label) + '</span>' +
      (o.deltaText != null ? DeltaChip(o.dir, o.good, o.deltaText, 'sm') : '') + '</div>' +
      '<div style="display:flex;align-items:baseline;gap:4px">' +
      '<span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: big ? 34 : 26, letterSpacing: '-0.02em', color: 'var(--text-strong)', lineHeight: 1 }) + '">' + esc(o.value) + '</span>' +
      (o.unit ? '<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">' + esc(o.unit) + '</span>' : '') + '</div>' +
      (o.series ? Sparkline(o.series, { w: 200, h: big ? 32 : 26, color: o.seriesColor || 'var(--ember-500)', responsive: true }) : '') +
      (o.sub ? '<span style="font-size:11px;color:var(--text-muted)">' + esc(o.sub) + '</span>' : '') + '</div>';
  }
  function CoverageGauge(ratio, min, size, reason) {
    min = min == null ? 0.7 : min; size = size || 132;
    const r = 42, C = 2 * Math.PI * r;
    if (ratio == null) {
      return '<div style="' + sty({ width: size, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }) + '">' +
        '<div style="' + sty({ position: 'relative', width: size, height: size }) + '">' +
        '<svg width="' + size + '" height="' + size + '" viewBox="0 0 100 100" style="transform:rotate(-90deg)">' +
        '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="var(--bone-300)" stroke-width="9" stroke-dasharray="4 7" stroke-linecap="round"/></svg>' +
        '<div style="' + sty({ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }) + '">' +
        I('help-circle', 22, 'color:var(--ink-400)') +
        '<span style="font-family:var(--font-mono);font-size:11px;font-weight:700;letter-spacing:0.04em;color:var(--ink-500)">unknown</span></div></div>' +
        '<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-faint);text-align:center;line-height:1.3">' + esc(reason || 'not measured') + '</span></div>';
    }
    const ok = ratio >= min, col = ok ? 'var(--pass-500)' : 'var(--fail-500)', arc = ratio * C;
    const ang = (-90 + min * 360) * Math.PI / 180;
    const tx1 = (50 + (r - 7) * Math.cos(ang)).toFixed(2), ty1 = (50 + (r - 7) * Math.sin(ang)).toFixed(2);
    const tx2 = (50 + (r + 7) * Math.cos(ang)).toFixed(2), ty2 = (50 + (r + 7) * Math.sin(ang)).toFixed(2);
    return '<div style="' + sty({ width: size, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }) + '">' +
      '<div style="' + sty({ position: 'relative', width: size, height: size }) + '">' +
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 100 100"><g style="transform:rotate(-90deg);transform-origin:50px 50px">' +
      '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="var(--bone-200)" stroke-width="9"/>' +
      '<circle class="pa-arc pa-gauge-arc" data-final="' + (C - arc).toFixed(1) + '" cx="50" cy="50" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + C.toFixed(1) + '"/></g>' +
      '<line x1="' + tx1 + '" y1="' + ty1 + '" x2="' + tx2 + '" y2="' + ty2 + '" stroke="var(--ink-900)" stroke-width="2"/></svg>' +
      '<div style="' + sty({ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }) + '">' +
      '<span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 26, letterSpacing: '-0.02em', color: 'var(--text-strong)', lineHeight: 1 }) + '">' + Math.round(ratio * 100) + '%</span>' +
      '<span style="display:inline-flex;align-items:center;gap:4px;font-family:var(--font-mono);font-size:9.5px;color:' + col + '">' + I(ok ? 'check' : 'x', 11) + (ok ? 'above' : 'below') + ' floor</span></div></div>' +
      '<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-faint)">min ratio ' + Math.round(min * 100) + '%</span></div>';
  }
  function StatusBadge(status, size) {
    const m = STATUS_META[status] || STATUS_META.idle;
    const fs = size === 'sm' ? 9.5 : 10.5;
    return '<span style="' + sty({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: size === 'sm' ? '2px 7px' : '3px 9px', borderRadius: 'var(--radius-xs)', border: '1px solid ' + m.c, background: m.bg, color: m.c, fontFamily: 'var(--font-mono)', fontSize: fs, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }) + '">' + I(m.ic, 11) + m.label + '</span>';
  }
  function ErrorClassBars(data, color) {
    color = color || 'var(--ink-700)';
    const sorted = data.slice().sort((a, b) => b[1] - a[1]);
    const max = Math.max.apply(null, sorted.map((d) => d[1]).concat([1]));
    return '<div style="display:flex;flex-direction:column;gap:9px">' + sorted.map(([cls, n]) =>
      '<div style="display:flex;align-items:center;gap:12px">' +
      '<span style="' + sty({ width: 120, flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-body)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) + '">' + esc(cls) + '</span>' +
      '<div style="flex:1;height:9px;background:var(--surface-sunken);border-radius:var(--radius-xs);overflow:hidden"><div style="width:' + ((n / max) * 100) + '%;height:100%;background:' + color + '"></div></div>' +
      '<span style="width:22px;text-align:right;flex:none;font-family:var(--font-mono);font-size:11.5px;color:var(--text-muted)">' + n + '</span></div>').join('') + '</div>';
  }
  function UnknownPanel(title, reason, icon) {
    icon = icon || 'help-circle';
    return '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', border: '1px dashed var(--bone-400)', borderRadius: 'var(--radius-md)', background: 'var(--surface-page)' }) + '">' +
      I(icon, 20, 'color:var(--ink-400);flex:none') +
      '<div style="display:flex;flex-direction:column;gap:2px;min-width:0">' +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-500)' }) + '">' + esc(title || 'unknown · not measured') + '</span>' +
      '<span style="font-size:12px;color:var(--text-muted);line-height:1.4">' + esc(reason) + '</span></div></div>';
  }
  const EYEBROW = (t) => '<span class="pa-eyebrow">' + esc(t) + '</span>';

  /* state lives at module scope so views + interactive mounts share it */
  var state = {
    section: 'overview', runId: null, appName: null,
    dialog: false, dialogApp: null, dialogMode: 'diff', dialogCommits: 1,
    toast: null, toastHtml: null, toastingRunId: null, runFilter: 'all', appTab: 'runs', appSel: { a: 0, b: 0 },
    repTpl: 'exec', repView: 'blocks',
  };
  var teardown = [];
  var LIVE = null;
  var toastTimer = 0;

  /* ═══ OVERVIEW (Fleet — mission control) ════════════════════════════════ */
  function LiveStepper(stages) {
    return '<div style="display:flex;align-items:center;flex-wrap:wrap">' + stages.map(([name, status], i) => {
      const done = status === 'done', active = status === 'active';
      const fg = active ? 'var(--ember-400)' : done ? 'var(--bone-100)' : 'var(--ink-400)';
      const node = '<span style="display:inline-flex;align-items:center;gap:6px">' +
        (active ? PulseDot('var(--ember-400)', 8) : '<span style="display:inline-flex;color:' + fg + '">' + I(done ? 'check' : 'circle', 12) + '</span>') +
        '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: active ? 700 : 500, letterSpacing: '0.02em', color: fg }) + '">' + esc(name) + '</span></span>';
      const sep = i < stages.length - 1 ? '<span style="width:18px;height:1px;background:var(--ink-500);margin:0 10px"></span>' : '';
      return node + sep;
    }).join('') + '</div>';
  }
  function EngineChip(icon, label, value, tone) {
    return '<div style="display:flex;align-items:center;gap:8px">' +
      '<span style="display:inline-flex;color:var(--ink-400)">' + I(icon, 14) + '</span>' +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-400)' }) + '">' + esc(label) + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:12.5px;color:' + (tone || 'var(--bone-100)') + '">' + esc(value) + '</span></div>';
  }
  function LiveBand(live, running) {
    return '<div class="pa-dot-bg" style="' + sty({ background: 'var(--ink-900)', border: '1px solid var(--ink-700)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }) + '">' +
      '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 26, flexWrap: 'wrap', padding: '14px 22px', borderBottom: '1px solid var(--ink-700)' }) + '">' +
      '<div style="display:flex;align-items:center;gap:9px">' + PulseDot('var(--pass-500)', 9) +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--bone-50)' }) + '">engine operational</span></div>' +
      EngineChip('heart-pulse', 'health', '/health · ' + live.health.last) +
      EngineChip('layers', 'queue', live.queue.running + ' running · ' + live.queue.queued + ' queued') +
      EngineChip('cpu', 'sessions', live.sessions + ' open') +
      EngineChip('webhook', 'webhook', 'verified') +
      EngineChip('trash-2', 'mirrors', 'cleaned ' + live.mirrors) + '</div>' +
      (running
        ? '<button data-action="open-run" data-id="' + esc(running.id) + '" style="' + sty({ display: 'block', width: '100%', textAlign: 'left', border: 0, cursor: 'pointer', background: 'transparent', padding: '16px 22px 18px' }) + '">' +
          '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">' +
          '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ember-400)', fontWeight: 700 }) + '">running now</span>' +
          '<span style="font-family:var(--font-mono);font-size:12.5px;color:var(--bone-100)">' + esc(running.id) + '</span>' +
          '<span style="font-family:var(--font-mono);font-size:12px;color:var(--ink-400)">' + esc(running.app) + ' · ' + esc(running.mode) + '</span>' +
          '<span style="font-family:var(--font-mono);font-size:12px;color:var(--ember-400)">' + esc(shaOf(running.sha)) + '</span>' +
          '<span style="font-size:13.5px;color:var(--bone-200)">' + esc(running.message) + '</span>' +
          '<span style="margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:12.5px;color:var(--bone-100)">' +
          I('timer', 13, 'color:var(--ink-400)') + '<span class="ov-timer">' + fmtMMSS(72) + '</span></span></div>' +
          LiveStepper(running.stages || []) + '</button>'
        : '') + '</div>';
  }
  function AppFleetCard(app) {
    const isCode = app.target === 'code';
    const valueBlock = app.value != null
      ? '<span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 30, letterSpacing: '-0.02em', color: 'var(--text-strong)', lineHeight: 1 }) + '">' + app.value.toFixed(2) + '</span>' +
        '<span style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted)">mutation kill-rate</span>'
      : '<span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 26, letterSpacing: '-0.02em', color: 'var(--ink-400)', lineHeight: 1 }) + '">n/a</span>' +
        '<span style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-faint)">' + (isCode ? 'no mutation (java)' : 'oracle off') + '</span>';
    const right = isCode
      ? '<div style="' + sty({ width: 100, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }) + '">' +
        '<span style="' + sty({ display: 'inline-flex', width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', background: 'var(--infra-100)', color: 'var(--infra-600)' }) + '">' + I('terminal', 20) + '</span>' +
        '<span style="font-family:var(--font-mono);font-size:9.5px;color:var(--text-faint);text-align:center;line-height:1.3">code target · exit-code</span></div>'
      : CoverageGauge(app.coverage, app.coverageMin, 92, app.coverage == null ? 'bundled assets' : null);
    return '<button class="fleet-card" data-action="open-app" data-id="' + esc(app.name) + '" style="' + sty({ display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'left', padding: 0, border: 'var(--border-rule)', borderRadius: 'var(--radius-md)', background: 'var(--surface-raised)', cursor: 'pointer', overflow: 'hidden', transition: 'box-shadow var(--dur-base), border-color var(--dur-base), transform var(--dur-base)' }) + '">' +
      '<div style="display:flex;flex-direction:column;gap:14px;padding:15px 18px 0">' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
      '<div style="display:flex;flex-direction:column;gap:3px;min-width:0">' + EYEBROW(app.stack) +
      '<span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 19, letterSpacing: '-0.02em', color: 'var(--text-strong)' }) + '">' + esc(app.name) + '</span></div>' +
      StatusBadge(app.status, 'sm') + '</div>' +
      '<div style="display:flex;align-items:center;gap:14px;min-height:92px">' +
      '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px">' +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }) + '">value-oracle</span>' + valueBlock + '</div>' + right + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' + VerdictBar(app.vmix, 8) +
      '<div style="display:flex;flex-wrap:wrap;gap:4px 12px">' + app.vmix.map((s) =>
        '<span style="display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted)"><span style="width:7px;height:7px;border-radius:2px;background:' + VERDICT_FILL[s.v] + '"></span>' + esc(s.v) + ' ' + s.n + '</span>').join('') + '</div></div></div>' +
      '<div style="' + sty({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '11px 18px', borderTop: 'var(--border-rule)', background: 'var(--surface-page)' }) + '">' +
      '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">' + esc(app.repo) + '</span>' +
      '<span style="display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:11px;color:var(--ember-600)">App Value ' + I('arrow-right', 12) + '</span></div></button>';
  }
  function RecentRow(r) {
    // Provenance tag: only when a sidekick actually produced this run's specs (outcome
    // action=delegate). Silent for lead-authored runs — the absence IS the lead story.
    const provenance = r.workforce ? WorkforceBadge(r) : '';
    return '<button class="row-hover" data-action="open-run" data-id="' + esc(r.id) + '" style="' + sty({ display: 'flex', alignItems: 'center', gap: 12, width: '100%', border: 0, borderTop: 'var(--border-rule)', background: 'transparent', cursor: 'pointer', textAlign: 'left', padding: '10px 18px' }) + '">' +
      '<span style="width:92px;flex:none;display:inline-flex;gap:6px;align-items:center">' + VerdictTag(r.verdict, { sm: true }) + provenance + '</span>' +
      '<span title="' + esc(runRepoTitle(r)) + '" style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-strong)', flex: 'none', maxWidth: 148, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) + '">' + esc(runRepoLabel(r)) + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:11.5px;color:var(--ember-600);flex:none">' + esc(shaOf(r.sha)) + '</span>' +
      '<span style="' + sty({ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) + '">' + esc(r.message) + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint);flex:none">' + esc(r.time) + '</span></button>';
  }
  function viewOverview() {
    const s = D.signals, vo = s.valueOracle, rp = s.reviewerPass, rn = s.runs, sg = s.suitesGreen, pr = s.prsAutoMerged, io = s.issuesOpen;
    const co = (D.coordination && D.coordination.signals) || (s && s.coordination) || null;
    const delegationKpi = (co && co.measured)
      ? KpiCard({ label: 'delegated runs', value: co.delegateRuns, unit: ' / ' + co.totalRuns, dir: 'flat', good: null,
                  deltaText: co.contractFailureRate == null ? '' : 'failures: ' + Math.round(co.contractFailureRate * 100) + '%', series: [co.delegateRuns || 0], seriesColor: 'var(--ember-500)',
                  sub: co.avgDelegationMs == null ? 'no delegation samples' : 'avg delegation ' + (co.avgDelegationMs >= 60000 ? Math.round(co.avgDelegationMs / 60000) + 'm' : Math.round(co.avgDelegationMs / 1000) + 's') })
      : '';
    const kpis = '<div class="pa-stagger" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(168px, 1fr));gap:var(--space-3)">' +
      KpiCard({ big: true, label: 'value-oracle · fleet', value: F.fixed(vo.v, 2), dir: 'up', good: true, deltaText: F.multiplierLabel(vo.v, vo.baseline), series: vo.series, seriesColor: 'var(--pass-500)', sub: 'mutation kill-rate vs baseline' }) +
      KpiCard({ label: 'reviewer pass-rate', value: rp.v == null ? 'n/a' : Math.round(rp.v * 100) + '%', dir: 'up', good: true, deltaText: rp.v == null ? 'n/a' : '+' + pctPts(rp.v, rp.prev) + ' pts', series: rp.series, seriesColor: 'var(--pass-500)', sub: 'quality verdicts passed' }) +
      KpiCard({ label: 'runs measured', value: rn.measured, unit: '/ ' + rn.total, dir: 'up', good: true, deltaText: '+' + (rn.measured - rn.prevMeasured), series: rn.series, seriesColor: 'var(--ember-500)', sub: 'of total this window' }) +
      KpiCard({ label: 'suites green', value: sg.v, unit: '/ ' + sg.total, dir: 'flat', good: null, deltaText: (sg.v - sg.prev >= 0 ? '+' : '') + (sg.v - sg.prev), series: sg.series, seriesColor: 'var(--ember-500)', sub: 'apps with a green suite' }) +
      KpiCard({ label: 'PRs auto-merged', value: pr.v, dir: 'up', good: true, deltaText: '+' + (pr.v - pr.prev), series: pr.series, seriesColor: 'var(--ember-500)', sub: 'tests committed to apps' }) +
      KpiCard({ label: 'issues open', value: io.v, dir: 'down', good: true, deltaText: '' + (io.v - io.prev), series: io.series, seriesColor: 'var(--fail-500)', sub: 'awaiting a fix' }) + delegationKpi + '</div>';
    const ledgerBtn = '<button data-action="nav" data-id="learning" style="border:0;background:transparent;cursor:pointer;display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:12px;color:var(--ember-600)">ledger ' + I('arrow-right', 13) + '</button>';
    const allRunsBtn = '<button data-action="nav" data-id="runs" style="border:0;background:transparent;cursor:pointer;display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:12px;color:var(--ember-600)">all runs ' + I('arrow-right', 13) + '</button>';
    return '<div style="padding:24px 28px 36px;display:flex;flex-direction:column;gap:var(--space-6)">' +
      LiveBand(D.live, D.running) +
      '<div><div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px">' + EYEBROW('fleet signals · ' + s.window + ' vs ' + s.prevWindow) +
      '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint)">ground-truth first</span></div>' + kpis + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:var(--space-4)">' + sectionHead('watched repositories · drill into App Value', 'Fleet') +
      '<div class="pa-stagger" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:var(--space-4)">' + D.apps.map(AppFleetCard).join('') + '</div></div>' +
      '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:var(--space-4);align-items:start">' +
      Card({ eyebrow: 'where the guardrails fire · fleet', title: 'ErrorClass distribution', action: ledgerBtn, children: ErrorClassBars(D.fleetErrorClasses, 'var(--ink-700)') }) +
      Card({ eyebrow: 'pipeline · all repos', title: 'Recent activity', bodyPadding: false, action: allRunsBtn, children: '<div>' + D.runs.filter((r) => !D.running || r.id !== D.running.id).slice(0, 5).map(RecentRow).join('') + '</div>' }) +
      '</div></div>';
  }
  function sectionHead(eyebrow, title, action) {
    return '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:2px">' +
      '<div style="display:flex;flex-direction:column;gap:3px">' + EYEBROW(eyebrow) +
      '<h2 style="' + sty({ fontSize: 17, fontWeight: 700, letterSpacing: '-0.015em', color: 'var(--text-strong)', margin: 0 }) + '">' + esc(title) + '</h2></div>' + (action || '') + '</div>';
  }

  /* ═══ RUNS FEED ═════════════════════════════════════════════════════════ */
  function viewRunsFeed() {
    const runs = D.runs, stats = D.stats, running = D.running, filter = state.runFilter;
    const filters = ['all', 'pass', 'fail', 'flaky', 'infra-error', 'skipped'];
    const shown = filter === 'all' ? runs : runs.filter((r) => r.verdict === filter);
    const statBox = (inner) => '<div style="' + sty({ padding: 'var(--space-4) var(--space-5)', background: 'var(--surface-raised)', border: 'var(--border-rule)', borderRadius: 'var(--radius-md)' }) + '">' + inner + '</div>';
    const strip = '<div style="display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:var(--space-4)">' +
      '<div style="' + sty({ padding: 'var(--space-4) var(--space-5)', background: 'var(--surface-raised)', border: 'var(--border-rule)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: 12, justifyContent: 'space-between' }) + '">' +
      '<div style="display:flex;align-items:baseline;justify-content:space-between">' + EYEBROW('runs · 7d') +
      '<span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 26, letterSpacing: '-0.02em', color: 'var(--text-strong)', lineHeight: 1 }) + '">' + stats.runs7d + '</span></div>' + VerdictBar(D.verdictMix, 9) + '</div>' +
      statBox(Stat('Pass rate', Math.round(stats.passRate * 100) + '%', 'green + approved', 'var(--pass-600)')) +
      statBox(Stat('Specs added', '+' + stats.specsAdded, 'merged to suites', 'var(--ember-600)')) +
      statBox(Stat('Open issues', stats.openIssues, 'awaiting fix', 'var(--fail-600)')) + '</div>';
    const chips = '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">' + filters.map((f) => {
      const on = filter === f, c = f === 'all' ? 'var(--ink-900)' : VERDICT_FILL[f];
      return '<button data-action="runfilter" data-id="' + f + '" style="' + sty({ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 11px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11.5, letterSpacing: '0.02em', border: '1px solid ' + (on ? 'var(--ink-900)' : 'var(--bone-300)'), background: on ? 'var(--ink-900)' : 'transparent', color: on ? 'var(--bone-100)' : 'var(--text-body)' }) + '">' +
        (f !== 'all' ? '<span style="width:7px;height:7px;border-radius:2px;background:' + c + ';flex:none"></span>' : '') + f + '</button>';
    }).join('') + '</div>';
    const head = '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 16, padding: '11px 20px', borderBottom: 'var(--border-rule)', background: 'var(--surface-page)', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }) + '">' +
      '<span style="width:104px">verdict</span><span style="width:92px">app</span><span style="flex:1">commit</span><span style="width:92px;text-align:center">pipeline</span><span style="width:64px">mode</span><span style="width:52px;text-align:right">specs</span><span style="width:60px;text-align:right">when</span></div>';
    const runningRow = filter === 'all' && running ? '<button class="" data-action="open-run" data-id="' + esc(running.id) + '" style="' + sty({ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 20px', width: '100%', border: 0, borderLeft: '3px solid var(--ember-500)', background: 'var(--ember-100)', cursor: 'pointer', textAlign: 'left' }) + '">' +
      '<span style="width:104px;display:inline-flex;align-items:center;gap:7px">' + PulseDot('var(--ember-500)', 8) + '<span style="font-family:var(--font-mono);font-size:10.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--ember-600)">running</span></span>' +
      '<span style="width:92px;font-family:var(--font-mono);font-size:12.5px;color:var(--text-strong)">' + esc(running.app) + '</span>' +
      '<span style="flex:1;min-width:0;display:flex;align-items:center;gap:10px"><span style="font-family:var(--font-mono);font-size:12px;color:var(--ember-600)">' + esc(shaOf(running.sha)) + '</span><span style="' + sty({ fontSize: 13.5, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) + '">' + esc(running.message) + '</span></span>' +
      '<span style="width:92px;display:flex;justify-content:center">' + MiniStepper(running.stages) + '</span>' +
      '<span style="width:64px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">' + esc(running.mode) + '</span>' +
      '<span style="width:52px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--text-faint)">···</span>' +
      '<span style="width:60px;text-align:right;font-family:var(--font-mono);font-size:11.5px;color:var(--ember-600)">now</span></button>' : '';
    const rows = shown.map((r) => '<button class="row-hover" data-action="open-run" data-id="' + esc(r.id) + '" style="' + sty({ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 20px', width: '100%', border: 0, borderTop: 'var(--border-rule)', background: 'transparent', cursor: 'pointer', textAlign: 'left' }) + '">' +
      '<span style="width:104px">' + VerdictTag(r.verdict, { sm: true }) + '</span>' +
      '<span style="width:92px;font-family:var(--font-mono);font-size:12.5px;color:var(--text-strong)">' + esc(r.app) + '</span>' +
      '<span style="flex:1;min-width:0;display:flex;align-items:center;gap:10px"><span style="font-family:var(--font-mono);font-size:12px;color:var(--ember-600)">' + esc(shaOf(r.sha)) + '</span><span style="' + sty({ fontSize: 13.5, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) + '">' + esc(r.message) + '</span></span>' +
      '<span style="width:92px;display:flex;justify-content:center">' + MiniStepper(r.stages) + '</span>' +
      '<span style="width:64px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">' + esc(r.mode) + '</span>' +
      '<span style="width:52px;text-align:right;font-family:var(--font-mono);font-size:12px;color:' + (r.specs ? 'var(--text-body)' : 'var(--text-faint)') + '">' + (r.specs ? '+' + r.specs : '—') + '</span>' +
      '<span style="width:60px;text-align:right;font-size:12px;color:var(--text-muted)">' + esc(r.time) + '</span></button>').join('');
    const empty = shown.length === 0 ? '<div style="padding:28px 20px;text-align:center;font-family:var(--font-mono);font-size:12.5px;color:var(--text-faint)">no ' + esc(filter) + ' runs in this window</div>' : '';
    return '<div style="padding:24px 28px;display:flex;flex-direction:column;gap:var(--space-5)">' + strip + chips +
      '<div style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md);overflow:hidden">' + head + runningRow + rows + empty + '</div></div>';
  }

  /* ═══ RUN DETAIL ════════════════════════════════════════════════════════ */
  function QChip(icon, label, value, tone) {
    return '<div style="' + sty({ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', background: 'var(--surface-raised)', border: 'var(--border-rule)', borderRadius: 'var(--radius-sm)' }) + '">' +
      '<span style="' + sty({ display: 'inline-flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-xs)', background: 'var(--surface-sunken)', color: tone || 'var(--text-muted)', flex: 'none' }) + '">' + I(icon, 16) + '</span>' +
      '<div style="display:flex;flex-direction:column;gap:2px;min-width:0">' +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }) + '">' + esc(label) + '</span>' +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) + '">' + esc(value) + '</span></div></div>';
  }
  // Multi-agent workforce chips: who wrote this run's specs and how the delegation behaved.
  // Rendered only when the run actually went through a delegation — a direct lead run adds no
  // chips (the pipeline was the non-coordinated baseline every operator already knows).
  function WorkforceChips(run) {
    const wf = run && run.workforce;
    if (!wf) return '';
    const producer = wf.producer === 'sidekick' ? 'sidekick' : 'lead';
    const msToVerdict = wf.avgMs == null ? '' : Math.round(wf.avgMs / 1000) + 's';
    const delegations = 'delegation' + (wf.delegations !== 1 ? 's' : '') + ' · ' +
      (wf.repairs ? 'repairs: ' + wf.repairs : 'delegate only');
    return QChip('bot', 'specs by', wf.producer + (msToVerdict ? ' · ' + msToVerdict : ''), wf.producer === 'sidekick' ? 'var(--pass-600)' : 'var(--text-muted)') +
      QChip('rotate-cw', 'delegations', String(wf.delegations) + (wf.failures ? ' · ' + wf.failures + ' failed' : ''), wf.failures ? 'var(--fail-500)' : 'var(--text-muted)');
  }
  function WorkforceBadge() {
    return '<span class="wtag">sk</span>';
  }
  function backBtn(action, label, extra) {
    return '<button data-action="' + action + '" style="display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;cursor:pointer;padding:0;align-self:flex-start;font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">' + I('arrow-left', 14) + ' ' + esc(label) + (extra || '') + '</button>';
  }
  function viewRunDetail(run) {
    const models = D.models;
    const decisionTone = run.verdict === 'pass' ? 'tip' : run.verdict === 'fail' ? 'warning' : 'note';
    const decisionIcon = run.verdict === 'pass' ? 'git-pull-request' : run.verdict === 'fail' ? 'circle-dot' : run.verdict === 'flaky' ? 'rotate-cw' : run.verdict === 'infra-error' ? 'unplug' : 'minus';
    const covMap = { covered: 'covered', unknown: 'unknown', '—': 'n/a' };
    const covTone = run.coverage === 'covered' ? 'var(--pass-600)' : 'var(--text-muted)';
    const oracleTone = run.oracle && run.oracle !== '—' ? 'var(--pass-600)' : 'var(--text-muted)';
    const header = '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">' +
      '<div style="display:flex;flex-direction:column;gap:9px;min-width:0">' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' + VerdictTag(run.verdict, {}) +
      '<span style="font-family:var(--font-mono);font-size:13px;color:var(--ember-600)">' + esc(shaOf(run.sha)) + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-faint)">' + esc(run.app) + ' · ' + esc(run.branch) + ' · ' + esc(run.mode) + '</span></div>' +
      '<h2 style="' + sty({ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-strong)', margin: 0 }) + '">' + esc(run.message) + '</h2>' +
      '<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">by ' + esc(run.author) + ' · ' + esc(run.time) + ' · ' + esc(run.duration) + '</span></div>' +
      '<div style="display:flex;gap:8px;flex:none">' + Button({ variant: 'ghost', size: 'sm', leadingIcon: 'external-link', label: 'Logs' }) + Button({ variant: 'secondary', size: 'sm', leadingIcon: 'rotate-cw', label: 'Re-run' }) + '</div></div>';
    const specs = run.newSpecs.length === 0
      ? '<span style="font-family:var(--font-mono);font-size:12.5px;color:var(--text-faint)">no specs written — valid no-op</span>'
      : '<div style="display:flex;flex-direction:column">' + run.newSpecs.map((s, i) => '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: i ? 'var(--border-rule)' : 0 }) + '">' +
        VerdictTag(s.status, { sm: true, dot: false }) +
        '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-body)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) + '">' + esc(s.file) + '</span>' +
        '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint)">' + s.n + ' test' + (s.n > 1 ? 's' : '') + '</span></div>').join('') + '</div>';
    const changed = '<div style="display:flex;flex-direction:column">' + run.changed.map((f, i) => '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 0', borderTop: i ? 'var(--border-rule)' : 0 }) + '">' + I('file-code-2', 15, 'color:var(--text-muted)') + '<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-body)">' + esc(f) + '</span></div>').join('') + '</div>';
    return '<div style="padding:20px 28px 36px;display:flex;flex-direction:column;gap:var(--space-5)">' +
      backBtn('back-runs', 'all runs') + header +
      Card({ eyebrow: 'pipeline · deploy gate → classify → generate → validate → execute → decide', title: 'Run stages', children: StageStepper(run.stages) }) +
      '<div style="display:flex;gap:var(--space-4)">' +
      QChip('crosshair', 'change-coverage', covMap[run.coverage] || run.coverage, covTone) +
      QChip('bug', 'oracle · valueScore', run.oracle && run.oracle !== '—' ? run.oracle : 'not run', oracleTone) +
      QChip('scan-eye', 'reviewer · ' + models.reviewer, run.reviewer, 'var(--text-muted)') + WorkforceChips(run) + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);align-items:start">' +
      Card({ eyebrow: 'blast radius', title: 'Changed files', action: '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint)">' + run.changed.length + ' file' + (run.changed.length !== 1 ? 's' : '') + '</span>', children: changed }) +
      Card({ eyebrow: 'generation', title: 'Generated specs', action: '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint)">' + (run.specs ? '+' + run.specs : '0') + ' specs</span>', children: specs }) + '</div>' +
      Callout({ tone: decisionTone, label: 'decision · ' + run.verdict, icon: decisionIcon, children: esc(run.decision) }) +
      '<div style="display:flex;flex-direction:column;gap:var(--space-2)">' + EYEBROW('run log') + Terminal(run.log) + '</div>' +
      runChat(run, false) + '</div>';
  }

  /* ═══ RUN CHAT (interactive; wired in mountChat) ════════════════════════ */
  function chatAnswer(run, live, q) {
    const t = (q || '').toLowerCase();
    const has = function () { for (var i = 0; i < arguments.length; i++) if (t.indexOf(arguments[i]) >= 0) return true; return false; };
    if (live) {
      if (has('eta', 'how long', 'left', 'remaining', 'finish', 'done yet')) return "About 20–30s left. 2 of 3 specs are green; I'm executing the spinner case now, then the oracle runs mutation testing before I decide.";
      if (has('test', 'spec', 'running', 'current', 'executing', 'doing')) return "Right now I'm executing e2e/search/debounce.spec.ts against DEV — case 3 of 4 (\"shows spinner while a query is pending\"). The first two assertions passed in 412ms and 338ms.";
      if (has('plan', 'next', 'step', 'stage', 'after')) return "Plan: classify → blast radius → recall rules → generate (done · 3 specs) → static gate (done) → execute (now) → oracle → decide. I'm on the execute stage.";
      if (has('rule', 'recall', 'memory', 'engram', 'remember')) return "I recalled R-198 and R-204 for web-app and injected them into the prompt — Keycloak redirects and lazy-loaded content, both relevant to /search.";
      if (has('cancel', 'stop', 'abort', 'kill')) return "Cancel from the header. The working copy is discarded and nothing is pushed — the orchestrator never writes to the watched repo mid-run.";
      if (has('why', 'debounce', 'slow', 'wait')) return "The debounce is intentional: the spec waits 300ms to confirm the query fires only after input settles — that's the behaviour this commit introduced.";
      return "This run is on the execute stage — 2/3 specs green, executing the third. Ask me about the current test, the plan, or which rules I recalled.";
    }
    if (has('fail', 'failed', 'wrong', 'broke')) {
      return run.verdict === 'fail'
        ? run.sha + ' failed because a spec asserted a 400 on negative cart quantities but DEV returned 200. I filed ' + run.decision + ' with sanitized logs and produced a rule candidate for the validation gap.'
        : "This run didn't fail — the verdict was " + run.verdict + '. ' + run.decision + '.';
    }
    if (has('flaky', 'retry', 'quarantine', 'unstable')) return run.verdict === 'flaky'
      ? run.sha + ' was flaky — it passed on retry 2/3, so I quarantined it instead of filing an Issue. No human noise until it stabilizes.'
      : run.sha + " wasn't flaky — it executed cleanly.";
    if (has('coverage', 'lines', 'false green')) return run.coverage === 'covered'
      ? 'Change-coverage held: the green specs actually executed the lines the commit changed — not a false green.'
      : "Change-coverage wasn't measurable here (bundled assets) — I reported it as unknown rather than faking it.";
    if (has('oracle', 'mutation', 'valuescore', 'value')) return run.oracle && run.oracle !== '—'
      ? 'Oracle valueScore was ' + run.oracle + ' — mutation testing caught most injected bugs, strong enough to promote the relevant rule to high confidence.'
      : "The oracle didn't run for this one (non-JS/TS target or shadow), so promotion fell back to the conservative prevention signal.";
    if (has('rule', 'learn', 'memory', 'engram', 'ledger')) return run.verdict === 'fail'
      ? 'I reflected on the failure and distilled a rule candidate into the ledger. Proven archetypes get injected into future prompts for ' + run.app + '.'
      : 'I reinforced the recalled rules in the ledger. Proven archetypes keep getting injected into future ' + run.app + ' prompts.';
    if (has('pr', 'merge', 'issue', 'decision', 'outcome', 'result')) return 'Decision: ' + run.decision + '. ' + (run.verdict === 'pass' ? 'Green + reviewer-approved → PR with auto-merge.' : run.verdict === 'fail' ? 'A real failure → GitHub Issue, never a silent skip.' : '');
    if (has('rerun', 're-run', 'again', 'reproduce')) return 'I can re-run ' + run.sha + ' in ' + run.mode + ' mode — runs are deterministic, so a clean re-run of the same SHA should reproduce ' + run.verdict + '.';
    if (has('spec', 'test', 'generate', 'wrote')) return (run.newSpecs && run.newSpecs.length)
      ? 'I wrote ' + run.specs + ' spec' + (run.specs > 1 ? 's' : '') + ' for the blast radius: ' + run.newSpecs.map((s) => s.file.split('/').pop()).join(', ') + '. The reviewer (minimax-m3) approved them.'
      : 'No specs were written — the commit was classified as ' + (run.verdict === 'skipped' ? 'style/docs with no logic change, a valid no-op' : 'non-testable') + '.';
    return 'Run ' + run.id + ' (' + run.sha + ') on ' + run.app + ' resolved ' + run.verdict + ' — ' + run.decision + '. Ask me why, about coverage, the oracle, or what I learned.';
  }
  function chatBubble(who, text, kind) {
    const agent = who === 'agent';
    const avatar = agent ? '<img src="' + MARK + '" alt="" style="width:24px;height:24px;flex:none;margin-top:1px">'
      : '<span style="' + sty({ width: 24, height: 24, flex: 'none', borderRadius: '50%', background: 'var(--ink-900)', color: 'var(--bone-100)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700 }) + '">you</span>';
    const body = agent
      ? '<div class="chat-md' + (kind === 'error' ? ' chat-md--error' : '') + '">' + F.renderMarkdown(text) + '</div>'
      : '<span style="font-size:13.5px;line-height:1.5">' + esc(text) + '</span>';
    return '<div style="display:flex;gap:10px;align-items:flex-start;flex-direction:' + (agent ? 'row' : 'row-reverse') + '">' + avatar +
      '<div style="' + sty({ maxWidth: '78%', padding: '10px 13px', borderRadius: 'var(--radius-md)', border: agent ? 'var(--border-rule)' : '1px solid transparent', background: agent ? 'var(--surface-page)' : 'var(--ink-900)', color: agent ? 'var(--text-body)' : 'var(--bone-100)', borderTopLeftRadius: agent ? '2px' : 'var(--radius-md)', borderTopRightRadius: agent ? 'var(--radius-md)' : '2px' }) + '">' +
      body + '</div></div>';
  }
  function typingBubble() {
    return '<div data-typing style="display:flex;gap:10px;align-items:center"><img src="' + MARK + '" alt="" style="width:24px;height:24px;flex:none">' +
      '<div style="' + sty({ padding: '12px 14px', borderRadius: 'var(--radius-md)', borderTopLeftRadius: '2px', border: 'var(--border-rule)', background: 'var(--surface-page)', display: 'inline-flex', gap: 4 }) + '">' +
      [0, 1, 2].map((i) => '<span style="width:6px;height:6px;border-radius:50%;background:var(--ink-400);animation:pa-blink 1.2s var(--ease-out) infinite;animation-delay:' + (i * 0.16) + 's"></span>').join('') + '</div></div>';
  }
  function runChat(run, live) {
    const intro = live ? "I'm running QA on this commit right now. Ask me what I'm testing, the plan, or what to expect."
      : 'This is run ' + shaOf(run.sha) + ' on ' + run.app + ' — verdict ' + run.verdict + '. Ask me anything about it.';
    const suggestions = live ? ['What test is running?', "What's the plan?", 'How long is left?'] : ['Why this verdict?', 'Did coverage hold?', 'What did you learn?'];
    return '<div data-chat="' + (live ? 'live' : 'run') + '" style="' + sty({ background: 'var(--surface-raised)', border: 'var(--border-rule)', borderRadius: 'var(--radius-md)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }) + '">' +
      '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', borderBottom: 'var(--border-rule)', background: 'var(--surface-page)' }) + '">' +
      '<img src="' + MARK + '" alt="" style="width:20px;height:20px">' +
      '<div style="display:flex;flex-direction:column;gap:1px">' +
      '<span style="font-family:var(--font-display);font-weight:700;font-size:13.5px;letter-spacing:-0.01em;color:var(--text-strong)">Ask Qayaba</span>' +
      '<span style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted)">' + (live ? 'live execution' : 'this run') + ' · ' + esc(shaOf(run.sha)) + '</span></div>' +
      '<span style="margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-faint)">' + I('sparkles', 12) + 'context-aware</span></div>' +
      '<div data-chat-thread style="padding:16px 18px;display:flex;flex-direction:column;gap:12px;max-height:320px;overflow-y:auto">' + chatBubble('agent', intro) + '</div>' +
      '<div style="padding:12px 18px 16px;border-top:var(--border-rule);display:flex;flex-direction:column;gap:10px">' +
      '<div style="display:flex;gap:7px;flex-wrap:wrap">' + suggestions.map((s) => '<button class="chat-sugg" data-sugg="' + esc(s) + '" style="' + sty({ padding: '5px 10px', cursor: 'pointer', borderRadius: 'var(--radius-pill)', border: '1px solid var(--bone-300)', background: 'transparent', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }) + '">' + esc(s) + '</button>').join('') + '</div>' +
      '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 6px 6px 14px', background: 'var(--surface-page)', border: 'var(--border-rule)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-inset)' }) + '">' +
      '<input data-chat-input placeholder="' + (live ? 'ask about the current execution…' : 'ask about this run…') + '" style="flex:1;border:0;outline:none;background:transparent;font-family:var(--font-sans);font-size:13.5px;color:var(--text-strong)">' +
      '<button data-chat-send style="' + sty({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, flex: 'none', border: 0, borderRadius: 'var(--radius-xs)', cursor: 'not-allowed', background: 'var(--bone-300)', color: 'var(--text-faint)' }) + '">' + I('arrow-up', 16) + '</button></div></div></div>';
  }

  /* ═══ LIVE RUN DETAIL (streaming; wired in mountLive) ═══════════════════ */
  const MS = [412, 338, 274, 221];
  function livePipeHTML() {
    const L = LIVE;
    const stages = L.stages.map(([name, status], i) => {
      const active = status === 'active', isDone = status === 'done', pending = status === 'pending';
      const c = active ? 'var(--ember-600)' : isDone ? 'var(--pass-600)' : 'var(--ink-400)';
      const bc = active ? 'var(--ember-500)' : isDone ? 'color-mix(in oklab, var(--pass-600) 20%, transparent)' : 'var(--bone-300)';
      const box = '<div style="' + sty({ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 13px', borderRadius: 'var(--radius-sm)', background: active ? 'var(--ember-100)' : isDone ? 'var(--pass-100)' : 'transparent', border: '1px solid ' + bc, opacity: pending ? 0.55 : 1 }) + '">' +
        (active ? PulseDot('var(--ember-500)', 9) : '<span style="display:inline-flex;color:' + c + '">' + I(isDone ? 'check' : 'circle', 14) + '</span>') +
        '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: active ? 700 : 600, letterSpacing: '0.02em', color: c }) + '">' + esc(name) + '</span></div>';
      const sep = i < L.stages.length - 1 ? '<span style="width:22px;height:1px;background:' + (isDone ? 'var(--pass-600)' : 'var(--bone-300)') + ';margin:0 3px"></span>' : '';
      return box + sep;
    }).join('');
    const caret = '<span style="display:inline-block;width:7px;height:14px;background:var(--ember-500);margin-left:2px' + (reduceMotion() ? '' : ';animation:pa-blink 1s steps(1) infinite') + '"></span>';
    return '<div style="' + sty({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 18px', borderBottom: 'var(--border-rule)', background: 'var(--surface-page)' }) + '">' + EYEBROW('pipeline · live') +
      '<span style="display:inline-flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:11.5px;color:var(--text-muted)">' + I('file-code-2', 13) + 'spec ' + L.done + ' of ' + L.total + ' · executing</span></div>' +
      '<div style="padding:18px"><div style="display:flex;align-items:center;flex-wrap:wrap">' + stages + '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:14px;font-family:var(--font-mono);font-size:12.5px;color:var(--text-body)">' + I('terminal', 14, 'color:var(--ember-600)') + esc(L.note) + caret + '</div></div>';
  }
  function liveCasesHTML() {
    const cases = LIVE.cases, done = cases.filter((c) => c.s === 'pass').length;
    const rows = cases.map((c, i) => {
      const meta = { pass: { c: 'var(--pass-600)', ic: 'check' }, running: { c: 'var(--ember-600)', ic: 'loader' }, pending: { c: 'var(--ink-400)', ic: 'circle' }, fail: { c: 'var(--fail-600)', ic: 'x' } }[c.s] || { c: 'var(--ink-400)', ic: 'circle' };
      const last = i === cases.length - 1;
      return '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderTop: last ? 0 : 'var(--border-rule)', opacity: c.s === 'pending' ? 0.6 : 1 }) + '">' +
        '<span style="display:inline-flex;color:' + meta.c + ';flex:none' + (c.s === 'running' && !reduceMotion() ? ';animation:pa-spin 1s linear infinite' : '') + '">' + I(meta.ic, 15) + '</span>' +
        '<span style="flex:1;min-width:0;font-size:12.5px;color:var(--text-body)">' + esc(c.name) + '</span>' +
        '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint);flex:none">' + (c.s === 'pass' ? c.ms + 'ms' : c.s === 'running' ? 'running…' : c.s === 'fail' ? 'failed' : 'queued') + '</span></div>';
    }).join('');
    return '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' + EYEBROW('test cases') +
      '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">' + done + '/' + cases.length + ' green</span></div>' + rows;
  }
  // Real in-flight run detail: fields come from the RunRecord (cases/logs/step) and live updates
  // from the run's SSE stream via mountLive. No fake plan/case content is ever rendered here —
  // sections appear only once real data exists for them.
  function viewLiveDetailReal(run) {
    // run.stages already arrives derived (mapRun builds the stage states from the record's
    // current step) — no cross-module call here, api.js internals are module-private.
    var stages = run.stages && run.stages.length ? run.stages : [];
    LIVE = { elapsed: Math.max(0, run.mins | 0), log: (run.log || []).slice(), cases: (run.cases || []).slice(), stages: stages.map(function (st) { return [st[0], st[1]]; }), note: (run.note || run.step || ''), plan: [], done: (run.specs || 0), total: (run.specs || 0), run: run };
    var header = '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">' +
      '<div style="display:flex;flex-direction:column;gap:9px;min-width:0">' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
      '<span style="' + sty({ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 10px', borderRadius: 'var(--radius-xs)', background: 'var(--ember-100)', border: '1.5px solid var(--ember-500)' }) + '">' + PulseDot('var(--ember-500)', 8) + '<span style="font-family:var(--font-mono);font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--ember-600)">running</span></span>' +
      '<span style="font-family:var(--font-mono);font-size:13px;color:var(--ember-600)">' + esc(shaOf(run.sha)) + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-faint)">' + esc(run.app) + ' · ' + esc(run.branch) + ' · ' + esc(run.mode) + '</span></div>' +
      '<h2 style="' + sty({ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-strong)', margin: 0 }) + '">' + esc(run.message) + '</h2>' +
      '<span style="display:inline-flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">started <span class="live-elapsed">' + fmtMMSS(LIVE.elapsed) + '</span> ago</span></div>' +
      '<div style="display:flex;gap:8px;flex:none">' + Button({ variant: 'ghost', size: 'sm', leadingIcon: 'external-link', label: 'Raw logs' }) + Button({ variant: 'danger', size: 'sm', leadingIcon: 'square', label: 'Cancel run', action: 'cancel' }) + '</div></div>';
    return '<div style="padding:20px 28px 36px;display:flex;flex-direction:column;gap:var(--space-5)">' + backBtn('back-runs', 'all runs') + header +
      '<div style="display:flex;gap:var(--space-4);flex-wrap:wrap">' +
      (run.workforce ? WorkforceChips(run) : '') +
      QChip('crosshair', 'current step', run.step || 'starting', 'var(--text-muted)') + '</div>' +
      '<div id="live-pipe" style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md);border-left:3px solid var(--ember-500);overflow:hidden">' + livePipeHTML() + '</div>' +
      (LIVE.plan && LIVE.plan.length
        ? '<div style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md)"><div style="padding:13px 18px;border-bottom:var(--border-rule);background:var(--surface-page)">' + EYEBROW('agent · action plan') + '</div><div id="live-plan" style="padding:6px 18px 12px">' + planHTML(LIVE.plan) + '</div></div>'
        : '<div id="live-plan" hidden></div>') +
      '<div style="display:flex;flex-direction:column;gap:var(--space-2)">' +
      '<div style="display:flex;align-items:center;gap:8px">' + PulseDot('var(--pass-500)', 7) + EYEBROW('live run log · streaming') + '</div>' +
      '<div id="live-term">' + Terminal(LIVE.log) + '</div></div>' +
      '<div style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md)"><div style="padding:13px 18px;border-bottom:var(--border-rule);background:var(--surface-page)">' + EYEBROW('test cases') + '</div><div id="live-cases" style="padding:6px 18px 14px">' + liveCasesHTML() + '</div></div>' +
      runChat(run, true) + '</div>';
  }
  function planHTML(items) {
    return (items || []).map(function (p) {
      const active = p.s === 'active' || p.s === 'starting', done = p.s === 'done' || p.s === 'pass';
      const dot = active ? PulseDot('var(--ember-500)', 9)
        : done ? '<span style="' + sty({ display: 'inline-flex', width: 18, height: 18, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: 'var(--pass-100)', color: 'var(--pass-600)' }) + '">' + I('check', 12) + '</span>'
        : '<span style="width:9px;height:9px;border-radius:50%;border:1.5px solid var(--bone-400)"></span>';
      return '<div style="' + sty({ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '10px 0', borderTop: 1 ? 'var(--border-rule)' : 0 }) + '">' +
        '<span style="flex:none;margin-top:1px;display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center">' + dot + '</span>' +
        '<span style="' + sty({ fontSize: 13, lineHeight: 1.4, color: active ? 'var(--text-strong)' : done ? 'var(--text-body)' : 'var(--text-faint)', fontWeight: active ? 600 : 400 }) + '">' + esc(p.t || p.name || '') + '</span></div>';
    }).join('');
  }
  function viewLiveDetail(run) {
    // IMPORTANT split: the simulated (mock) live view seeds from `currentTest/plan/liveLog`, which
    // ONLY the demo dataset provides. In live mode those mock fields used to bleed into real runs
    // via mergeLiveRun — every real run showed the same fake plan/cases. Real runs now route to
    // viewLiveDetailReal (record fields SSE-fed) and the mock keeps its simulation.
    if (run && run.__live === true) return viewLiveDetailReal(run);
    if (!run || !run.currentTest || !run.plan || !run.liveLog) return viewRunDetail(run);
    LIVE = { elapsed: run.startedAt || 0, log: run.liveLog.slice(), cases: run.currentTest.cases.map((c) => Object.assign({}, c)), stages: run.stages.map((s) => s.slice()), note: 'shows spinner while a query is pending', queue: run.liveQueue, done: run.specsDone + 1, total: run.specsTotal, run: run };
    const planItems = run.plan.map((p, i) => {
      const active = p.s === 'active', done = p.s === 'done', last = i === 0;
      const dot = active ? PulseDot('var(--ember-500)', 9)
        : done ? '<span style="' + sty({ display: 'inline-flex', width: 18, height: 18, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: 'var(--pass-100)', color: 'var(--pass-600)' }) + '">' + I('check', 12) + '</span>'
        : '<span style="width:9px;height:9px;border-radius:50%;border:1.5px solid var(--bone-400)"></span>';
      return '<div style="' + sty({ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '10px 0', borderTop: last ? 0 : 'var(--border-rule)' }) + '">' +
        '<span style="flex:none;margin-top:1px;display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center">' + dot + '</span>' +
        '<span style="' + sty({ fontSize: 13, lineHeight: 1.4, color: active ? 'var(--text-strong)' : done ? 'var(--text-body)' : 'var(--text-faint)', fontWeight: active ? 600 : 400 }) + '">' + esc(p.t) + '</span>' +
        (active ? '<span style="margin-left:auto;flex:none;font-family:var(--font-mono);font-size:9.5px;letter-spacing:0.08em;text-transform:uppercase;color:var(--ember-600);margin-top:2px">now</span>' : '') + '</div>';
    }).join('');
    const code = '<div class="pa-dot-bg pa-ticks pa-ticks--ink" style="' + sty({ background: 'var(--ink-900)', border: '1px solid var(--ink-700)', borderRadius: 'var(--radius-sm)', padding: '12px 14px', overflowX: 'auto' }) + '">' +
      run.currentTest.code.map((ln, i) => '<div style="display:flex;gap:12px;font-family:var(--font-mono);font-size:12px;line-height:1.65;white-space:pre"><span style="color:var(--ink-500);user-select:none;text-align:right;width:16px;flex:none">' + (i + 1) + '</span><span style="color:var(--bone-200)">' + esc(ln || ' ') + '</span></div>').join('') + '</div>';
    const header = '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">' +
      '<div style="display:flex;flex-direction:column;gap:9px;min-width:0">' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
      '<span style="' + sty({ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 10px', borderRadius: 'var(--radius-xs)', background: 'var(--ember-100)', border: '1.5px solid var(--ember-500)' }) + '">' + PulseDot('var(--ember-500)', 8) + '<span style="font-family:var(--font-mono);font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--ember-600)">running</span></span>' +
      '<span style="font-family:var(--font-mono);font-size:13px;color:var(--ember-600)">' + esc(shaOf(run.sha)) + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-faint)">' + esc(run.app) + ' · ' + esc(run.branch) + ' · ' + esc(run.mode) + '</span></div>' +
      '<h2 style="' + sty({ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-strong)', margin: 0 }) + '">' + esc(run.message) + '</h2>' +
      '<span style="display:inline-flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">by ' + esc(run.author) + ' · started <span class="live-elapsed">' + fmtMMSS(run.startedAt || 0) + '</span> ago · <span style="display:inline-flex;align-items:center;gap:5px;color:var(--ember-600)">' + I('timer', 13) + '<span class="live-elapsed">' + fmtMMSS(run.startedAt || 0) + '</span></span></span></div>' +
      '<div style="display:flex;gap:8px;flex:none">' + Button({ variant: 'ghost', size: 'sm', leadingIcon: 'external-link', label: 'Raw logs' }) + Button({ variant: 'danger', size: 'sm', leadingIcon: 'square', label: 'Cancel run', action: 'cancel' }) + '</div></div>';
    return '<div style="padding:20px 28px 36px;display:flex;flex-direction:column;gap:var(--space-5)">' + backBtn('back-runs', 'all runs') + header +
      '<div id="live-pipe" style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md);border-left:3px solid var(--ember-500);overflow:hidden">' + livePipeHTML() + '</div>' +
      '<div style="display:grid;grid-template-columns:minmax(0,0.8fr) minmax(0,1.2fr);gap:var(--space-4);align-items:start">' +
      '<div style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md);overflow:hidden">' +
      '<div style="padding:13px 18px;border-bottom:var(--border-rule);background:var(--surface-page)">' + EYEBROW('agent · action plan') + '</div>' +
      '<div style="padding:6px 18px 12px">' + planItems + '</div></div>' +
      '<div style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md);overflow:hidden">' +
      '<div style="' + sty({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 18px', borderBottom: 'var(--border-rule)', background: 'var(--surface-page)' }) + '">' +
      '<div style="display:flex;flex-direction:column;gap:2px;min-width:0">' + EYEBROW('currently executing') +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) + '">' + esc(run.currentTest.file) + '</span></div>' +
      '<span style="' + sty({ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', padding: '4px 9px', borderRadius: 'var(--radius-xs)', background: 'var(--ember-100)', border: '1px solid var(--ember-500)', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ember-600)' }) + '">' + I('play', 11) + esc(run.currentTest.phase) + '</span></div>' +
      '<div style="padding:14px 18px;display:flex;flex-direction:column;gap:14px">' + code + '<div id="live-cases">' + liveCasesHTML() + '</div></div></div></div>' +
      '<div style="display:flex;flex-direction:column;gap:var(--space-2)">' +
      '<div style="display:flex;align-items:center;gap:8px">' + PulseDot('var(--pass-500)', 7) + EYEBROW('live run log · streaming') + '</div>' +
      '<div id="live-term">' + Terminal(LIVE.log) + '</div></div>' +
      runChat(run, true) + '</div>';
  }

  /* ═══ APP DETAIL ════════════════════════════════════════════════════════ */
  const HC = { H: 188, PADX: 7, TOP: 20, BOT: 22 };
  function hcGeom(history) {
    const n = history.length;
    const yMin = Math.max(0, Math.min.apply(null, history.map((h) => h.health)) - 12), yMax = 100;
    const xPct = (i) => HC.PADX + (n === 1 ? 0 : (i / (n - 1)) * (100 - 2 * HC.PADX));
    const topPx = (v) => HC.TOP + (1 - (v - yMin) / (yMax - yMin)) * (HC.H - HC.TOP - HC.BOT);
    return { n: n, yMin: yMin, yMax: yMax, xPct: xPct, topPx: topPx };
  }
  function healthChart(history, ai, bi) {
    const g = hcGeom(history), n = g.n;
    const pts = history.map((h, i) => ({ x: g.xPct(i), yv: (g.topPx(h.health) / HC.H) * 100, h: h, i: i }));
    const line = pts.map((p, k) => (k ? 'L' : 'M') + p.x.toFixed(2) + ' ' + p.yv.toFixed(2)).join(' ');
    const area = 'M ' + pts[0].x.toFixed(2) + ' 100 ' + pts.map((p) => 'L ' + p.x.toFixed(2) + ' ' + p.yv.toFixed(2)).join(' ') + ' L ' + pts[n - 1].x.toFixed(2) + ' 100 Z';
    const lo = Math.min(ai, bi), hi = Math.max(ai, bi);
    const grid = [0, 0.5, 1].map((q) => { const y = (HC.TOP + q * (HC.H - HC.TOP - HC.BOT)) / HC.H * 100; return '<line x1="0" y1="' + y + '" x2="100" y2="' + y + '" stroke="var(--bone-300)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="' + (q === 1 ? '0' : '3 4') + '" opacity="' + (q === 1 ? 1 : 0.7) + '"/>'; }).join('');
    const guides = '<div class="hc-guide" data-g="0" style="position:absolute;top:0;bottom:0;left:' + g.xPct(lo) + '%;width:0;border-left:1.5px dashed var(--ember-500);opacity:0.55;pointer-events:none"></div>' +
      '<div class="hc-guide" data-g="1" style="position:absolute;top:0;bottom:0;left:' + g.xPct(hi) + '%;width:0;border-left:1.5px dashed var(--ember-500);opacity:0.55;pointer-events:none"></div>';
    const points = pts.map((p) => {
      const sel = p.i === ai || p.i === bi, lbl = p.i === lo ? 'A' : p.i === hi ? 'B' : '';
      return '<button class="hc-pt" data-action="apppick" data-id="' + p.i + '" title="' + esc(p.h.sha) + ' · ' + esc(p.h.time) + ' · health ' + p.h.health + '" style="' + sty({ position: 'absolute', left: p.x + '%', top: g.topPx(p.h.health), transform: 'translate(-50%,-50%)', width: 26, height: 26, padding: 0, border: 0, background: 'transparent', cursor: 'pointer', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }) + '">' +
        '<span class="hc-lbl" style="position:absolute;top:-20px;font-family:var(--font-mono);font-size:10px;font-weight:700;color:var(--bone-50);background:var(--ember-500);border-radius:var(--radius-xs);padding:1px 6px;opacity:' + (lbl ? 1 : 0) + '">' + (lbl || 'A') + '</span>' +
        '<span class="hc-dot" style="' + sty({ width: sel ? 14 : 10, height: sel ? 14 : 10, borderRadius: '50%', background: VERDICT_FILL[p.h.verdict] || 'var(--bone-400)', border: (sel ? '2.5px' : '2px') + ' solid var(--surface-raised)', boxShadow: sel ? '0 0 0 2px var(--ember-500)' : '0 0 0 1px var(--bone-300)' }) + '"></span></button>';
    }).join('');
    const xlabels = pts.map((p) => { const sel = p.i === ai || p.i === bi; return '<div class="hc-xl" data-i="' + p.i + '" style="position:absolute;left:' + p.x + '%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:1px;white-space:nowrap">' +
      '<span class="hc-xl-t" style="font-family:var(--font-mono);font-size:10px;color:' + (sel ? 'var(--ember-600)' : 'var(--text-faint)') + ';font-weight:' + (sel ? 700 : 400) + '">' + esc(p.h.time) + '</span>' +
      '<span class="hc-xl-s" style="font-family:var(--font-mono);font-size:9px;color:var(--text-muted);opacity:' + (sel ? 1 : 0) + '">' + esc(p.h.sha.slice(0, 6)) + '</span></div>'; }).join('');
    return '<div style="position:relative">' +
      '<div style="position:absolute;left:0;top:' + (g.topPx(g.yMax) - 7) + 'px;font-family:var(--font-mono);font-size:9.5px;color:var(--text-faint)">' + g.yMax + '</div>' +
      '<div style="position:absolute;left:0;top:' + (g.topPx(g.yMin) - 7) + 'px;font-family:var(--font-mono);font-size:9.5px;color:var(--text-faint)">' + g.yMin + '</div>' +
      '<div style="position:relative;height:' + HC.H + 'px">' +
      '<svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;display:block;overflow:visible">' + grid +
      '<path d="' + area + '" fill="var(--ember-500)" opacity="0.07"/><path d="' + line + '" fill="none" stroke="var(--ember-500)" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>' +
      '<div class="hc-span" style="position:absolute;top:0;bottom:0;left:' + g.xPct(lo) + '%;width:' + (g.xPct(hi) - g.xPct(lo)) + '%;background:var(--ember-500);opacity:0.08;pointer-events:none"></div>' + guides + points + '</div>' +
      '<div style="position:relative;height:30px;margin-top:2px">' + xlabels + '</div></div>';
  }
  // Surgical, transition-friendly update of the chart selection (no remount).
  function updateAppChart() {
    const history = D.histories[state.appName] || [];
    const a = state.appSel.a, b = state.appSel.b, lo = Math.min(a, b), hi = Math.max(a, b);
    const g = hcGeom(history);
    const span = document.querySelector('.hc-span');
    if (span) { span.style.left = g.xPct(lo) + '%'; span.style.width = (g.xPct(hi) - g.xPct(lo)) + '%'; }
    document.querySelectorAll('.hc-guide').forEach((el) => { el.style.left = (el.dataset.g === '0' ? g.xPct(lo) : g.xPct(hi)) + '%'; });
    document.querySelectorAll('.hc-pt').forEach((btn) => {
      const i = parseInt(btn.dataset.id, 10), sel = i === a || i === b;
      const dot = btn.querySelector('.hc-dot'), lbl = btn.querySelector('.hc-lbl');
      if (dot) { dot.style.width = (sel ? 14 : 10) + 'px'; dot.style.height = (sel ? 14 : 10) + 'px'; dot.style.borderWidth = sel ? '2.5px' : '2px'; dot.style.boxShadow = sel ? '0 0 0 2px var(--ember-500)' : '0 0 0 1px var(--bone-300)'; }
      if (lbl) { const t = i === lo ? 'A' : i === hi ? 'B' : ''; lbl.style.opacity = t ? '1' : '0'; if (t) lbl.textContent = t; }
    });
    document.querySelectorAll('.hc-xl').forEach((el) => {
      const i = parseInt(el.dataset.i, 10), sel = i === a || i === b;
      const t = el.querySelector('.hc-xl-t'), s = el.querySelector('.hc-xl-s');
      if (t) { t.style.color = sel ? 'var(--ember-600)' : 'var(--text-faint)'; t.style.fontWeight = sel ? 700 : 400; }
      if (s) s.style.opacity = sel ? '1' : '0';
    });
    const cmp = document.getElementById('app-compare');
    if (cmp) { cmp.innerHTML = appCompareInner(); refreshIcons(); }
  }
  function appCompareInner() {
    const history = D.histories[state.appName] || [], sel = state.appSel;
    const older = history[Math.min(sel.a, sel.b)] || {}, newer = history[Math.max(sel.a, sel.b)] || {};
    const pctDelta = Math.round((newer.passRate - older.passRate) * 100);
    const oracleNa = !older.oracle && !newer.oracle;
    const hd = newer.health - older.health, improved = hd >= 0;
    return '<div style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md);overflow:hidden">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 18px;border-bottom:var(--border-rule)">' +
      '<div style="display:flex;align-items:center;gap:12px"><span style="' + sty({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, borderRadius: 'var(--radius-sm)', background: improved ? 'var(--pass-100)' : 'var(--fail-100)', color: improved ? 'var(--pass-600)' : 'var(--fail-600)', flex: 'none' }) + '">' + I(improved ? 'trending-up' : 'trending-down', 20) + '</span>' +
      '<div style="display:flex;flex-direction:column;gap:2px">' + EYEBROW('snapshot comparison') +
      '<span style="font-family:var(--font-display);font-weight:700;font-size:17px;letter-spacing:-0.015em;color:var(--text-strong)">Health ' + (improved ? 'improved' : 'regressed') + ' ' + (improved ? '+' : '') + hd + '</span></div></div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<span style="display:flex;flex-direction:column;align-items:flex-end;gap:1px"><span style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-strong)"><span style="color:var(--ember-600);font-weight:700">A</span> ' + esc(older.sha) + '</span><span style="font-family:var(--font-mono);font-size:10px;color:var(--text-faint)">' + esc(older.time) + ' · ' + esc(older.verdict) + '</span></span>' +
      I('arrow-right', 14, 'color:var(--bone-400)') +
      '<span style="display:flex;flex-direction:column;align-items:flex-end;gap:1px"><span style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-strong)"><span style="color:var(--ember-600);font-weight:700">B</span> ' + esc(newer.sha) + '</span><span style="font-family:var(--font-mono);font-size:10px;color:var(--text-faint)">' + esc(newer.time) + ' · ' + esc(newer.verdict) + '</span></span></div></div>' +
      '<div style="padding:16px 18px;display:flex;flex-direction:column;gap:14px">' +
      '<div><span style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-faint)">quality &amp; confidence</span>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(128px, 1fr));gap:var(--space-3);margin-top:8px">' +
      DeltaCard('health', older.health, newer.health, hd, null, true) +
      DeltaCard('pass rate', Math.round(older.passRate * 100) + '%', Math.round(newer.passRate * 100) + '%', pctDelta, 'pts', true) +
      DeltaCard('change-coverage', older.coverage + '%', newer.coverage + '%', newer.coverage - older.coverage, 'pts', true) +
      DeltaCard('oracle value', older.oracle ? older.oracle.toFixed(2) : 'n/a', newer.oracle ? newer.oracle.toFixed(2) : 'n/a', +(newer.oracle - older.oracle).toFixed(2), null, true, oracleNa) + '</div></div>' +
      '<div><span style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-faint)">stability &amp; footprint</span>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(128px, 1fr));gap:var(--space-3);margin-top:8px">' +
      DeltaCard('flaky specs', older.flaky, newer.flaky, newer.flaky - older.flaky, null, false) +
      DeltaCard('open issues', older.issues, newer.issues, newer.issues - older.issues, null, false) +
      DeltaCard('suite size', older.specs, newer.specs, newer.specs - older.specs, null, true) +
      DeltaCard('run duration', fmtDur(older.durSec), fmtDur(newer.durSec), newer.durSec - older.durSec, 's', false) + '</div></div></div></div>';
  }
  function appTabsInner() {
    const app = state.appName;
    const appRuns = D.runs.filter((r) => r.app === app);
    const runningHere = liveRun() && liveRun().app === app ? liveRun() : null;
    const appSuite = D.suite.filter((s) => s.app === app);
    return Tabs({ value: state.appTab, action: 'apptab', tabs: [{ id: 'runs', label: 'Runs', icon: 'activity', count: appRuns.length + (runningHere ? 1 : 0) }, { id: 'suite', label: 'Suite', icon: 'list-checks', count: appSuite.length }] });
  }
  function appActivityInner() {
    const app = state.appName, tab = state.appTab;
    const appRuns = D.runs.filter((r) => r.app === app);
    const runningHere = liveRun() && liveRun().app === app ? liveRun() : null;
    const appSuite = D.suite.filter((s) => s.app === app);
    if (tab === 'runs') {
      const rh = runningHere ? '<button class="row-hover" data-action="open-run" data-id="' + esc(runningHere.id) + '" style="' + sty({ display: 'flex', alignItems: 'center', gap: 12, width: '100%', border: 0, borderLeft: '3px solid var(--ember-500)', background: 'var(--ember-100)', cursor: 'pointer', textAlign: 'left', padding: '11px 18px' }) + '">' +
        '<span style="width:84px;display:inline-flex;align-items:center;gap:6px;flex:none">' + PulseDot('var(--ember-500)', 7) + '<span style="font-family:var(--font-mono);font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--ember-600)">running</span></span>' +
        '<span style="font-family:var(--font-mono);font-size:11.5px;color:var(--ember-600);flex:none">' + esc(shaOf(runningHere.sha)) + '</span>' +
        '<span style="' + sty({ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) + '">' + esc(runningHere.message) + '</span>' + I('chevron-right', 15, 'color:var(--text-faint);flex:none') + '</button>' : '';
      const rrows = appRuns.map((r, i) => '<button class="row-hover" data-action="open-run" data-id="' + esc(r.id) + '" style="' + sty({ display: 'flex', alignItems: 'center', gap: 12, width: '100%', border: 0, borderTop: (i || runningHere) ? 'var(--border-rule)' : 0, background: 'transparent', cursor: 'pointer', textAlign: 'left', padding: '11px 18px' }) + '">' +
        '<span style="width:84px;flex:none">' + VerdictTag(r.verdict, { sm: true }) + '</span>' +
        '<span style="font-family:var(--font-mono);font-size:11.5px;color:var(--ember-600);flex:none">' + esc(shaOf(r.sha)) + '</span>' +
        '<span style="' + sty({ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) + '">' + esc(r.message) + '</span>' +
        '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint);flex:none">' + esc(r.time) + '</span></button>').join('');
      return rh + rrows;
    }
    return appSuite.map((s, i) => '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderTop: i ? 'var(--border-rule)' : 0 }) + '">' +
      '<span style="width:60px;flex:none">' + VerdictTag(s.status, { sm: true, dot: false }) + '</span>' + I('file-code-2', 14, 'color:var(--text-muted);flex:none') +
      '<span style="' + sty({ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) + '">' + esc(s.file) + '</span>' +
      '<span style="display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:10.5px;color:' + (s.coverage === 'covered' ? 'var(--pass-600)' : 'var(--text-faint)') + ';flex:none">' + I(s.coverage === 'covered' ? 'check' : 'circle-help', 11) + esc(s.coverage) + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint);flex:none;width:48px;text-align:right">' + s.n + ' test' + (s.n > 1 ? 's' : '') + '</span></div>').join('');
  }
  function setAppTab(id) {
    state.appTab = id;
    document.querySelectorAll('#app-activity-tabs .dtab').forEach((t) => t.classList.toggle('is-on', t.dataset.id === id));
    const body = document.getElementById('app-activity-body');
    if (body) { body.innerHTML = appActivityInner(); refreshIcons(); }
  }
  function DeltaCard(label, a, b, dv, unit, goodUp, na) {
    const good = dv > 0 ? goodUp : dv < 0 ? !goodUp : null;
    const neutral = na || dv === 0;
    const color = neutral ? 'var(--text-muted)' : good ? 'var(--pass-600)' : 'var(--fail-600)';
    const accent = neutral ? 'var(--bone-300)' : good ? 'var(--pass-500)' : 'var(--fail-500)';
    const arrow = neutral ? 'minus' : dv > 0 ? 'arrow-up' : 'arrow-down';
    const dtxt = na ? 'n/a' : (dv > 0 ? '+' : '') + dv + (unit ? ' ' + unit : '');
    return '<div style="' + sty({ padding: '13px 14px', background: 'var(--surface-page)', border: 'var(--border-rule)', borderLeft: '3px solid ' + accent, borderRadius: 'var(--radius-sm)', display: 'flex', flexDirection: 'column', gap: 8 }) + '">' +
      '<span style="font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.04em;color:var(--text-muted)">' + esc(label) + '</span>' +
      '<span style="' + sty({ display: 'inline-flex', alignItems: 'center', gap: 5, color: color, fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 21, letterSpacing: '-0.01em', lineHeight: 1 }) + '">' + I(arrow, 15) + esc(dtxt) + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-faint)">' + esc(a) + ' <span style="color:var(--bone-400)">→</span> <span style="color:var(--text-body)">' + esc(b) + '</span></span></div>';
  }
  function CfgRow(k, v, accent, first) {
    return '<div style="' + sty({ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: first ? 0 : 'var(--border-rule)' }) + '">' +
      '<span style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-muted)">' + esc(k) + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:11.5px;color:' + (accent || 'var(--text-body)') + '">' + esc(v) + '</span></div>';
  }
  function viewAppDetail(app) {
    const history = D.histories[app.name] || [];
    const sel = state.appSel;
    const latest = history[history.length - 1] || {}, first = history[0] || {};
    const healthDelta = (latest.health || 0) - (first.health || 0);
    const healthMap = { healthy: 'var(--pass-500)', degraded: 'var(--flaky-500)', down: 'var(--fail-500)' };
    const appEngram = D.engram.filter((e) => e.app === app.name);

    const policyCallout = Callout({
      tone: app.target === 'code' ? 'note' : app.coverageMode === 'enforce' ? 'important' : 'note',
      label: 'coverage policy · ' + (app.target === 'code' ? 'code target' : app.coverageMode),
      icon: 'shield-half',
      children: app.target === 'code'
        ? "Code target — no deploy gate and no change-coverage. Verdicts are binary pass/fail from the repo's own test exit code; the mutation oracle runs only on JS/TS."
        : app.coverageMode === 'enforce'
          ? 'Change-coverage is <strong>enforcing</strong>: a PR is blocked unless the generated tests exercise the lines the commit changed (min ' + Math.round(app.coverageMin * 100) + '%).'
          : app.coverageMode === 'signal'
            ? 'Change-coverage runs in <strong>signal</strong> mode — measured and recorded, but not gating PRs' + (app.shadow ? '. Shadow mode: PRs and Issues are simulated, not real.' : '') + '.'
            : 'Change-coverage is off for this app.',
    });
    const covKeystone = '<div style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md);overflow:hidden">' +
      '<div style="padding:13px 18px;border-bottom:var(--border-rule)">' + EYEBROW('keystone · change-coverage') +
      '<div style="font-family:var(--font-display);font-weight:700;font-size:15px;letter-spacing:-0.015em;color:var(--text-strong);margin-top:2px">Did the tests exercise the diff?</div></div>' +
      (app.target === 'code'
        ? '<div style="padding:18px">' + UnknownPanel('not applicable · code target', 'Code-target runs have no URL→source mapping. Trust here comes from the repo\'s own suite and the mutation oracle, not coverage.', 'terminal') + '</div>'
        : '<div style="display:flex;align-items:center;gap:18px;padding:18px">' + CoverageGauge(app.coverage, app.coverageMin, 132, app.coverage == null ? 'bundled assets' : null) +
          '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:8px">' +
          (app.coverageSeries
            ? EYEBROW('coverage trend') + Sparkline(app.coverageSeries, { w: 200, h: 34, color: 'var(--pass-500)', responsive: true }) + '<span style="font-size:12px;color:var(--text-muted);line-height:1.4">Share of the commit\'s changed lines actually exercised by the generated tests — above the ' + Math.round(app.coverageMin * 100) + '% floor.</span>'
            : '<span style="font-size:12px;color:var(--text-muted);line-height:1.45">Astro bundles assets, so the URL→source mapping isn\'t measurable. Coverage is reported <strong>unknown</strong> — never faked as 0% or green, and never blocks a PR.</span>') + '</div></div>') + '</div>';
    const valKeystone = '<div style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md);overflow:hidden">' +
      '<div style="padding:13px 18px;border-bottom:var(--border-rule)">' + EYEBROW('keystone · value-oracle') +
      '<div style="font-family:var(--font-display);font-weight:700;font-size:15px;letter-spacing:-0.015em;color:var(--text-strong);margin-top:2px">Are the tests meaningful?</div></div>' +
      (app.value != null
        ? '<div style="padding:18px;display:flex;flex-direction:column;gap:10px"><div style="display:flex;align-items:baseline;gap:10px">' +
          '<span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 40, letterSpacing: '-0.02em', color: 'var(--text-strong)', lineHeight: 0.9 }) + '">' + app.value.toFixed(2) + '</span>' +
          (app.valueSeries ? DeltaChip('up', true, '+' + (app.value - app.valueSeries[0]).toFixed(2)) : '') +
          '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">kill-rate</span></div>' +
          (app.valueSeries ? Sparkline(app.valueSeries, { w: 220, h: 34, color: 'var(--pass-500)', responsive: true }) : '') +
          '<span style="font-size:12px;color:var(--text-muted);line-height:1.4">Mutation kill-rate — the fraction of injected bugs the tests caught. The ground-truth that they verify behaviour, not just run green.</span></div>'
        : '<div style="padding:18px">' + UnknownPanel('oracle not run', app.target === 'code' ? 'Java target — mutation testing runs only on JS/TS repos.' : 'The oracle is off in shadow mode for this app; promotion falls back to the prevention signal.', 'bug') + '</div>') + '</div>';
    const vmixCard = Card({ eyebrow: 'composition', title: 'Verdict mix', children: '<div style="display:flex;align-items:center;gap:16px">' + VerdictDonut(app.vmix, 104) +
      '<div style="display:flex;flex-direction:column;gap:6px;min-width:0">' + app.vmix.map((s) => '<span style="display:inline-flex;align-items:center;gap:7px;font-family:var(--font-mono);font-size:11.5px;color:var(--text-body)"><span style="width:9px;height:9px;border-radius:2px;background:' + VERDICT_FILL[s.v] + ';flex:none"></span>' + esc(s.v) + '<span style="color:var(--text-faint);margin-left:auto">' + s.n + '</span></span>').join('') + '</div></div>' });
    const reviewerCard = Card({ eyebrow: 'independent review', title: 'Reviewer pass-rate', children: '<div style="display:flex;flex-direction:column;gap:6px">' +
      '<span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 38, letterSpacing: '-0.02em', color: 'var(--text-strong)', lineHeight: 1 }) + '">' + (app.reviewerPass == null ? 'n/a' : Math.round(app.reviewerPass * 100) + '%') + '</span>' +
      '<span style="font-size:12px;color:var(--text-muted);line-height:1.4">Quality verdicts the second model approved. The generator never self-approves.</span>' +
      '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint);margin-top:2px">reviewer · ' + esc(D.models.reviewer) + '</span></div>' });
    const errCard = Card({ eyebrow: 'where the guardrails fire', title: 'ErrorClass', children: ErrorClassBars(app.errClasses, 'var(--ink-700)') });

    const healthCard = '<div style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md);overflow:hidden">' +
      '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:15px 18px 13px;border-bottom:var(--border-rule)">' +
      '<div style="display:flex;align-items:baseline;gap:12px"><div style="display:flex;flex-direction:column;gap:3px">' + EYEBROW('health score') +
      '<span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 38, letterSpacing: '-0.02em', color: 'var(--text-strong)', lineHeight: 0.9 }) + '">' + (latest.health != null ? latest.health : '') + '</span></div>' +
      '<span style="display:inline-flex;align-items:center;gap:4px;font-family:var(--font-mono);font-size:12px;color:' + (healthDelta >= 0 ? 'var(--pass-600)' : 'var(--fail-600)') + '">' + I(healthDelta >= 0 ? 'trending-up' : 'trending-down', 14) + (healthDelta >= 0 ? '+' : '') + healthDelta + ' over ' + history.length + ' runs</span></div>' +
      '<div style="display:flex;gap:6px"><button data-action="apppreset" data-id="prev" style="padding:5px 10px;cursor:pointer;border-radius:var(--radius-sm);border:1px solid var(--bone-300);background:transparent;font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">prev → latest</button>' +
      '<button data-action="apppreset" data-id="first" style="padding:5px 10px;cursor:pointer;border-radius:var(--radius-sm);border:1px solid var(--bone-300);background:transparent;font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">first → latest</button></div></div>' +
      '<div style="padding:20px 18px 10px">' + FigLabel('01', 'health over time · per run') + '<div id="app-chart">' + healthChart(history, sel.a, sel.b) + '</div></div>' +
      '<div style="display:flex;align-items:center;gap:8px;padding:11px 18px;border-top:var(--border-rule);background:var(--surface-page)">' + I('git-compare-arrows', 14, 'color:var(--ember-600)') +
      '<span style="font-size:12px;color:var(--text-muted)">Click any two points to compare snapshots. Each dot is a run, coloured by verdict.</span></div></div>';
    const cmpCard = '<div id="app-compare">' + appCompareInner() + '</div>';
    const activityCard = '<div style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md);overflow:hidden">' +
      '<div id="app-activity-tabs" style="padding:4px 18px 0">' + appTabsInner() + '</div>' +
      '<div id="app-activity-body">' + appActivityInner() + '</div></div>';
    const rail = '<div style="display:flex;flex-direction:column;gap:var(--space-4);flex:1 1 280px;min-width:0">' +
      Card({ eyebrow: 'config/apps/' + app.name + '.yaml', title: 'Configuration', children: '<div>' +
        CfgRow('baseBranch', app.baseBranch, null, true) + CfgRow('dev.baseUrl', app.devUrl) +
        CfgRow('qa.gate', app.gate, app.gate === 'enforce' ? 'var(--ink-900)' : 'var(--text-body)') +
        CfgRow('qa.valueOracle', app.oracle) + CfgRow('onFailure', 'github-issue') +
        CfgRow('shadow', app.shadow ? 'true' : 'false', app.shadow ? 'var(--flaky-600)' : 'var(--text-body)') + '</div>' }) +
      Card({ eyebrow: 'two-model loop', title: 'Models', children: '<div>' + CfgRow('generator', D.models.generator, null, true) + CfgRow('reviewer', D.models.reviewer) + '</div>' }) +
      Card({ eyebrow: 'engram · ' + appEngram.length + ' lessons', title: 'What Qayaba knows', bodyPadding: false, children: '<div>' + appEngram.map((e, i) => '<div style="' + sty({ display: 'flex', gap: 9, padding: '11px 18px', borderTop: i ? 'var(--border-rule)' : 0 }) + '">' + I('sparkles', 13, 'color:var(--ember-600);flex:none;margin-top:2px') + '<span style="font-size:12px;color:var(--text-body);line-height:1.45">' + esc(e.text) + '</span></div>').join('') + '</div>' }) + '</div>';
    const targetChip = '<span style="' + sty({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 'var(--radius-xs)', border: '1px solid var(--bone-400)', fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }) + '">' + I(app.target === 'code' ? 'terminal' : 'globe', 11) + esc(app.target) + '</span>';
    const header = '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">' +
      '<div style="display:flex;flex-direction:column;gap:8px;min-width:0">' + EYEBROW(app.stack) +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="' + sty({ fontSize: 26, fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--text-strong)', margin: 0 }) + '">' + esc(app.name) + '</h2>' + StatusBadge(app.status) + targetChip + '</div>' +
      '<div style="display:flex;align-items:center;gap:14px;font-family:var(--font-mono);font-size:12px"><span style="color:var(--text-muted)">' + esc(app.repo) + '</span>' +
      '<span style="display:inline-flex;align-items:center;gap:6px;color:var(--text-body)"><span style="width:8px;height:8px;border-radius:50%;background:' + (healthMap[app.health] || 'var(--bone-400)') + '"></span>' + esc(app.health) + '</span></div></div>' +
      '<div style="display:flex;gap:8px;flex:none">' + Button({ variant: 'ghost', size: 'sm', leadingIcon: 'settings-2', label: 'Configure' }) + Button({ variant: 'primary', size: 'sm', leadingIcon: 'play', label: 'Run QA', action: 'trigger' }) + '</div></div>';
    return '<div style="padding:20px 28px 36px;display:flex;flex-direction:column;gap:var(--space-5)">' +
      backBtn('back-fleet', 'Fleet', '<span style="color:var(--text-faint)">/ ' + esc(app.name) + '</span>') + header + policyCallout +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(290px,1fr));gap:var(--space-4)">' + covKeystone + valKeystone + '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(258px,1fr));gap:var(--space-4);align-items:stretch">' + vmixCard + reviewerCard + errCard + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:var(--space-4);align-items:flex-start">' +
      '<div style="display:flex;flex-direction:column;gap:var(--space-4);min-width:0;flex:1 1 540px">' + healthCard + cmpCard + activityCard + '</div>' + rail + '</div></div>';
  }

  /* ═══ INTEGRITY ═════════════════════════════════════════════════════════ */
  function GateRow(g, last) {
    const blocks = g.mode === 'blocks', pct = Math.round((g.pass / g.of) * 100);
    return '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', borderTop: last ? 'var(--border-rule)' : 0 }) + '">' +
      '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint);width:14px;flex:none">' + g.n + '</span>' +
      '<span style="' + sty({ display: 'inline-flex', width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-xs)', background: blocks ? 'var(--ink-900)' : 'var(--surface-sunken)', color: blocks ? 'var(--bone-100)' : 'var(--text-muted)', flex: 'none' }) + '">' + I(g.icon, 15) + '</span>' +
      '<div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px">' +
      '<span style="font-family:var(--font-mono);font-size:12.5px;font-weight:600;color:var(--text-strong)">' + esc(g.label) + '</span>' +
      '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 'var(--radius-xs)', border: '1px solid ' + (blocks ? 'var(--ink-900)' : 'var(--bone-400)'), color: blocks ? 'var(--ink-900)' : 'var(--text-muted)' }) + '">' + esc(g.mode) + '</span></div>' +
      '<span style="font-size:11.5px;color:var(--text-muted)">' + esc(g.desc) + '</span></div>' +
      '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;width:84px;flex:none">' +
      '<span style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-body)">' + g.pass + '<span style="color:var(--text-faint)">/' + g.of + '</span></span>' +
      '<div style="width:100%;height:4px;background:var(--surface-sunken);border-radius:999px;overflow:hidden"><div style="width:' + pct + '%;height:100%;background:' + (blocks ? 'var(--ink-900)' : 'var(--bone-400)') + '"></div></div></div></div>';
  }
  function viewIntegrity() {
    const devBadge = DevBadge();
    const it = D.integrity, pct = (x) => (x * 100).toFixed(1) + '%';
    const kpis = '<div class="pa-stagger" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(168px, 1fr));gap:var(--space-3)">' +
      KpiCard({ label: 'flaky / quarantine', value: pct(it.flakyRate.v), dir: 'down', good: true, deltaText: pctPts(it.flakyRate.v, it.flakyRate.prev) + ' pts', series: it.flakyRate.series, seriesColor: 'var(--flaky-500)', sub: 'passed only on retry → quarantined' }) +
      KpiCard({ label: 'infra-error rate', value: pct(it.infraErrorRate.v), dir: 'up', good: null, deltaText: '+' + Math.abs(pctPts(it.infraErrorRate.v, it.infraErrorRate.prev)) + ' pts', series: it.infraErrorRate.series, seriesColor: 'var(--infra-500)', sub: 'DEV down — not the code' }) +
      KpiCard({ label: 'invalid rate', value: pct(it.invalidRate.v), dir: 'down', good: true, deltaText: pctPts(it.invalidRate.v, it.invalidRate.prev) + ' pts', series: it.invalidRate.series, seriesColor: 'var(--ink-500)', sub: 'static-gate rejections' }) +
      KpiCard({ label: 'time-to-green', value: it.timeToGreen.v + 's', dir: 'down', good: true, deltaText: (it.timeToGreen.v - it.timeToGreen.prev) + 's', sub: 'was ' + it.timeToGreen.prev + 's' }) +
      KpiCard({ label: 'determinism', value: F.fixed(it.determinism, 2), dir: 'flat', good: null, deltaText: 'same-SHA', sub: '2 runs of a SHA agree' }) + '</div>';
    const total = it.phases.reduce((s, p) => s + p[1], 0) || 1;
    const phaseBar = '<div style="display:flex;flex-direction:column;gap:12px"><div style="display:flex;width:100%;height:16px;border-radius:var(--radius-xs);overflow:hidden;gap:2px">' +
      it.phases.map(([name, sec]) => '<div title="' + esc(name) + ' · ' + sec + 's" style="width:' + ((sec / total) * 100) + '%;background:' + (PHASE_COLORS[name] || 'var(--bone-400)') + '"></div>').join('') + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px 18px">' + it.phases.map(([name, sec]) => '<span style="display:inline-flex;align-items:center;gap:7px;font-family:var(--font-mono);font-size:11.5px;color:var(--text-body)"><span style="width:9px;height:9px;border-radius:2px;background:' + (PHASE_COLORS[name] || 'var(--bone-400)') + '"></span>' + esc(name) + '<span style="color:var(--text-faint)">' + sec + 's</span></span>').join('') + '</div></div>';
    const gateStat = (value, desc, icon) => '<div style="' + sty({ display: 'flex', gap: 12, padding: '14px 16px', background: 'var(--surface-page)', border: 'var(--border-rule)', borderRadius: 'var(--radius-sm)' }) + '">' +
      '<span style="' + sty({ display: 'inline-flex', width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-xs)', background: 'var(--ink-900)', color: 'var(--bone-100)', flex: 'none' }) + '">' + I(icon, 17) + '</span>' +
      '<div style="display:flex;flex-direction:column;gap:2px;min-width:0"><span style="' + sty({ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, letterSpacing: '-0.02em', color: 'var(--text-strong)', lineHeight: 1 }) + '">' + value + '</span><span style="font-size:11.5px;color:var(--text-muted);line-height:1.35">' + esc(desc) + '</span></div></div>';
    return '<div style="padding:24px 28px 36px;display:flex;flex-direction:column;gap:var(--space-5)">' + devBadge + kpis +
      Callout({ tone: 'note', label: 'trust · infra-error is not a failure', icon: 'unplug', children: 'Infrastructure failures (DEV down, timeouts) are styled and counted <strong>separately</strong> from code failures — they never open an Issue and never count against pass-rate. A blue infra-error means "not the code\'s fault", not "the tests are bad."' }) +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px,1fr));gap:var(--space-4);align-items:start">' +
      Card({ eyebrow: 'time-to-green · ' + it.timeToGreen.v + 's wall-clock', title: 'Phase timing', children: phaseBar }) +
      Card({ eyebrow: 'how often the gate holds', title: 'Gate effectiveness', children: '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(150px,1fr));gap:var(--space-3)">' + gateStat(it.gates.enforceHeld.v, it.gates.enforceHeld.desc, 'shield-x') + gateStat(it.gates.regenRecovered.v, it.gates.regenRecovered.desc, 'rotate-cw') + gateStat(it.gates.staticRejected.v, it.gates.staticRejected.desc, 'file-x-2') + '</div>' }) + '</div>' +
      Card({ eyebrow: 'confidence is earned in layers', title: 'Quality gate', bodyPadding: false, children: '<div>' + D.gates.map((g, i) => GateRow(g, i > 0)).join('') + '</div>' }) + '</div>';
  }

  /* ═══ LEARNING ══════════════════════════════════════════════════════════ */
  function viewLearning() {
    const devBadge = DevBadge();
    const flywheel = D.flywheel, ledger = D.ledger;
    const confTone = { high: { c: 'var(--pass-600)', bg: 'var(--pass-100)' }, med: { c: 'var(--flaky-600)', bg: 'var(--flaky-100)' }, low: { c: 'var(--ink-500)', bg: 'var(--bone-200)' } };
    const STATUS = [['active', 'var(--pass-600)'], ['candidate', 'var(--ember-600)'], ['deprecated', 'var(--flaky-600)'], ['superseded', 'var(--ink-500)']];
    const notes = D.engram.map((e) => [e.app, e.text]);
    const wheel = '<div style="display:flex;flex-direction:column;gap:var(--space-4)"><div style="display:flex;flex-direction:column;gap:3px">' + EYEBROW('labeler → oracle → reflector → distiller → curriculum') +
      '<h2 style="font-size:17px;font-weight:700;letter-spacing:-0.015em;color:var(--text-strong);margin:0">The learning flywheel</h2></div>' +
      '<div style="display:flex;align-items:stretch;gap:0">' + flywheel.map((f, i) => FlowNode({ icon: f.icon, label: f.label, stat: f.stat, unit: f.unit, note: f.note, last: i === flywheel.length - 1 })).join('') + '</div>' +
      Callout({ tone: 'important', label: 'promotion uses two signals', children: 'The <strong>oracle</strong> (mutation / fault-injection) is strong ground-truth — it promotes rules to high confidence where it runs. A conservative <strong>prevention signal</strong> is always available and caps at medium. So the wheel turns for every onboarded app, and "high confidence" is reserved for rules backed by real evidence.' }) + '</div>';
    const inventory = '<div style="display:flex;flex-direction:column;gap:var(--space-4)"><div style="display:flex;align-items:center;gap:8px">' + I('book-marked', 15, 'color:var(--text-muted)') + EYEBROW('governed rule inventory · injected into future prompts') + '</div>' +
      STATUS.map(([st, c]) => {
        const items = ledger.rules.filter((r) => r.status === st);
        if (!items.length) return '';
        const rows = items.map((r, i) => {
          const ct = confTone[r.confidence] || confTone.low, sr = r.outcomes ? Math.round(r.success * 100) : null;
          const barCol = sr >= 75 ? 'var(--pass-500)' : sr >= 50 ? 'var(--flaky-500)' : 'var(--fail-500)';
          return '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', borderTop: i ? 'var(--border-rule)' : 0, opacity: st === 'deprecated' || st === 'superseded' ? 0.7 : 1 }) + '">' +
            '<span style="font-family:var(--font-mono);font-size:11.5px;color:var(--ember-600);width:50px;flex:none">' + esc(r.id) + '</span>' +
            '<span style="flex:1;min-width:0;display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text-body)"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.trigger) + '</span>' + I('arrow-right', 12, 'color:var(--bone-400);flex:none') + '<span style="color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.action) + '</span></span>' +
            '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)', width: 110, flex: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) + '">' + esc(r.errorClass) + '</span>' +
            '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 'var(--radius-xs)', flex: 'none', border: '1px solid ' + ct.c, color: ct.c, background: ct.bg }) + '">' + esc(r.confidence) + '</span>' +
            '<span style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-faint);width:66px;text-align:right;flex:none">' + r.usage + '× · ' + r.outcomes + 'o</span>' +
            '<span style="width:66px;flex:none;display:flex;align-items:center;gap:6px"><span style="flex:1;height:5px;background:var(--surface-sunken);border-radius:999px;overflow:hidden"><span style="display:block;width:' + (sr || 0) + '%;height:100%;background:' + barCol + '"></span></span><span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);width:24px;text-align:right">' + (sr == null ? '—' : sr + '%') + '</span></span></div>';
        }).join('');
        return '<div style="display:flex;flex-direction:column;gap:8px"><div style="display:flex;align-items:center;gap:8px">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:' + c + '"></span>' +
          '<span style="font-family:var(--font-mono);font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:' + c + '">' + esc(st) + '</span>' +
          '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint)">' + items.length + '</span></div>' +
          '<div style="background:var(--surface-raised);border:var(--border-rule);border-radius:var(--radius-md);overflow:hidden">' + rows + '</div></div>';
      }).join('') + '</div>';
    const maxPromo = Math.max.apply(null, ledger.archetypes.map((x) => x.promotions).concat([1]));
    const curriculum = Card({ eyebrow: 'curriculum · only proven archetypes inject', title: 'Scenario archetypes', bodyPadding: false, children: '<div>' +
      ledger.archetypes.slice().sort((a, b) => b.promotions - a.promotions).map((a, i) => '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderTop: i ? 'var(--border-rule)' : 0 }) + '">' +
        '<span style="flex:1;min-width:0;font-size:12.5px;color:var(--text-body);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(a.name) + '</span>' +
        '<span style="' + sty({ display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 'var(--radius-xs)', border: '1px solid ' + (a.caughtRealBug ? 'var(--pass-600)' : 'var(--bone-400)'), color: a.caughtRealBug ? 'var(--pass-600)' : 'var(--text-faint)', background: a.caughtRealBug ? 'var(--pass-100)' : 'transparent' }) + '">' + I(a.caughtRealBug ? 'bug' : 'circle-dashed', 11) + (a.caughtRealBug ? 'caught bug' : 'unproven') + '</span>' +
        '<span style="width:56px;flex:none;display:flex;align-items:center;gap:6px"><span style="flex:1;height:6px;background:var(--surface-sunken);border-radius:999px;overflow:hidden"><span style="display:block;width:' + ((a.promotions / maxPromo) * 100) + '%;height:100%;background:var(--ember-500)"></span></span><span style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted)">' + a.promotions + '</span></span></div>').join('') + '</div>' });
    const audit = Card({ eyebrow: 'audit / veto · rule lifecycle', title: 'Governance log', bodyPadding: false, children: '<div>' +
      ledger.audit.map((a, i) => '<div style="' + sty({ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderTop: i ? 'var(--border-rule)' : 0 }) + '">' +
        '<span style="font-family:var(--font-mono);font-size:11.5px;color:var(--ember-600);width:50px;flex:none">' + esc(a.rule) + '</span>' +
        '<span style="flex:1;min-width:0;font-size:12.5px;color:var(--text-body);line-height:1.4">' + esc(a.issue) + '</span>' +
        '<span style="' + sty({ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 'var(--radius-xs)', flex: 'none', border: '1px solid ' + (a.level === 'demoted' ? 'var(--flaky-600)' : 'var(--pass-600)'), color: a.level === 'demoted' ? 'var(--flaky-600)' : 'var(--pass-600)' }) + '">' + esc(a.level) + '</span></div>').join('') + '</div>' });
    const engram = '<div style="display:flex;flex-direction:column;gap:var(--space-3)"><div style="display:flex;align-items:center;gap:8px">' + I('database', 15, 'color:var(--text-muted)') + EYEBROW('engram · episodic memory · per-app, volatile') + '</div>' +
      notes.map(([app, t]) => '<div style="' + sty({ display: 'flex', gap: 14, padding: 'var(--space-4)', background: 'var(--surface-raised)', border: 'var(--border-rule)', borderRadius: 'var(--radius-sm)' }) + '"><span style="font-family:var(--font-mono);font-size:11px;color:var(--ember-600);width:96px;flex:none">' + esc(app) + '</span><span style="font-size:13.5px;color:var(--text-body);line-height:1.5">' + esc(t) + '</span></div>').join('') + '</div>';
    return '<div style="padding:24px 28px 36px;display:flex;flex-direction:column;gap:var(--space-6)">' + devBadge + wheel + inventory +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(300px,1fr));gap:var(--space-4);align-items:start">' + curriculum + audit + '</div>' + engram + '</div>';
  }

  /* ═══ REPORTS ═══════════════════════════════════════════════════════════ */
  function insightBlock(ins, rank) {
    const shapeIcon = { multiplier: 'x', gauge: 'gauge', bars: 'bar-chart-3', sparkline: 'trending-up', note: 'info' };
    let viz;
    if (ins.shape === 'multiplier') viz = '<span style="font-family:var(--font-display);font-weight:800;font-size:40px;letter-spacing:-0.02em;color:var(--ember-600);line-height:1">×1.6</span>';
    else if (ins.shape === 'gauge') viz = CoverageGauge(0.92, 0.7, 104);
    else if (ins.shape === 'bars') viz = '<div style="width:100%">' + ErrorClassBars(D.fleetErrorClasses.slice(0, 4), 'var(--ink-700)') + '</div>';
    else if (ins.shape === 'sparkline') viz = '<div style="width:100%">' + Sparkline(D.integrity.flakyRate.series, { w: 220, h: 40, color: 'var(--flaky-500)', responsive: true }) + '</div>';
    else viz = '<span style="' + sty({ display: 'inline-flex', width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', background: 'var(--infra-100)', color: 'var(--infra-600)' }) + '">' + I('unplug', 22) + '</span>';
    return '<div style="' + sty({ display: 'flex', gap: 16, padding: '16px 18px', background: 'var(--surface-raised)', border: 'var(--border-rule)', borderRadius: 'var(--radius-md)', alignItems: 'center' }) + '">' +
      '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:5px"><div style="display:flex;align-items:center;gap:8px">' +
      '<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-faint)">#' + rank + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:9.5px;letter-spacing:0.06em;text-transform:uppercase;color:var(--ember-600);display:inline-flex;align-items:center;gap:4px">' + I(shapeIcon[ins.shape], 11) + esc(ins.metric) + '</span>' +
      '<span style="margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:10px;color:var(--text-faint)">weight<span style="width:44px;height:5px;background:var(--surface-sunken);border-radius:999px;overflow:hidden;display:inline-block"><span style="display:block;width:' + (ins.weight * 100) + '%;height:100%;background:var(--ember-500)"></span></span></span></div>' +
      '<span style="font-family:var(--font-display);font-weight:700;font-size:16px;letter-spacing:-0.015em;color:var(--text-strong)">' + esc(ins.headline) + '</span>' +
      '<span style="font-size:12.5px;color:var(--text-muted);line-height:1.45">' + esc(ins.detail) + '</span></div>' +
      '<div style="flex:none;width:140px;display:flex;align-items:center;justify-content:center">' + viz + '</div></div>';
  }
  function poster() {
    const grid = [['92%', 'change-coverage', 'above the 70% floor'], ['5.5%', 'flaky rate', 'down from 7.0%'], ['+23', 'PRs auto-merged', 'tests committed']]
      .map(([v, l, s]) => '<div style="display:flex;flex-direction:column;gap:3px"><span style="font-family:var(--font-display);font-weight:800;font-size:34px;letter-spacing:-0.02em;color:var(--bone-50);line-height:1">' + v + '</span><span style="font-family:var(--font-mono);font-size:11px;color:var(--ember-400)">' + l + '</span><span style="font-family:var(--font-mono);font-size:10.5px;color:var(--ink-400)">' + s + '</span></div>').join('');
    return '<div class="pa-ticks pa-ticks--ink" style="position:relative;background:var(--ink-900);border-radius:var(--radius-md);border:1px solid var(--ink-700);overflow:hidden;padding:28px 30px;background-image:repeating-linear-gradient(0deg, rgba(194,78,44,0.07) 0 1px, transparent 1px 40px), repeating-linear-gradient(90deg, rgba(194,78,44,0.07) 0 1px, transparent 1px 40px)">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:22px"><div style="display:flex;align-items:center;gap:10px"><img src="' + MARK_LIGHT + '" alt="" style="width:24px;height:24px"><span style="font-family:var(--font-mono);font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--ember-400)">qa value report</span></div><span style="font-family:var(--font-mono);font-size:11px;color:var(--ink-400)">web-app · this sprint</span></div>' +
      '<div style="display:flex;align-items:baseline;gap:14px;margin-bottom:6px"><span style="font-family:var(--font-display);font-weight:800;font-size:88px;letter-spacing:-0.03em;color:var(--bone-50);line-height:0.85">×1.6</span><span style="font-family:var(--font-display);font-weight:800;font-size:22px;letter-spacing:-0.01em;color:var(--ember-400)">value-oracle vs last sprint</span></div>' +
      '<p style="font-size:14px;color:var(--bone-300);max-width:560px;line-height:1.5;margin:0 0 22px">Mutation kill-rate <strong style="color:var(--bone-50)">0.78</strong> — the generated tests are catching real injected bugs, not just running green.</p>' +
      '<div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:22px;margin-bottom:22px">' + grid + '</div>' +
      '<div style="border-top:1px solid var(--ink-700);padding-top:16px;display:flex;align-items:center;gap:10px"><span style="font-family:var(--font-mono);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--ember-400);flex:none">takeaway</span><span style="font-size:13.5px;color:var(--bone-100);line-height:1.45">The suite is getting more meaningful and more stable at once — value up 1.6×, flakiness down, coverage holding above the gate.</span></div></div>';
  }
  function viewReports() {
    const tpl = state.repTpl, view = state.repView;
    const insights = D.reports.insights.slice().sort((a, b) => b.weight - a.weight);
    const tplName = D.reports.templates.find((t) => t.id === tpl).name;
    const toggle = '<div style="display:inline-flex;border:var(--border-rule);border-radius:var(--radius-sm);overflow:hidden">' +
      [['blocks', 'Insights'], ['poster', 'Poster']].map(([id, lbl]) => '<button data-action="rep-view" data-id="' + id + '" style="padding:7px 14px;border:0;cursor:pointer;font-family:var(--font-mono);font-size:11.5px;background:' + (view === id ? 'var(--ink-900)' : 'transparent') + ';color:' + (view === id ? 'var(--bone-100)' : 'var(--text-muted)') + '">' + lbl + '</button>').join('') + '</div>';
    const main = '<div style="display:flex;flex-direction:column;gap:var(--space-4);min-width:0">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><div style="display:flex;flex-direction:column;gap:3px">' + EYEBROW('interestingness-first · ranked by |Δ| × weight × confidence') +
      '<h2 style="font-size:18px;font-weight:700;letter-spacing:-0.015em;color:var(--text-strong);margin:0">' + esc(tplName) + '</h2></div>' + toggle + '</div>' +
      (view === 'blocks'
        ? '<div style="display:flex;flex-direction:column;gap:var(--space-3)">' + insights.map((ins, i) => insightBlock(ins, i + 1)).join('') +
          '<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;font-family:var(--font-mono);font-size:11.5px;color:var(--text-faint)">' + I('filter', 13) + 'showing the ' + insights.length + ' signals that moved — low-interest metrics are omitted, not zero-filled.</div></div>'
        : poster()) + '</div>';
    const tplBtns = D.reports.templates.map((t) => '<button data-action="rep-tpl" data-id="' + t.id + '" style="' + sty({ display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'left', padding: '10px 12px', cursor: 'pointer', borderRadius: 'var(--radius-sm)', border: '1px solid ' + (tpl === t.id ? 'var(--ember-500)' : 'var(--bone-300)'), background: tpl === t.id ? 'var(--ember-100)' : 'transparent' }) + '">' +
      '<span style="display:flex;align-items:center;gap:6px;font-family:var(--font-display);font-weight:700;font-size:13px;color:var(--text-strong)">' + I(t.id === 'exec' ? 'trending-up' : 'shield-check', 14, 'color:var(--ember-600)') + esc(t.name) + '</span>' +
      '<span style="font-size:11.5px;color:var(--text-muted);line-height:1.4">' + esc(t.desc) + '</span>' +
      '<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-faint)">' + t.blocks + ' blocks · ' + esc(t.schedule) + '</span></button>').join('');
    const builder = Card({ eyebrow: 'describe it · natural language', title: 'Report template', children: '<div style="display:flex;flex-direction:column;gap:12px">' +
      '<textarea rows="3" style="' + sty({ width: '100%', boxSizing: 'border-box', resize: 'vertical', border: 'var(--border-rule)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', background: 'var(--surface-page)', boxShadow: 'var(--shadow-inset)', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-strong)', outline: 'none', lineHeight: 1.45 }) + '">Summarise value and trust for web-app this sprint vs last — lead with what moved most.</textarea>' +
      '<div style="display:flex;flex-direction:column;gap:7px">' + EYEBROW('starter templates') + tplBtns + '</div></div>' });
    const delivery = Card({ eyebrow: 'delivery', title: 'Schedule & export', children: '<div style="display:flex;flex-direction:column;gap:12px">' +
      '<div style="display:flex;gap:7px">' + ['slack', 'email', 'teams'].map((c) => '<span style="flex:1;text-align:center;padding:7px 0;border-radius:var(--radius-sm);border:1px solid var(--bone-300);font-family:var(--font-mono);font-size:11px;color:var(--text-body)">' + c + '</span>').join('') + '</div>' +
      Button({ variant: 'primary', block: true, leadingIcon: 'sparkles', label: 'Generate report' }) +
      '<div style="display:flex;gap:8px">' + Button({ variant: 'secondary', size: 'sm', block: true, leadingIcon: 'image', label: 'Poster' }) + Button({ variant: 'ghost', size: 'sm', block: true, leadingIcon: 'download', label: 'CSV · JSON' }) + '</div></div>' });
    return '<div class="page-with-rail">' + DevBadge() +
      '<div class="page-with-rail__grid">' + main +
      '<div style="display:flex;flex-direction:column;gap:var(--space-4)">' + builder + delivery + '</div></div></div>';
  }

  /* ═══ SHELL ═════════════════════════════════════════════════════════════ */
  const NAV = [
    { id: 'overview', label: 'Fleet', icon: 'layout-grid' },
    { id: 'runs', label: 'Runs', icon: 'activity' },
    { id: 'integrity', label: 'Integrity', icon: 'shield-check' },
    { id: 'learning', label: 'Learning', icon: 'brain' },
    { id: 'reports', label: 'Reports', icon: 'file-text' },
  ];
  const TITLES = {
    overview: ['Fleet', 'health across all watched apps'],
    runs: ['Runs', 'pipeline · activity · the live run'],
    integrity: ['Integrity', 'suite health · trust · determinism'],
    learning: ['Learning', 'flywheel · governed ledger · engram'],
    reports: ['Reports', 'ad-hoc value & health reports'],
  };
  function fbSelect(label, opts) {
    return '<label class="fblabel"><span>' + esc(label) + '</span><select class="fbsel">' + opts.map((o) => '<option>' + esc(o) + '</option>').join('') + '</select></label>';
  }
  function filterBar() {
    return '<div class="filterbar">' +
      '<span class="fbtitle">' + I('sliders-horizontal', 13) + 'filters</span>' +
      fbSelect('window', ['last 64 runs', 'last 7d', 'last 30d', 'date range']) +
      fbSelect('app', ['all apps'].concat(D.apps.map((a) => a.name))) +
      fbSelect('mode', ['all', 'diff', 'complete', 'exhaustive', 'manual', 'code']) +
      fbSelect('target', ['all', 'e2e', 'code']) +
      fbSelect('verdict', ['all', 'pass', 'fail', 'flaky', 'invalid', 'infra-error', 'skipped']) +
      '<span class="fbprev">' + I('git-compare-arrows', 13) + 'vs previous window</span>' +
      '<button class="fbexport">' + I('download', 13) + 'CSV · JSON</button></div>';
  }
  function dialogHTML() {
    if (!state.dialog) return '';
    const modes = ['diff', 'complete', 'exhaustive', 'manual'];
    const extras = F.triggerExtras(state.dialogMode);
    const appChips = '<div class="chipset">' + D.apps.map((a) => '<button type="button" class="chip-opt' + (a.name === state.dialogApp ? ' is-on' : '') + '" data-action="dialog-app" data-id="' + esc(a.name) + '">' + esc(a.name) + '</button>').join('') + '</div>';
    const modeChips = '<div class="chipset">' + modes.map((m) => '<button type="button" class="chip-opt mode' + (m === state.dialogMode ? ' is-on' : '') + '" data-action="dialog-mode" data-id="' + m + '">' + m + '</button>').join('') + '</div>';
    const commitOpts = [];
    for (var n = 1; n <= 20; n++) commitOpts.push('<option value="' + n + '"' + (n === state.dialogCommits ? ' selected' : '') + '>' + n + (n === 1 ? ' commit' : ' commits') + '</option>');
    const diffFields = '<div id="trigger-diff" class="dialog-extras"' + (extras.sha ? '' : ' hidden') + '>' +
      Input({ label: 'Commit SHA', leadingIcon: 'git-commit-horizontal', placeholder: 'HEAD of base branch', inputId: 'trigger-sha' }) +
      '<div style="display:flex;flex-direction:column;gap:6px"><span class="pa-eyebrow">delta</span>' +
      '<select id="trigger-commits" class="dselect" aria-label="Commits to analyze">' + commitOpts.join('') + '</select>' +
      '<span class="dialog-hint">How many commits ending at the SHA the diff spans.</span></div></div>';
    const manualFields = '<div id="trigger-manual" class="dialog-extras"' + (extras.guidance ? '' : ' hidden') + '>' +
      '<div style="display:flex;flex-direction:column;gap:6px"><span class="pa-eyebrow">prompt</span>' +
      '<textarea id="trigger-guidance" class="dtextarea" rows="5" maxlength="2000" placeholder="e.g. test the contact form’s validation and the thank-you state"></textarea>' +
      '<span class="dialog-hint">The agent focuses generation on this guidance.</span></div></div>';
    const body = '<div style="display:flex;flex-direction:column;gap:6px"><span class="pa-eyebrow">app</span>' + appChips + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px"><span class="pa-eyebrow">mode</span>' + modeChips + '</div>' +
      diffFields + manualFields;
    return '<div class="dialog-bg pa-scrim" data-action="dialog-bg"><div class="dialog pa-dialog">' +
      '<div class="dialog__head"><div><span class="pa-eyebrow">manual trigger</span><h3 class="dialog__title">Run QA</h3></div>' +
      '<button type="button" class="dialog__x" data-action="dialog-close">' + I('x', 18) + '</button></div>' +
      '<div class="dialog__body">' + body + '</div>' +
      '<div class="dialog__foot">' + Button({ variant: 'ghost', label: 'Cancel', action: 'dialog-close' }) +
      '<button type="button" class="dbtn dbtn--primary" data-action="dialog-submit">' + I('play', 16) + 'Run <span id="trigger-app-label">' + esc(state.dialogApp || '') + '</span></button></div></div></div>';
  }
  function syncTriggerDialog(opts) {
    const extras = F.triggerExtras(state.dialogMode);
    document.querySelectorAll('[data-action="dialog-app"]').forEach(function (el) {
      el.classList.toggle('is-on', el.getAttribute('data-id') === state.dialogApp);
    });
    document.querySelectorAll('[data-action="dialog-mode"]').forEach(function (el) {
      el.classList.toggle('is-on', el.getAttribute('data-id') === state.dialogMode);
    });
    const diff = document.getElementById('trigger-diff');
    const man = document.getElementById('trigger-manual');
    if (diff) diff.hidden = !extras.sha;
    if (man) man.hidden = !extras.guidance;
    const sel = document.getElementById('trigger-commits');
    if (sel) sel.value = String(state.dialogCommits);
    const lbl = document.getElementById('trigger-app-label');
    if (lbl) lbl.textContent = state.dialogApp || '';
    if (opts && opts.focusGuidance) {
      const ta = document.getElementById('trigger-guidance');
      if (ta) ta.focus();
    }
  }
  function bindTriggerDialog() {
    const sel = document.getElementById('trigger-commits');
    if (sel) sel.onchange = function () { state.dialogCommits = F.clampDiffCommits(sel.value); };
  }
  function readTriggerForm() {
    const shaEl = document.getElementById('trigger-sha');
    const gEl = document.getElementById('trigger-guidance');
    return F.triggerPayload({
      app: state.dialogApp,
      mode: state.dialogMode,
      sha: shaEl ? shaEl.value : '',
      commits: state.dialogCommits,
      guidance: gEl ? gEl.value : '',
    });
  }
  function currentView() {
    refreshShaAbbrevs();
    const running = liveRun();
    if (state.appName) { const app = D.apps.find((a) => a.name === state.appName); if (app) return viewAppDetail(app); }
    if (state.runId) {
      if (running && state.runId === running.id) return viewLiveDetail(running);
      const run = D.runs.find((r) => r.id === state.runId);
      if (run) return viewRunDetail(run);
    }
    if (state.section === 'runs') return viewRunsFeed();
    if (state.section === 'integrity') return viewIntegrity();
    if (state.section === 'learning') return viewLearning();
    if (state.section === 'reports') return viewReports();
    return viewOverview();
  }
  function titlePair() {
    const running = liveRun();
    if (running && state.runId === running.id && state.runId) return ['Run ' + running.id, 'live · ' + running.app];
    if (state.runId) { const r = D.runs.find((x) => x.id === state.runId); if (r) return ['Run ' + r.id, 'pipeline · ' + r.app]; }
    if (state.appName) return [state.appName, 'App Value · health & history'];
    return TITLES[state.section] || TITLES.overview;
  }
  // Full render — only on navigation. Rebuilds the shell and plays the view-entrance.
  function render() {
    teardown.forEach((fn) => { try { fn(); } catch (e) {} }); teardown = [];
    const onView = !state.appName && !state.runId;
    const tp = titlePair();
    const showFilters = onView && (state.section === 'overview' || state.section === 'runs' || state.section === 'integrity');
    const activeNav = NAV.find((n) => n.id === state.section) || NAV[0];
    const navLinks = NAV.map((n) => '<button class="side__link' + (onView && n.id === state.section ? ' is-active' : '') + '" data-action="nav" data-id="' + n.id + '">' + I(n.icon, 16) + n.label + '</button>').join('');
    const watch = '<div class="side__watch"><div class="side__watch-h">Watching ' + D.apps.length + '</div>' +
      D.apps.map((a) => '<div class="side__app"><span class="dot' + (a.shadow ? ' shadow' : '') + '"></span><span class="name">' + esc(a.name) + '</span>' + (a.shadow ? '<span class="tag">shadow</span>' : '') + '</div>').join('') + '</div>';
    root.innerHTML =
      '<div class="dash"><aside class="dash__side">' +
      '<a class="side__brand" href="' + esc(CFG.landingUrl || '/') + '"><img src="' + MARK + '" alt=""><span class="side__word">Qayaba</span></a>' +
      '<span class="side__mobile-pill">' + I(activeNav.icon, 15) + activeNav.label + '</span>' +
      '<nav class="side__nav" id="side-nav">' + navLinks + '</nav>' +
      '<button class="side__burger" id="side-burger" aria-label="Menu">' + I('menu', 20) + '</button>' + watch + '</aside>' +
      '<div class="dash__main"><header class="top">' +
      '<div><div class="top__eyebrow">' + esc(tp[1]) + '</div><h1 class="top__title">' + esc(tp[0]) + '</h1></div>' +
      Button({ variant: 'primary', leadingIcon: 'play', label: 'Trigger run', action: 'trigger' }) + '</header>' +
      (showFilters ? filterBar() : '') +
      '<div class="dash__body pa-view" id="dash-view">' + currentView() + '</div></div></div>' +
      '<div id="overlay"></div>';
    renderOverlays();
    refreshIcons();
    mountInteractive();
  }
  // In-view update — same section/run/app. Swaps only the view body, preserves
  // scroll, and does NOT replay the entrance animation.
  function renderView() {
    teardown.forEach((fn) => { try { fn(); } catch (e) {} }); teardown = [];
    const dv = document.getElementById('dash-view');
    if (!dv) { render(); return; }
    const st = dv.scrollTop;
    dv.classList.remove('pa-view');
    dv.innerHTML = currentView();
    dv.scrollTop = st;
    refreshIcons();
    mountInteractive();
  }
  // Overlays (dialog + toast) live outside the shell, so toggling them never
  // touches the scroll container, the view, or the live stream.
  function renderOverlays() {
    const ov = document.getElementById('overlay');
    if (!ov) return;
    ov.innerHTML = dialogHTML() + (state.toastHtml
      ? '<div class="toast">' + I('check', 15) + state.toastHtml + '</div>'
      : (state.toast ? '<div class="toast">' + I('check', 15) + esc(state.toast) + '</div>' : ''));
    refreshIcons();
    bindTriggerDialog();
  }

  /* ── interactive mounts (timers, chat, gauge draw-in) ──────────────────── */
  function mountInteractive() {
    const burger = document.getElementById('side-burger');
    const nav = document.getElementById('side-nav');
    if (burger && nav) burger.onclick = function (e) { e.stopPropagation(); nav.classList.toggle('is-open'); };
    // gauge draw-in
    document.querySelectorAll('.pa-gauge-arc').forEach((el) => requestAnimationFrame(() => { el.style.strokeDashoffset = el.dataset.final; }));
    // overview "running now" timer
    const ovTimers = document.querySelectorAll('.ov-timer');
    if (ovTimers.length) {
      let s = 72;
      const t = setInterval(() => { s++; document.querySelectorAll('.ov-timer').forEach((n) => n.textContent = fmtMMSS(s)); }, 1000);
      teardown.push(() => clearInterval(t));
    }
    if (document.getElementById('live-pipe')) mountLive();
    mountChat();
  }
  function mountLive() {
    if (!LIVE || !LIVE.run || !LIVE.run.__live) return;
    const t1 = setInterval(() => { LIVE.elapsed++; document.querySelectorAll('.live-elapsed').forEach((n) => n.textContent = fmtMMSS(LIVE.elapsed)); }, 1000);
    teardown.push(() => clearInterval(t1));
    const repaint = () => {
      const pipe = document.getElementById('live-pipe'); if (pipe) pipe.innerHTML = livePipeHTML();
      const cs = document.getElementById('live-cases'); if (cs) cs.innerHTML = liveCasesHTML();
      const plan = document.getElementById('live-plan'); if (plan && LIVE.plan && LIVE.plan.length && !plan.hidden) plan.innerHTML = planHTML(LIVE.plan);
      const term = document.getElementById('live-term'); if (term) term.innerHTML = Terminal(LIVE.log);
      refreshIcons();
    };
    // LIVE: drive the view from the server's SSE feed (api.subscribeRun returns an
    // unsubscribe). MOCK: api.subscribeRun returns null → fall through to the local sim.
    const api = apiOf();
    if (api && api.subscribeRun) {
      // Watch the view's own run (not whatever state.runId was) — the SSE feed is authoritative
      // once live data starts flowing, so the mock replay below never runs for a real run.
      const unsub = api.subscribeRun(LIVE.run.id, {
        onLog: (g, t) => { LIVE.log = LIVE.log.concat([[g, t]]); repaint(); },
        onStep: (step, detail) => {
          LIVE.stages = LIVE.stages.map(function (st) {
            if (st[0] === step || step.indexOf(st[0]) >= 0) return [st[0], 'active'];
            return st;
          });
          for (let i = 0; i < LIVE.stages.length; i++) {
            if (LIVE.stages[i][1] === 'active') { for (let j = 0; j < i; j++) LIVE.stages[j][1] = 'done'; }
          }
          LIVE.note = detail || step;
          repaint();
        },
        onPlan: (todos) => { LIVE.plan = (todos || []).map(function (t) { return typeof t === 'string' ? { t: t } : t; }); repaint(); },
        onCase: (name, status, ms) => { let c = LIVE.cases.find((x) => x.name === name); if (!c) { c = { name: name, s: status }; LIVE.cases.push(c); } c.s = status; if (ms != null) c.ms = ms; repaint(); },
        onVerdict: (v) => {
          for (let i = 0; i < LIVE.stages.length; i++) LIVE.stages[i][1] = 'done';
          LIVE.note = 'verdict ' + v; repaint();
          // Terminal-ish refresh: brief pause, then reload the model so the finished record
          // shows real cases/coverage instead of the live skeleton (SSE event precedes DB commit).
          setTimeout(function () { loadAndRender(); }, 1400);
        },
        onError: () => {},
      });
      if (unsub) { teardown.push(unsub); return; }
    }
    if (reduceMotion()) return;
    const queue = (LIVE.queue || []).slice(0, 5); let qi = 0;
    const t2 = setInterval(() => {
      if (qi < queue.length) LIVE.log = LIVE.log.concat([queue[qi]]);
      const cs = LIVE.cases;
      const ri = cs.findIndex((c) => c.s === 'running'); if (ri >= 0) { cs[ri].s = 'pass'; cs[ri].ms = MS[ri]; }
      const pi = cs.findIndex((c) => c.s === 'pending'); if (pi >= 0) cs[pi].s = 'running';
      const notes = ['renders empty-state for zero results', '4 cases green · 11.8s', 'oracle · mutation testing · 18 mutants'];
      LIVE.note = notes[Math.min(qi, notes.length - 1)];
      qi++; repaint();
      if (qi >= queue.length) {
        clearInterval(t2);
        const t3 = setTimeout(() => {
          LIVE.stages = LIVE.stages.map(([n, s]) => n === 'execute' ? [n, 'done'] : n === 'decide' ? [n, 'active'] : [n, s]);
          LIVE.note = 'oracle green · choosing PR vs Issue'; repaint();
        }, 1600);
        teardown.push(() => clearTimeout(t3));
      }
    }, 1900);
    teardown.push(() => clearInterval(t2));
  }
  function currentRunForChat() {
    const running = liveRun();
    if (running && state.runId === running.id) return running;
    return D.runs.find((r) => r.id === state.runId) || running;
  }
  function mountChat() {
    const box = document.querySelector('[data-chat]'); if (!box) return;
    const live = box.getAttribute('data-chat') === 'live';
    const run = currentRunForChat();
    if (!run) return;
    const thread = box.querySelector('[data-chat-thread]');
    const input = box.querySelector('[data-chat-input]');
    const sendBtn = box.querySelector('[data-chat-send]');
    let thinking = false;
    const scroll = () => { thread.scrollTop = thread.scrollHeight; };
    const add = (who, text, kind) => { thread.insertAdjacentHTML('beforeend', chatBubble(who, text, kind)); refreshIcons(); scroll(); };
    const setDisabled = () => {
      const on = !!input.value.trim();
      sendBtn.disabled = !on;
      sendBtn.style.background = on ? 'var(--ember-500)' : 'var(--bone-300)';
      sendBtn.style.color = on ? 'var(--bone-50)' : 'var(--text-faint)';
      sendBtn.style.cursor = on ? 'pointer' : 'not-allowed';
    };
    const humanizeAskError = (err) => {
      const msg = err && err.message ? String(err.message) : '';
      if (/401/.test(msg)) return 'Session expired — reload to sign in again.';
      if (/404/.test(msg)) return 'This run is not in history yet. If it just started, wait a moment and try again.';
      if (/502|503/.test(msg)) return 'The assistant could not answer (the pipeline may be using the model). Try again in a moment.';
      return msg || 'The assistant did not return an answer.';
    };
    const send = (text) => {
      const q = (text == null ? input.value : text).trim();
      if (!q || thinking) return;
      add('you', q); input.value = ''; setDisabled(); thinking = true;
      thread.insertAdjacentHTML('beforeend', typingBubble()); refreshIcons(); scroll();
      const finish = (answer, kind) => { thinking = false; const tb = thread.querySelector('[data-typing]'); if (tb) tb.remove(); add('agent', answer, kind); };
      const apply = (apiAnswer, apiError) => {
        const picked = F.pickChatAnswer({
          mode: CFG.mode,
          apiAnswer: apiAnswer,
          apiError: apiError,
          canned: chatAnswer(run, live, q),
        });
        finish(picked.text, picked.kind);
      };
      const api = apiOf();
      const p = api && api.ask ? api.ask(run.id, q) : Promise.resolve(null);
      p.then((answer) => apply(answer, null)).catch((err) => apply(null, humanizeAskError(err)));
    };
    input.addEventListener('input', setDisabled);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    sendBtn.addEventListener('click', () => send());
    box.querySelectorAll('[data-sugg]').forEach((b) => b.addEventListener('click', () => send(b.getAttribute('data-sugg'))));
    setDisabled();
  }

  /* ── routing + navigation ──────────────────────────────────────────────── */
  function initAppSel(name) {
    const h = D.histories[name] || [];
    state.appSel = { a: 0, b: Math.max(0, h.length - 1) };
    state.appTab = 'runs';
  }
  function syncFromUrl() {
    const params = new URLSearchParams(location.search);
    const run = params.get('run'), app = params.get('app');
    const hash = (location.hash || '').replace('#', '');
    state.runId = null; state.appName = null;
    if (run && ((liveRun() && run === liveRun().id) || D.runs.some((r) => r.id === run))) { state.runId = run; state.section = 'runs'; }
    else if (app && D.apps.some((a) => a.name === app)) { state.appName = app; state.section = 'overview'; initAppSel(app); }
    else state.section = TITLES[hash] ? hash : 'overview';
  }
  function go(section) { state.section = section; state.runId = null; state.appName = null; history.pushState({ section: section }, '', '#' + section); render(); }
  function openRun(id) { state.runId = id; state.appName = null; state.section = 'runs'; history.pushState({ run: id }, '', '?run=' + encodeURIComponent(id)); render(); }
  function openApp(name) { state.appName = name; state.runId = null; state.section = 'overview'; initAppSel(name); history.pushState({ app: name }, '', '?app=' + encodeURIComponent(name)); render(); }
  function backToRuns() { state.runId = null; state.section = 'runs'; history.pushState({ section: 'runs' }, '', '#runs'); render(); }
  function backToFleet() { state.appName = null; state.section = 'overview'; history.pushState({ section: 'overview' }, '', '#overview'); render(); }
  function showToast(msg) { showToastHtml(esc(msg), 2600); }
  // Toast other than plain text: callers may embed a [data-action] button (e.g. open the run).
  function showToastHtml(html, ttl) { state.toastHtml = html; state.toast = null; renderOverlays(); clearTimeout(toastTimer); toastTimer = setTimeout(() => { state.toastHtml = null; renderOverlays(); }, ttl || 2600); }

    // reload the model in place (model refresh WITHOUT navigation) and repaint the current view.
  async function loadAndRender() {
    try {
      const data = await api.loadAll();
      D = data;
      refreshShaAbbrevs();
      render();
    } catch (err) { /* keep the current view; a refresh failure must not break the session */ }
  }

  // Follow a queued run's verdict via its SSE feed. When the verdict lands, refresh the model
  // once and surface a "view run" toast — without stealing the screen the operator is on.
  function queueVerdictWatch(runId) {
    if (!api || !api.subscribeRun) return;
    state.toastingRunId = runId;
    api.subscribeRun(runId, {
      onVerdict: () => {
        setTimeout(() => {
          loadAndRender().then(() => {
            state.toast = null; state.toastHtml = null;
            state.toastingRunId = runId;
            renderOverlays();
            state.toast = null;
            state.toastHtml = '<div style="display:flex;align-items:center;gap:14px"><span>run ' + esc(runId.slice(-6)) + ' finished · </span>' +
              '<button data-action="toast-run" style="display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border-rule);background:transparent;cursor:pointer;font-family:var(--font-mono);font-size:11px;padding:4px 10px;border-radius:var(--radius-xs);color:var(--ember-600)">view run ' + I('arrow-right', 12) + '</button></div>';
            renderOverlays();
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => { state.toastHtml = null; renderOverlays(); }, 600000);
          });
        }, 1200);
      },
      onError: () => {},
    });
  }

  root.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) {
      const nav2 = document.getElementById('side-nav');
      if (nav2 && nav2.classList.contains('is-open')) nav2.classList.remove('is-open');
      return;
    }
    const action = el.dataset.action, id = el.dataset.id;
    // navigation → full render (entrance animation, fresh scroll)
    if (action === 'nav') go(id);
    else if (action === 'open-run') openRun(id);
    else if (action === 'open-app') openApp(id);
    else if (action === 'back-runs') backToRuns();
    else if (action === 'back-fleet') backToFleet();
    else if (action === 'cancel') { const rid = liveRun() && liveRun().id; const api = apiOf(); if (rid && api && api.cancelRun) api.cancelRun(rid); state.runId = null; state.section = 'runs'; history.pushState({ section: 'runs' }, '', '#runs'); render(); showToast('run ' + rid + ' cancelled · working copy discarded'); }
    // in-view → swap only the view body (no entrance, scroll preserved)
    else if (action === 'runfilter') { state.runFilter = id; renderView(); }
    else if (action === 'rep-tpl') { state.repTpl = id; renderView(); }
    else if (action === 'rep-view') { state.repView = id; renderView(); }
    // surgical → mutate just the affected widgets, smoothly
    else if (action === 'apptab') setAppTab(id);
    else if (action === 'apppick') { const i = parseInt(id, 10); const s = state.appSel; state.appSel = (i === s.a || i === s.b) ? s : { a: s.b, b: i }; updateAppChart(); }
    else if (action === 'apppreset') { const h = D.histories[state.appName] || []; const last = h.length - 1; state.appSel = id === 'first' ? { a: 0, b: last } : { a: Math.max(0, last - 1), b: last }; updateAppChart(); }
    // overlays → never touch the view
    else if (action === 'trigger') { state.dialog = 'trigger'; renderOverlays(); }
    else if (action === 'dialog-bg') { if (e.target.classList && e.target.classList.contains('dialog-bg')) { state.dialog = false; renderOverlays(); } }
    else if (action === 'dialog-close') { state.dialog = false; renderOverlays(); }
    else if (action === 'dialog-app') { state.dialogApp = id; syncTriggerDialog(); }
    else if (action === 'dialog-mode') {
      const prev = state.dialogMode;
      state.dialogMode = id;
      syncTriggerDialog({ focusGuidance: id === 'manual' && prev !== 'manual' });
    }
    else if (action === 'dialog-submit') {
      const body = readTriggerForm();
      const api = apiOf();
      state.dialog = false;
      renderOverlays();
      showToast('queuing ' + body.app + ' · ' + body.mode + ' mode');
      if (api && api.createRun) {
        api.createRun(body).then((res) => {
          const newId = res && res.id && res.id !== 'queued' ? res.id : null;
          if (!newId) return;
          // Queued → watch. Reload the model so the run exists in the fleet list, then follow
          // the live verdict; when it lands the view refreshes by itself (and offers the jump).
          showToast('queued ' + body.app + ' · ' + body.mode + ' mode · run ' + newId.slice(-6));
          loadAndRender().then(() => queueVerdictWatch(newId));
        }).catch(() => { showToast('could not queue the run'); });
      }
    }
    else if (action === 'toast-run') {
      state.toast = null; renderOverlays();
      if (state.toastingRunId) openRun(state.toastingRunId);
    }
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.dialog) { state.dialog = false; renderOverlays(); } });
  window.addEventListener('popstate', () => { if (D) { syncFromUrl(); render(); } });

  /* ── boot: load the model from the data layer, then render ─────────────── */
  function loadingScreen() {
    root.innerHTML = '<div style="height:100vh;display:grid;place-items:center;background:var(--surface-page);color:var(--text-muted);font-family:var(--font-mono);font-size:13px">' +
      '<div style="display:flex;align-items:center;gap:10px"><span style="width:9px;height:9px;border-radius:50%;background:var(--ember-500);animation:pa-pulse 1.4s var(--ease-out) infinite"></span>loading console…</div></div>';
  }
  function errorScreen(err) {
    root.innerHTML = '<div style="height:100vh;display:grid;place-items:center;background:var(--surface-page);color:var(--text-body);font-family:var(--font-mono);font-size:13px;padding:24px;text-align:center">' +
      '<div><div style="color:var(--fail-600);font-weight:700;margin-bottom:8px">Could not load the console</div><div style="color:var(--text-muted)">' + esc(String(err && err.message || err)) + '</div></div></div>';
  }
  const api = apiOf();
  if (!api) { errorScreen('data layer (api.js) not loaded'); return; }

  const loginScreen = document.getElementById('login-screen');

  function bootConsole() {
    if (loginScreen) loginScreen.style.display = 'none';
    loadingScreen();
    api.loadAll().then(function (data) {
      D = data;
      refreshShaAbbrevs();
      state.dialogApp = (D.apps && D.apps[0] && D.apps[0].name) || null;
      syncFromUrl();
      render();
    }).catch(errorScreen);
  }

  function bindLoginScreen() {
    if (loginScreen) loginScreen.style.display = 'grid';
    const btnGithub = document.getElementById('btn-github-login');
    const btnToken = document.getElementById('btn-token-login');
    const tokenInput = document.getElementById('token-input');
    const deviceCodeDiv = document.getElementById('github-device-code');
    const deviceCodeDisplay = document.getElementById('device-code-display');
    const verificationLink = document.getElementById('verification-link');
    const loginStatus = document.getElementById('login-status');
    const loginError = document.getElementById('login-error');
    let pollInterval = null;

    btnGithub.addEventListener('click', async () => {
      try {
        loginError.style.display = 'none';
        loginStatus.textContent = 'Requesting device code...';
        const versionRes = await fetch('/api/v1/version');
        const versionData = await versionRes.json();
        const clientId = versionData.githubClientId;
        if (!clientId) throw new Error('GitHub OAuth not configured on server');
        const deviceRes = await fetch('https://github.com/login/device/code', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, scope: 'repo' })
        });
        const deviceData = await deviceRes.json();
        deviceCodeDisplay.textContent = deviceData.user_code;
        verificationLink.href = deviceData.verification_uri;
        deviceCodeDiv.style.display = 'block';
        loginStatus.textContent = 'Waiting for approval...';
        const interval = (deviceData.interval || 5) * 1000;
        const expiresIn = (deviceData.expires_in || 900) * 1000;
        const startTime = Date.now();
        pollInterval = setInterval(async () => {
          if (Date.now() - startTime > expiresIn) {
            clearInterval(pollInterval);
            loginStatus.textContent = 'Code expired. Please try again.';
            return;
          }
          try {
            const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
              method: 'POST',
              headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
              body: JSON.stringify({
                client_id: clientId,
                device_code: deviceData.device_code,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
              })
            });
            const tokenData = await tokenRes.json();
            if (tokenData.access_token) {
              clearInterval(pollInterval);
              loginStatus.textContent = 'Authenticating...';
              const loginRes = await fetch('/api/v1/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ githubToken: tokenData.access_token })
              });
              if (!loginRes.ok) throw new Error('Backend authentication failed');
              const loginData = await loginRes.json();
              sessionStorage.setItem('qayaba_token', loginData.token);
              loginScreen.style.display = 'none';
              window.location.reload();
            } else if (tokenData.error === 'authorization_pending') {
              // keep polling
            } else if (tokenData.error === 'slow_down') {
              clearInterval(pollInterval);
              pollInterval = setInterval(arguments.callee, interval * 2);
            } else {
              throw new Error(tokenData.error_description || 'Authentication failed');
            }
          } catch (err) {
            clearInterval(pollInterval);
            loginError.textContent = err.message;
            loginError.style.display = 'block';
          }
        }, interval);
      } catch (err) {
        loginError.textContent = err.message;
        loginError.style.display = 'block';
      }
    });

    btnToken.addEventListener('click', async () => {
      try {
        loginError.style.display = 'none';
        const token = tokenInput.value.trim();
        if (!token) throw new Error('Please enter a token');
        const testRes = await fetch('/api/v1/apps', { headers: { 'Authorization': 'Bearer ' + token } });
        if (!testRes.ok) throw new Error('Invalid token');
        sessionStorage.setItem('qayaba_token', token);
        loginScreen.style.display = 'none';
        window.location.reload();
      } catch (err) {
        loginError.textContent = err.message;
        loginError.style.display = 'block';
      }
    });
  }

  function start() {
    const storedToken = sessionStorage.getItem('qayaba_token');
    if (storedToken || CFG.mode !== 'live') {
      bootConsole();
      return;
    }
    loadingScreen();
    const localUrl = ((window.QayabaConsole && window.QayabaConsole.config && window.QayabaConsole.config.baseUrl) || '') + '/api/v1/auth/local';
    fetch(localUrl, { credentials: 'include' }).then(function (r) {
      if (!r.ok) throw new Error('no local session');
      return r.json();
    }).then(function (data) {
      if (!data || !data.token) throw new Error('no local session');
      sessionStorage.setItem('qayaba_token', data.token);
      window.location.reload();
    }).catch(function () {
      bindLoginScreen();
    });
  }

  start();
})();

