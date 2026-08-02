function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(String(v));
  if (!m) throw new TypeError('bad version: ' + v);
  return { n: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : null };
}
module.exports = function compare(a, b) {
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) if (A.n[i] !== B.n[i]) return A.n[i] < B.n[i] ? -1 : 1;
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  const len = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < len; i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};
