/**
 * Tests for discoverLocalLlamaBases() — the TS half of upstream discovery.
 *
 * Regression origin (2026-08-16): the Unsloth llama-server (vision-capable) was
 * live on an ephemeral port while every caller fell back to :8080, so
 * autodetectLocalVision() reported "not configured" with a working multimodal
 * server on the same host.
 *
 * `ss` is stubbed on PATH so the real parse runs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverLocalLlamaBases } from '../src/utils/llama-discovery.js';

let stubDir: string;
const realPath = process.env.PATH;

function setSs(output: string): void {
  writeFileSync(
    join(stubDir, 'ss'),
    `#!/usr/bin/env bash\ncat <<'SSEOF'\n${output}\nSSEOF\n`,
  );
  chmodSync(join(stubDir, 'ss'), 0o755);
}

/** A `ss -ltnp` line in the real column layout. */
function line(addr: string, proc: string, pid = 2172639): string {
  return `LISTEN 0      512        ${addr}      0.0.0.0:*    users:(("${proc}",pid=${pid},fd=36)) `;
}

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), 'uap-llama-disco-'));
});

beforeEach(() => {
  process.env.PATH = `${stubDir}:${realPath ?? ''}`;
});

afterAll(() => {
  process.env.PATH = realPath;
  rmSync(stubDir, { recursive: true, force: true });
});

describe('discoverLocalLlamaBases', () => {
  it('returns the ephemeral port of a live llama-server', () => {
    setSs(line('127.0.0.1:59879', 'llama-server'));
    expect(discoverLocalLlamaBases()).toEqual(['http://127.0.0.1:59879/v1']);
  });

  it('ignores listeners belonging to other processes', () => {
    setSs(
      [
        line('127.0.0.1:6333', 'qdrant', 999),
        line('0.0.0.0:4000', 'python3', 1071769),
        line('127.0.0.1:59879', 'llama-server'),
      ].join('\n'),
    );
    expect(discoverLocalLlamaBases()).toEqual(['http://127.0.0.1:59879/v1']);
  });

  it('returns every llama-server, sorted, de-duplicated', () => {
    setSs(
      [
        line('127.0.0.1:59879', 'llama-server'),
        line('127.0.0.1:8081', 'llama-server', 4242),
        line('127.0.0.1:59879', 'llama-server'),
      ].join('\n'),
    );
    expect(discoverLocalLlamaBases()).toEqual([
      'http://127.0.0.1:8081/v1',
      'http://127.0.0.1:59879/v1',
    ]);
  });

  it('treats a wildcard bind as loopback', () => {
    // 0.0.0.0 covers 127.0.0.1, so the same socket is reached — and the base
    // must never point off-host.
    setSs(line('0.0.0.0:59879', 'llama-server'));
    expect(discoverLocalLlamaBases()).toEqual(['http://127.0.0.1:59879/v1']);
  });

  it('rejects a server bound to a specific non-loopback address', () => {
    // 127.0.0.1:59879 would be a DIFFERENT socket, bindable by another local
    // user — assuming it is the same server hands them the endpoint.
    setSs(line('192.168.1.165:59879', 'llama-server'));
    expect(discoverLocalLlamaBases()).toEqual([]);
  });

  it('addresses an IPv6-only listener as [::1]', () => {
    // A server bound only to ::1 is not reachable at 127.0.0.1.
    setSs(line('[::1]:59879', 'llama-server'));
    expect(discoverLocalLlamaBases()).toEqual(['http://[::1]:59879/v1']);
  });

  it('ignores a process merely NAMED like llama-server', () => {
    setSs(line('127.0.0.1:10001', 'my-llama-server-shim', 4242));
    expect(discoverLocalLlamaBases()).toEqual([]);
  });

  it('returns empty when nothing is listening', () => {
    setSs('');
    expect(discoverLocalLlamaBases()).toEqual([]);
  });

  it('fails soft when ss is unavailable', () => {
    process.env.PATH = stubDir; // no ss stub written for this dir state
    rmSync(join(stubDir, 'ss'), { force: true });
    expect(discoverLocalLlamaBases()).toEqual([]);
  });
});
