const dec = (s) => decodeURIComponent(String(s).replace(/\+/g, ' '));
module.exports = function parseQuery(qs) {
  const out = {};
  const body = String(qs || '').replace(/^\?/, '');
  if (!body) return out;
  for (const pair of body.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = dec(eq === -1 ? pair : pair.slice(0, eq));
    const v = eq === -1 ? '' : dec(pair.slice(eq + 1));
    if (k in out) { if (Array.isArray(out[k])) out[k].push(v); else out[k] = [out[k], v]; }
    else out[k] = v;
  }
  return out;
};
