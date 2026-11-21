import { describe, it, expect } from 'vitest';
import {
  extractPanicLine,
  inspectQdrantContainer,
  matchKnownFix,
  parseDockerStatus,
  parsePanicPath,
} from '../../src/memory/qdrant-diagnostics.js';

/**
 * The Qdrant container diagnostics: pure parse/match over the EXACT strings
 * observed live on 2026-11-21 (the poisoned-WAL restart loop), plus the
 * docker-unavailable boundary. The live crash-loop and the remediated
 * healthy path were both verified end-to-end through `uap memory status`
 * during the v2.69.1 round.
 */

// The real panic line from this box's uap-qdrant logs (WouldBlock variant).
const WAL_PANIC =
  '2026-11-21T12:06:47.387669Z ERROR qdrant::startup: Panic occurred in file lib/collection/src/shards/replica_set/mod.rs at line 322: ' +
  'Failed to load local shard "./storage/collections/agent_memory/0": ' +
  'Service internal error: Wal error: Can\'t init WAL: Kind(WouldBlock)';

// The variant seen after a bare `rm -rf wal` (the dir must exist, too).
const WAL_NOTFOUND_PANIC =
  '2026-11-21T12:07:37.185434Z ERROR qdrant::startup: Panic occurred in file lib/collection/src/shards/replica_set/mod.rs at line 322: ' +
  'Failed to load local shard "./storage/collections/agent_memory/0": ' +
  'Service internal error: Wal error: Can\'t init WAL: Custom { kind: NotFound, error: Error { kind: OpenFile, source: Os { code: 2, kind: NotFound, message: "No such file or directory" }, path: "./storage/collections/agent_memory/0/wal" } }';

describe('parseDockerStatus', () => {
  it('maps the observed docker ps states', () => {
    expect(parseDockerStatus('Up 3 days (healthy)')).toEqual({
      state: 'up',
      statusLine: 'Up 3 days (healthy)',
    });
    expect(parseDockerStatus('Restarting (101) 32 seconds ago')).toEqual({
      state: 'restarting',
      exitCode: 101,
      statusLine: 'Restarting (101) 32 seconds ago',
    });
    expect(parseDockerStatus('Exited (137) 2 hours ago')).toEqual({
      state: 'exited',
      exitCode: 137,
      statusLine: 'Exited (137) 2 hours ago',
    });
  });

  it('absent when no container matched; unavailable for unrecognized output', () => {
    expect(parseDockerStatus('   ')).toEqual({ state: 'absent', statusLine: '' });
    expect(parseDockerStatus('garbage from a future docker')).toMatchObject({
      state: 'unavailable',
    });
  });
});

describe('extractPanicLine', () => {
  it('picks the LAST error line of a log dump', () => {
    const logs = ['INFO first line', WAL_PANIC, 'INFO between', WAL_NOTFOUND_PANIC, 'INFO after'].join('\n');
    expect(extractPanicLine(logs)).toBe(WAL_NOTFOUND_PANIC);
  });

  it('returns undefined when the logs carry no error', () => {
    expect(extractPanicLine('INFO a\nINFO b')).toBeUndefined();
  });
});

describe('parsePanicPath', () => {
  it('extracts the collection/shard path from the observed panic lines', () => {
    expect(parsePanicPath(WAL_PANIC)).toBe('collections/agent_memory/0');
    expect(parsePanicPath(WAL_NOTFOUND_PANIC)).toBe('collections/agent_memory/0');
  });

  it('returns undefined when the panic names no storage path', () => {
    expect(parsePanicPath('ERROR something else entirely')).toBeUndefined();
  });
});

describe('matchKnownFix', () => {
  it('matches both observed WAL panic variants with the parsed shard in the steps', () => {
    for (const panic of [WAL_PANIC, WAL_NOTFOUND_PANIC]) {
      const fix = matchKnownFix(panic);
      expect(fix).toBeDefined();
      expect(fix?.steps.join('\n')).toContain('collections/agent_memory/0/wal');
      // The verified procedure, not the falsified bare rm -rf: the WAL dir
      // must be recreated empty (Qdrant panics on its absence too).
      expect(fix?.steps.join('\n')).toContain('mkdir -p');
    }
  });

  it('no fix for an unknown panic class', () => {
    expect(matchKnownFix('ERROR out of disk space')).toBeUndefined();
  });
});

describe('inspectQdrantContainer', () => {
  it('reports unavailable (not absent) when docker itself cannot be asked', () => {
    const prevPath = process.env.PATH;
    // An empty PATH makes every docker invocation fail: the honest answer is
    // "docker unavailable", never "no container".
    process.env.PATH = '';
    try {
      expect(inspectQdrantContainer()).toEqual({ state: 'unavailable', statusLine: '' });
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
