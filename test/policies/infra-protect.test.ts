/**
 * enforcement-infra-protect: the model must not kill or displace the inference
 * stack it runs on (llama :8080 / UAP proxy :4000 / embeddings :8081).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'enforcement_infra_protect.py');

function run(command: string, op = 'Bash'): { exit: number; allowed: boolean; reason: string } {
  const r = spawnSync('python3', [ENFORCER, '--operation', op, '--args', JSON.stringify({ command })], {
    encoding: 'utf8',
  });
  let parsed: { allowed?: boolean; reason?: string } = {};
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    /* leave empty */
  }
  return { exit: r.status ?? -1, allowed: parsed.allowed ?? false, reason: parsed.reason ?? '' };
}

describe('enforcement-infra-protect enforcer', () => {
  it('blocks a bare-interpreter pkill (would kill the proxy)', () => {
    const r = run('pkill -9 -f python3');
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/infra/i);
  });

  it('blocks kill-by-infra-port and named service kills', () => {
    expect(run('kill $(lsof -t -i:8080)').exit).toBe(2);
    expect(run('pkill -f llama-server').exit).toBe(2);
    expect(run('systemctl --user restart uap-anthropic-proxy').exit).toBe(2);
  });

  it('blocks binding an infra port with a dev/file server', () => {
    expect(run('python3 -m http.server 8080').exit).toBe(2);
    expect(run('vite --port 4000').exit).toBe(2);
  });

  it('allows a SPECIFIC kill pattern and serving on a non-infra port', () => {
    expect(run('pkill -f "python3 -m http.server 8765"').exit).toBe(0);
    expect(run('python3 -m http.server 8765').exit).toBe(0);
    expect(run('npm run build').exit).toBe(0);
  });

  it('ignores non-shell operations', () => {
    const r = run('anything', 'Edit');
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
  });
});
