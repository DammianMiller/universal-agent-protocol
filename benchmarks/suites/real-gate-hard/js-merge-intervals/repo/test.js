const merge = require('./intervals.js');
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
const cases = [
  [[[1,3],[2,6],[8,10],[15,18]], [[1,6],[8,10],[15,18]]],
  [[[1,4],[4,5]], [[1,5]]],               // touching endpoints merge
  [[[1,4],[2,3]], [[1,4]]],               // fully contained
  [[[5,6],[1,2]], [[1,2],[5,6]]],         // unsorted, disjoint
  [[], []],                               // empty
  [[[1,4]], [[1,4]]],                     // single
];
for (const [inp, exp] of cases) {
  const got = merge(JSON.parse(JSON.stringify(inp)));
  if (!eq(got, exp)) {
    console.error('FAIL', JSON.stringify(inp), '=>', JSON.stringify(got), 'expected', JSON.stringify(exp));
    process.exit(1);
  }
}
console.log('ALL PASS');
