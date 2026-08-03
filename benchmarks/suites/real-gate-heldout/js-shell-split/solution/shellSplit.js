module.exports = function shellSplit(line) {
  const s = String(line);
  const out = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      i++; continue;
    }
    if (c === "'") {
      has = true; i++;
      let closed = false;
      while (i < s.length) {
        if (s[i] === "'") { closed = true; i++; break; }
        cur += s[i]; i++;
      }
      if (!closed) throw new Error('unterminated single quote');
      continue;
    }
    if (c === '"') {
      has = true; i++;
      let closed = false;
      while (i < s.length) {
        if (s[i] === '"') { closed = true; i++; break; }
        if (s[i] === '\\') {
          const nxt = s[i + 1];
          if (nxt === undefined) throw new Error('trailing backslash');
          if (nxt === '\\' || nxt === '"' || nxt === '$' || nxt === '`') { cur += nxt; i += 2; continue; }
          cur += '\\'; i++; continue;
        }
        cur += s[i]; i++;
      }
      if (!closed) throw new Error('unterminated double quote');
      continue;
    }
    if (c === '\\') {
      const nxt = s[i + 1];
      if (nxt === undefined) throw new Error('trailing backslash');
      cur += nxt; has = true; i += 2; continue;
    }
    cur += c; has = true; i++;
  }
  if (has) out.push(cur);
  return out;
};
