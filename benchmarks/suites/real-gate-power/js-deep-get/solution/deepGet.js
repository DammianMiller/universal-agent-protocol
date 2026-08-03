module.exports = function deepGet(obj, path, fallback) {
  if (path === '') return obj;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return fallback;
    if (!(p in Object(cur))) return fallback;
    cur = cur[p];
  }
  return cur;
};
