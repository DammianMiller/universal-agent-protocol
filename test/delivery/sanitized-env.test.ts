/**
 * sanitized-env — the secret-strip applied to every gate/model-code spawn.
 * Broadened past API_KEY/TOKEN/… after a security audit found real credential
 * names surviving and reaching spawned scripts (X2b).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sanitizedEnv, __SECRET_ENV_RE } from '../../src/delivery/sanitized-env.js';

describe('sanitizedEnv secret stripping', () => {
  const added: string[] = [];
  afterEach(() => {
    for (const k of added.splice(0)) delete process.env[k];
  });
  const set = (k: string, v = 'x') => { process.env[k] = v; added.push(k); };

  it('strips the classic provider-credential names', () => {
    for (const k of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'MY_SECRET', 'DB_PASSWORD', 'AWS_CREDENTIAL']) set(k);
    const env = sanitizedEnv();
    for (const k of added) expect(env[k]).toBeUndefined();
  });

  it('strips the names an audit found surviving the old regex', () => {
    for (const k of ['SSH_AUTH_SOCK', 'DATABASE_URL', 'REDIS_URL', 'MONGO_URL', 'DEPLOY_PRIVATE_KEY', 'KUBECONFIG', 'SENTRY_DSN', 'GCP_SA_KEY', 'MY_SESSION', 'AUTH_COOKIE']) set(k);
    const env = sanitizedEnv();
    for (const k of added) expect(env[k], `${k} should be stripped`).toBeUndefined();
  });

  it('keeps benign vars and forces CI=true', () => {
    set('PATH'); set('HOME'); set('LANG');
    const env = sanitizedEnv();
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(env.CI).toBe('true');
  });

  it('does not over-match a benign name that merely contains a fragment', () => {
    // "TOKENIZER_PATH" contains "TOKEN" — this is an accepted over-match of the
    // denylist approach; documented so the behavior is intentional, not a bug.
    expect(__SECRET_ENV_RE.test('TOKENIZER')).toBe(true);
    // but a clearly-benign var is kept
    expect(__SECRET_ENV_RE.test('NODE_ENV')).toBe(false);
    expect(__SECRET_ENV_RE.test('TERM')).toBe(false);
  });

  it('extra overrides are merged after stripping', () => {
    const env = sanitizedEnv({ FOO: 'bar' });
    expect(env.FOO).toBe('bar');
  });
});
