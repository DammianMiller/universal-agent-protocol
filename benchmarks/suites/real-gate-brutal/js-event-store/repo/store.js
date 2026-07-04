'use strict';
// Implement createStore(reducer, snapshotEvery) per the task instruction.
function createStore(reducer, snapshotEvery) {
  // TODO
  return {
    append(event) {},
    version() { return 0; },
    stateAt(v) { return undefined; },
    events() { return []; },
  };
}
module.exports = { createStore };
