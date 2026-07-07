import { describe, it, expect } from 'vitest';
import { sandboxCustomHeaders } from '../../src/cli/sandbox.js';

describe('sandboxCustomHeaders', () => {
  it('returns the marker alone when there are no prior headers', () => {
    expect(sandboxCustomHeaders(undefined)).toBe('X-Uap-Sandbox: 1');
    expect(sandboxCustomHeaders('')).toBe('X-Uap-Sandbox: 1');
    expect(sandboxCustomHeaders('   ')).toBe('X-Uap-Sandbox: 1');
  });

  it('appends the marker to existing headers without clobbering (newline-separated)', () => {
    expect(sandboxCustomHeaders('X-Foo: bar')).toBe('X-Foo: bar\nX-Uap-Sandbox: 1');
    expect(sandboxCustomHeaders('X-Foo: bar\nX-Baz: qux')).toBe(
      'X-Foo: bar\nX-Baz: qux\nX-Uap-Sandbox: 1'
    );
  });

  it('is idempotent — does not duplicate an already-present marker', () => {
    expect(sandboxCustomHeaders('X-Uap-Sandbox: 1')).toBe('X-Uap-Sandbox: 1');
    expect(sandboxCustomHeaders('X-Foo: bar\nX-Uap-Sandbox: 1')).toBe(
      'X-Foo: bar\nX-Uap-Sandbox: 1'
    );
  });
});
