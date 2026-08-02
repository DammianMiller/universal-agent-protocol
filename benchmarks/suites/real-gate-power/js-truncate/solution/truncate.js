module.exports = function truncate(str, maxLen, ellipsis) {
  const ell = ellipsis === undefined ? '…' : ellipsis;
  if (maxLen < ell.length) throw new RangeError('maxLen shorter than ellipsis');
  const s = String(str);
  if (s.length <= maxLen) return s;
  const budget = maxLen - ell.length;
  const slice = s.slice(0, budget);
  const sp = slice.lastIndexOf(' ');
  const body = sp > 0 ? slice.slice(0, sp) : slice;
  return body.replace(/\s+$/, '') + ell;
};
