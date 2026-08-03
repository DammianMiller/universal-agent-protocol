module.exports = function parseRange(size, header) {
  if (typeof header !== 'string') return -2;
  const idx = header.indexOf('=');
  if (idx === -1) return -2;
  const type = header.slice(0, idx).trim();
  if (type === '') return -2;
  const specs = header.slice(idx + 1).split(',');
  const ranges = [];
  ranges.type = type;
  let sawValid = false;
  for (const raw of specs) {
    const spec = raw.trim();
    const dash = spec.indexOf('-');
    if (dash === -1) return -2;
    const startStr = spec.slice(0, dash).trim();
    const endStr = spec.slice(dash + 1).trim();
    if (startStr === '' && endStr === '') return -2;
    let start;
    let end;
    if (startStr === '') {
      const n = Number(endStr);
      if (!Number.isInteger(n) || n < 0) return -2;
      sawValid = true;
      if (n === 0) continue;              // -0 is unsatisfiable
      start = Math.max(size - n, 0);
      end = size - 1;
    } else {
      start = Number(startStr);
      if (!Number.isInteger(start) || start < 0) return -2;
      if (endStr === '') end = size - 1;
      else {
        end = Number(endStr);
        if (!Number.isInteger(end) || end < 0) return -2;
        if (start > end) return -2;
      }
      sawValid = true;
      if (start >= size) continue;        // unsatisfiable
      if (end > size - 1) end = size - 1;
    }
    if (start > end) continue;
    ranges.push({ start, end });
  }
  if (!sawValid) return -2;
  if (ranges.length === 0) return -1;
  return ranges;
};
