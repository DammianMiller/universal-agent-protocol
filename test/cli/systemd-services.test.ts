import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installSystemdUserServices } from '../../src/cli/systemd-services.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('installSystemdUserServices', () => {
  it('creates launcher scripts, unit files, and env files', () => {
    const projectDir = makeTempDir('uap-systemd-project-');
    const homeDir = makeTempDir('uap-systemd-home-');

    const result = installSystemdUserServices(projectDir, { homeDir });

    expect(result.installed.length).toBeGreaterThanOrEqual(6);
    expect(result.userServiceDir).toBe(join(homeDir, '.config', 'systemd', 'user'));
    expect(result.envDir).toBe(join(homeDir, '.config', 'uap'));

    const proxyService = readFileSync(
      join(homeDir, '.config', 'systemd', 'user', 'uap-anthropic-proxy.service'),
      'utf-8'
    );
    const llamaService = readFileSync(
      join(homeDir, '.config', 'systemd', 'user', 'uap-llama-server.service'),
      'utf-8'
    );

    expect(proxyService).toContain('ExecStart=' + join(projectDir, 'scripts/run-anthropic-proxy-continuity.sh'));
    expect(llamaService).toContain('ExecStart=' + join(projectDir, 'scripts/run-llama-server-continuity.sh'));
  });

  it('preserves existing env file values unless force is enabled', () => {
    const projectDir = makeTempDir('uap-systemd-project-');
    const homeDir = makeTempDir('uap-systemd-home-');

    installSystemdUserServices(projectDir, { homeDir });

    const proxyEnvPath = join(homeDir, '.config', 'uap', 'anthropic-proxy.env');
    writeFileSync(proxyEnvPath, 'PROXY_PORT=4999\n');

    const second = installSystemdUserServices(projectDir, { homeDir });
    expect(second.skipped).toContain(proxyEnvPath);
    expect(readFileSync(proxyEnvPath, 'utf-8')).toContain('PROXY_PORT=4999');

    installSystemdUserServices(projectDir, { homeDir, force: true });
    expect(readFileSync(proxyEnvPath, 'utf-8')).toContain('PROXY_PORT=4000');
  });
});
