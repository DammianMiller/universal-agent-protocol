const PAIRS = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) throw new RangeError('out of range: ' + n);
  let out = '';
  let rest = n;
  for (const [v, sym] of PAIRS) {
    while (rest >= v) { out += sym; rest -= v; }
  }
  return out;
}

const VALUE = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

function fromRoman(s) {
  if (typeof s !== 'string' || s === '') throw new Error('empty numeral');
  if (!/^[IVXLCDM]+$/.test(s)) throw new Error('invalid characters');
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = VALUE[s[i]];
    const next = VALUE[s[i + 1]];
    total += next !== undefined && next > cur ? -cur : cur;
  }
  if (total < 1 || total > 3999) throw new Error('out of range');
  // Canonicality: only one spelling round-trips.
  if (toRoman(total) !== s) throw new Error('non-canonical numeral: ' + s);
  return total;
}

module.exports = { toRoman, fromRoman };
