'use strict';
// Implement createRouter() per the task instruction.
function createRouter() {
  // TODO
  return {
    add(method, pattern, handler) {},
    use(fn) {},
    dispatch(method, path) {
      return { status: 404, body: null, params: {} };
    },
  };
}
module.exports = { createRouter };
