function chunks(s) {
  return String(s).match(/\d+|\D+/g) || [];
}

function cmp(a, b) {
  const ca = chunks(a);
  const cb = chunks(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i];
    const y = cb[i];
    const xd = /^\d/.test(x);
    const yd = /^\d/.test(y);
    if (xd && yd) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
      continue;
    }
    if (xd !== yd) return xd ? -1 : 1;
    const lx = x.toLowerCase();
    const ly = y.toLowerCase();
    if (lx !== ly) return lx < ly ? -1 : 1;
    if (x !== y) return x < y ? 1 : -1;   // lowercase first
  }
  if (ca.length !== cb.length) return ca.length < cb.length ? -1 : 1;
  return 0;
}

module.exports = function naturalSort(arr) {
  return arr.map((v, i) => [v, i]).sort((p, q) => cmp(p[0], q[0]) || p[1] - q[1]).map((p) => p[0]);
};
