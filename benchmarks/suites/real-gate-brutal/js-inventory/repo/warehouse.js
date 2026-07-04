'use strict';
// BUGGY: reserve() checks on-hand only (oversells against active reservations),
// release() double-credits when called twice, confirm() is missing.
function createWarehouse() {
  const onHand = new Map();
  const reservations = new Map();
  let nextId = 1;
  return {
    add(sku, qty) {
      onHand.set(sku, (onHand.get(sku) || 0) + qty);
    },
    available(sku) {
      return onHand.get(sku) || 0;
    },
    reserve(sku, qty) {
      if ((onHand.get(sku) || 0) < qty) return null;
      const id = 'r' + nextId++;
      reservations.set(id, { sku, qty });
      return id;
    },
    release(reservationId) {
      const r = reservations.get(reservationId);
      if (!r) return;
      onHand.set(r.sku, (onHand.get(r.sku) || 0) + r.qty);
    },
  };
}
module.exports = { createWarehouse };
