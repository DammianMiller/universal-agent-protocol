const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = function globMatch(pattern, str) {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      const n = pattern[i + 1];
      if (n === undefined) throw new Error('trailing escape');
      re += esc(n); i += 2; continue;
    }
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i++; continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (pattern[j] === '!' || pattern[j] === '^') { neg = true; j++; }
      let cls = '';
      if (pattern[j] === ']') { cls += '\\]'; j++; }
      while (j < pattern.length && pattern[j] !== ']') {
        const ch = pattern[j];
        if (ch === '\\') { cls += '\\' + pattern[j + 1]; j += 2; continue; }
        cls += ch === '^' ? '\\^' : ch;
        j++;
      }
      if (j >= pattern.length) throw new Error('unterminated character class');
      re += '[' + (neg ? '^' : '') + cls + ']';
      i = j + 1; continue;
    }
    re += esc(c); i++;
  }
  return new RegExp(re + '$').test(str);
};
