/* Null-safe numeric formatting for the live dashboard.
   SignalsView paints absence as null (never a hard 0). Calling .toFixed on that
   null — or on multiplier(0, 0) which returns null — used to blank the console. */
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
  return { fixed: fixed, multiplierLabel: multiplierLabel };
})();
