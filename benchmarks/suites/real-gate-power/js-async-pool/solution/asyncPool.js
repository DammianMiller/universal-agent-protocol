module.exports = async function asyncPool(limit, items, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const results = new Array(items.length);
  let next = 0;
  let failed = null;
  const workerCount = Math.min(limit, items.length);
  const workers = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      for (;;) {
        if (failed) return;
        const idx = next++;
        if (idx >= items.length) return;
        try {
          results[idx] = await fn(items[idx], idx);
        } catch (e) {
          if (!failed) failed = e;
          return;
        }
      }
    })());
  }
  await Promise.all(workers);
  if (failed) throw failed;
  return results;
};
