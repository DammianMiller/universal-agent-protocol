module.exports = function wordWrap(text, width) {
  if (!Number.isInteger(width) || width < 1) throw new Error('width must be a positive integer');
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/ +/).filter((w) => w !== '');
    if (words.length === 0) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      if (line === '') { line = w; continue; }
      if (line.length + 1 + w.length <= width) line += ' ' + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out.join('\n');
};
