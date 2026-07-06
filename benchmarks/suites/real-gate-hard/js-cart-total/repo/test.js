const total = require('./cart.js');
const close = (a, b) => Math.abs(a - b) < 1e-6;
const T = [
  [[[{price:10,qty:2}], 0, 0], 20],
  [[[{price:10,qty:2}], 10, 0], 18],          // discount only
  [[[{price:10,qty:2}], 0, 10], 22],          // tax only
  [[[{price:10,qty:2}], 10, 10], 19.8],       // discount THEN tax
  [[[], 50, 20], 0],                          // empty cart
  [[[{price:1,qty:1},{price:2,qty:2}], 0, 0], 5],   // multiple items + qty
  [[[{price:5,qty:4}], 25, 0], 15],           // 20 - 25%
];
for (const [args, exp] of T) {
  const got = total(JSON.parse(JSON.stringify(args[0])), args[1], args[2]);
  if (!close(got, exp)) {
    console.error('FAIL', JSON.stringify(args), '=>', got, 'expected', exp);
    process.exit(1);
  }
}
console.log('ALL PASS');
