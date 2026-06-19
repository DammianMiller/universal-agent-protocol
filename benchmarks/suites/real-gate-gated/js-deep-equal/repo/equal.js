// deepEqual(a, b) -> boolean. Structural equality for nested objects/arrays.
// Edge contract: NaN equals NaN; key order does NOT matter; {a:undefined} is
// NOT equal to {}; arrays compared element-wise; null !== undefined.
module.exports = function deepEqual(a, b) {
  return false;
};
