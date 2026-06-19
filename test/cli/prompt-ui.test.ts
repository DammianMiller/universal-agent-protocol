import { describe, it, expect } from 'vitest';
import { createNonInteractiveUI } from '../../src/cli/prompt-ui.js';

describe('createNonInteractiveUI', () => {
  const ui = createNonInteractiveUI();

  it('select returns the initialValue (or first option) without prompting', async () => {
    expect(await ui.select({ message: 'm', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], initialValue: 'b' })).toBe('b');
    expect(await ui.select({ message: 'm', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] })).toBe('a');
  });

  it('multiselect returns initialValues (or empty)', async () => {
    expect(await ui.multiselect({ message: 'm', options: [{ label: 'A', value: 'a' }], initialValues: ['a'] })).toEqual(['a']);
    expect(await ui.multiselect({ message: 'm', options: [{ label: 'A', value: 'a' }] })).toEqual([]);
  });

  it('confirm returns initialValue (default true)', async () => {
    expect(await ui.confirm({ message: 'm', initialValue: false })).toBe(false);
    expect(await ui.confirm({ message: 'm' })).toBe(true);
  });

  it('text returns initialValue (or empty) and notes are no-ops', async () => {
    expect(await ui.text({ message: 'm', initialValue: 'hi' })).toBe('hi');
    expect(await ui.text({ message: 'm' })).toBe('');
    expect(() => ui.intro('x')).not.toThrow();
    expect(() => ui.note('x', 't')).not.toThrow();
  });
});
