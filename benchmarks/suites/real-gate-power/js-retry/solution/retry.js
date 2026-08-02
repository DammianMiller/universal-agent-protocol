module.exports = function retry(fn, opts) {
  const { attempts = 3, onRetry } = opts || {};
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts');
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return fn(); } catch (e) {
      last = e;
      if (i < attempts && onRetry) onRetry(e, i);
    }
  }
  throw last;
};
