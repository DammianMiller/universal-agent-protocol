'use strict';
// Implement createOrders(warehouse) per the task instruction.
function createOrders(warehouse) {
  // TODO
  return {
    placeOrder(lines) { return { ok: false, reason: 'unimplemented' }; },
    fulfill(orderId) { return false; },
    cancel(orderId) { return false; },
  };
}
module.exports = { createOrders };
