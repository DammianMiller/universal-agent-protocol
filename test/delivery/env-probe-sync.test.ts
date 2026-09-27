/**
 * env-probe.mjs duplicates sanitized-env.ts's SECRET_ENV_RE so the probe can
 * run standalone (spawned by user-path journeys with no build step). If the
 * two regexes drift, the probe undercounts secret-looking keys and the
 * env-sanitization journey reports a false secrets=0 on a real leak. Pin the
 * two literals in sync so drift fails here, loudly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

function secretEnvReLiteral(file: string): string | undefined {
  const text = readFileSync(join(process.cwd(), file), 'utf8');
  return /SECRET_ENV_RE\s*=\s*(\/[\s\S]*?\/[a-z]*);/.exec(text)?.[1];
}

describe('env-probe SECRET_ENV_RE stays in sync with sanitized-env.ts', () => {
  it('the two regex literals are identical (modulo whitespace wrapping)', () => {
    const probe = secretEnvReLiteral('src/delivery/env-probe.mjs');
    const canonical = secretEnvReLiteral('src/delivery/sanitized-env.ts');
    expect(probe).toBeTruthy();
    expect(canonical).toBeTruthy();
    expect(probe?.replace(/\s+/g, '')).toBe(canonical?.replace(/\s+/g, ''));
  });
});
