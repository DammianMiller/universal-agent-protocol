module.exports = function mergeIntervals(intervals) {
  for (const [s, e] of intervals) if (s > e) throw new RangeError('start > end');
  const sorted = intervals.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push(cur);
  }
  return out;
};
