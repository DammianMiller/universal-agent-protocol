module.exports = function groupBy(items, keyFn) {
  const out = Object.create(null);
  items.forEach((item, i) => {
    const k = String(keyFn(item, i));
    if (!out[k]) out[k] = [];
    out[k].push(item);
  });
  return out;
};
