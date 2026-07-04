/**
 * Contract extractor (P4): the verified public surface a dependent reads
 * instead of the dependency's full source.
 */
import { describe, it, expect } from 'vitest';
import { extractContract } from '../../src/delivery/contract-extractor.js';

describe('extractContract', () => {
  it('extracts + verifies JS exports (function/class/const/module.exports)', () => {
    const r = extractContract([
      { path: 'warehouse.js', content: 'function createWarehouse(){}\nmodule.exports = { createWarehouse };' },
      { path: 'api.ts', content: 'export function reserve(sku, qty) {}\nexport class Store {}\nexport const MAX = 5;' },
    ]);
    expect(r.names).toEqual(expect.arrayContaining(['createWarehouse', 'reserve', 'Store', 'MAX']));
    expect(r.contract).toContain('reserve(sku, qty)');
    expect(r.contract).toContain('class Store');
  });

  it('extracts top-level Python def/class, skipping privates', () => {
    const r = extractContract([
      { path: 'm.py', content: 'def migrate(config):\n    pass\ndef _helper():\n    pass\nclass ValidationError(Exception):\n    pass' },
    ]);
    expect(r.names).toEqual(expect.arrayContaining(['migrate', 'ValidationError']));
    expect(r.names).not.toContain('_helper');
  });

  it('returns empty for source with no public surface (no phantom contracts)', () => {
    expect(extractContract([{ path: 'x.js', content: 'const local = 1;' }]).contract).toBe('');
  });
});
