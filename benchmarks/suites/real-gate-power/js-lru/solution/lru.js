class LRUCache {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity');
    this.cap = capacity; this.m = new Map();
  }
  get size() { return this.m.size; }
  has(k) { return this.m.has(k); }
  get(k) { if (!this.m.has(k)) return undefined; const v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v; }
  put(k, v) {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.cap) this.m.delete(this.m.keys().next().value);
  }
}
module.exports = LRUCache;
