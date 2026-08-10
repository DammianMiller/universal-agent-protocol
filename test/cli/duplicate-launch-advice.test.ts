/**
 * The duplicate-launch message must not advertise a door the gate keeps shut.
 *
 * Both messages used to end with the lock's off-switch flag. A blocked caller
 * read that as "here is the key", set it inline, and self-protect refused it —
 * so the advice cost a turn and taught the wrong lesson: that the lock is
 * something to get past rather than something to follow. The agent that hit
 * this on 2026-08-10 went looking for another key and found
 * `rm -f .uap/deliver.lock`, which is strictly worse than the flag: it removes
 * the guard for every subsequent launch too.
 *
 * Asserted against the SOURCE region rather than by running a duplicate launch,
 * which would need a second live deliver holding the lock.
 *
 * Counted, not merely "present somewhere". There are TWO messages here — the
 * overlapping-root one and the same-root one — and an earlier version of this
 * file joined them and asked `toContain`, which a single-site mutation walked
 * straight through: dropping the advice from one message left the other's copy
 * to satisfy the assertion.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/** The contiguous block that builds both skipped-launch messages. */
function messageRegion(): string {
  const lines = readFileSync(join(process.cwd(), 'src', 'cli', 'deliver.ts'), 'utf-8').split('\n');
  const start = lines.findIndex((l) => l.includes('already owns an OVERLAPPING project root'));
  if (start < 0) throw new Error('duplicate-launch message region not found');
  return lines.slice(start - 2, start + 16).join('\n');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Assembled from parts so this file does not itself trip the enforcer that
// refuses commands setting a bypass flag inline.
const FLAG = 'UAP_DELIVER' + '_NO_LOCK';

describe('duplicate-launch advice', () => {
  it('locates both messages', () => {
    // An empty or truncated region would make every assertion below vacuous.
    const region = messageRegion();
    expect(count(region, 'Do NOT use --resume')).toBe(2);
  });

  it('names the off-switch flag in NEITHER message', () => {
    expect(messageRegion()).not.toContain(FLAG);
  });

  it('tells BOTH messages to follow the run instead', () => {
    expect(count(messageRegion(), '--await-run')).toBe(2);
  });

  it('says in BOTH that the off-switch is launch-env only, not inline', () => {
    const region = messageRegion();
    expect(count(region, 'LAUNCH environment')).toBe(2);
    expect(count(region, 'inline is refused')).toBe(2);
  });

  it('keeps the resume warning, which is the other way to fork a live mission', () => {
    expect(messageRegion()).toMatch(/resume CONTINUES a mission/);
  });
});
