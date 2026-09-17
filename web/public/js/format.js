/* Null-safe numeric formatting for the live dashboard.
   SignalsView paints absence as null (never a hard 0). Calling .toFixed on that
   null — or on multiplier(0, 0) which returns null — used to blank the console.
   Also: git-style SHA abbrevs, XSS-safe markdown for Ask Qayaba, and the live-vs-mock
   chat policy (live mode must never fall back to the demo canned line).
 */
window.QayabaFormat = (function () {
  function isNum(n) {
    return typeof n === 'number' && Number.isFinite(n);
  }
  function fixed(n, digits, empty) {
    if (!isNum(n)) return empty == null ? 'n/a' : empty;
    return n.toFixed(digits);
  }
  function multiplierLabel(cur, prev) {
    if (!isNum(cur) || !isNum(prev) || prev === 0) return 'n/a';
    return '×' + (cur / prev).toFixed(1);
  }

  /* Shortest unique prefix among a set, min 7 — the same rule git uses for
     `log --oneline` / `rev-parse --short` once uniqueness is required.
   */
  function uniqueAbbrevs(shas, minLen) {
    const min = minLen == null ? 7 : minLen;
    const list = (shas || []).map(function (s) { return String(s == null ? '' : s); });
    return list.map(function (sha, i) {
      if (!sha || sha.length <= min) return sha;
      var n = min;
      while (n < sha.length) {
        var prefix = sha.slice(0, n);
        var clash = false;
        for (var j = 0; j < list.length; j++) {
          if (j === i || list[j] === sha) continue;
          if (list[j].slice(0, n) === prefix) { clash = true; break; }
        }
        if (!clash) return prefix;
        n++;
      }
      return sha;
    });
  }

  /* Last path segment of owner/name or a git URL — the repo the run executed on. */
  function shortRepo(repo) {
    var s = String(repo == null ? '' : repo).trim();
    if (!s) return '';
    s = s.replace(/\.git$/, '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function inlineMd(s) {
    var t = escapeHtml(s);
    t = t.replace(/`([^`]+)`/g, '<code class="chat-code">$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return t;
  }
  function renderMarkdown(md) {
    var raw = String(md == null ? '' : md).replace(/\r\n/g, '\n');
    var fences = [];
    var text = raw.replace(/```[^\n]*\n([\s\S]*?)```/g, function (_, code) {
      fences.push('<pre class="chat-pre"><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>');
      return '\0F' + (fences.length - 1) + '\0';
    });
    return text.split(/\n{2,}/).map(function (block) {
      var t = block.trim();
      if (!t) return '';
      var fence = t.match(/^\0F(\d+)\0$/);
      if (fence) return fences[Number(fence[1])];
      var heading = t.match(/^(#{1,3})\s+(.+)$/m);
      if (heading && t.indexOf('\n') === -1) {
        var lvl = heading[1].length;
        return '<h' + lvl + ' class="chat-h">' + inlineMd(heading[2]) + '</h' + lvl + '>';
      }
      if (/^[-*]\s/m.test(t)) {
        var items = t.split(/\n/).filter(Boolean).map(function (line) {
          return '<li>' + inlineMd(line.replace(/^[-*]\s+/, '')) + '</li>';
        }).join('');
        return '<ul class="chat-ul">' + items + '</ul>';
      }
      return '<p>' + inlineMd(t).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  function pickChatAnswer(opts) {
    opts = opts || {};
    if (opts.mode === 'live') {
      if (opts.apiAnswer) return { text: String(opts.apiAnswer), kind: 'assistant' };
      var err = opts.apiError ? String(opts.apiError) : 'The assistant did not return an answer. Try again in a moment.';
      return { text: err, kind: 'error' };
    }
    return { text: String(opts.canned == null ? '' : opts.canned), kind: 'canned' };
  }

  /* Overlay a real in-flight run onto the live-view shape. Identity always
     comes from the real record so Ask hits POST /runs/:realId/ask, not the
     mock r-1842 demo id. Missing live theatre fields (plan/currentTest) stay
     from the mock so viewLiveDetail does not crash.
   */
  function mergeLiveRun(real, mock) {
    if (!real) return null;
    var out = {};
    if (mock) for (var k in mock) out[k] = mock[k];
    for (var r in real) {
      var v = real[r];
      if (v == null || v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[r] = v;
    }
    out.id = real.id;
    out.sha = real.sha;
    out.app = real.app;
    if (Object.prototype.hasOwnProperty.call(real, 'message')) out.message = real.message;
    return out;
  }

  function triggerExtras(mode) {
    var m = String(mode == null ? '' : mode);
    return {
      sha: m === 'diff',
      delta: m === 'diff',
      guidance: m === 'manual',
    };
  }
  function clampDiffCommits(n) {
    var v = typeof n === 'number' ? n : parseInt(String(n == null ? '' : n), 10);
    if (!Number.isFinite(v)) return 1;
    if (v < 1) return 1;
    if (v > 20) return 20;
    return v;
  }
  function triggerPayload(input) {
    input = input || {};
    var mode = String(input.mode == null ? 'diff' : input.mode);
    var extras = triggerExtras(mode);
    var body = { app: String(input.app == null ? '' : input.app), mode: mode };
    if (extras.sha) {
      var sha = String(input.sha == null ? '' : input.sha).trim();
      if (/^[0-9a-f]{7,40}$/i.test(sha)) body.sha = sha;
    }
    if (extras.delta) {
      var commits = clampDiffCommits(input.commits);
      if (commits > 1) body.commits = commits;
    }
    if (extras.guidance) {
      var g = String(input.guidance == null ? '' : input.guidance).trim().slice(0, 2000);
      if (g) body.guidance = g;
    }
    return body;
  }

  return {
    fixed: fixed,
    multiplierLabel: multiplierLabel,
    uniqueAbbrevs: uniqueAbbrevs,
    shortRepo: shortRepo,
    renderMarkdown: renderMarkdown,
    pickChatAnswer: pickChatAnswer,
    mergeLiveRun: mergeLiveRun,
    triggerExtras: triggerExtras,
    clampDiffCommits: clampDiffCommits,
    triggerPayload: triggerPayload,
  };
})();
