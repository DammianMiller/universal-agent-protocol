module.exports = function get(doc, pointer) {
  if (pointer === '') return doc;
  if (typeof pointer !== 'string' || pointer[0] !== '/') throw new Error('invalid JSON pointer');
  const parts = pointer.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = doc;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(p)) return undefined;
      const idx = Number(p);
      if (idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
      cur = cur[p];
    }
  }
  return cur;
};
