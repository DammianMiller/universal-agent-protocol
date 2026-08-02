module.exports = function balanced(str) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (pairs[c]) { if (stack.pop() !== pairs[c]) return false; }
  }
  return quote === null && stack.length === 0;
};
