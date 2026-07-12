/**
 * Memory bridge: hijack each coding agent's native memory/instruction file to
 * point at UAP's unified memory (idempotent, non-destructive, marked block).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  bridgeMemory,
  bridgeFile,
  buildBridgeBlock,
  nativeMemoryTargets,
  claudeMemoryIndexPath,
  BRIDGE_START,
  BRIDGE_END,
} from '../src/memory/bridge.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-bridge-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('memory bridge', () => {
  it('the bridge block declares UAP memory + carries the idempotent markers', () => {
    const block = buildBridgeBlock(tmp());
    expect(block).toContain(BRIDGE_START);
    expect(block).toContain(BRIDGE_END);
    expect(block).toContain('uap memory query');
    expect(block).toMatch(/managed by UAP/i);
  });

  it('bridgeFile creates, then is idempotent, then updates in place (no duplicate blocks)', () => {
    const d = tmp();
    const f = join(d, 'AGENTS.md');
    writeFileSync(f, '# Existing instructions\n');
    const block = buildBridgeBlock(d);

    expect(bridgeFile(f, block)).toBe('updated'); // existing file, block prepended
    let content = readFileSync(f, 'utf-8');
    expect(content.startsWith(BRIDGE_START)).toBe(true);
    expect(content).toContain('# Existing instructions'); // original preserved

    expect(bridgeFile(f, block)).toBe('unchanged'); // second run: no-op

    // Refresh with a different block replaces IN PLACE — never duplicates.
    const block2 = block.replace('managed by UAP', 'managed by UAP (v2)');
    expect(bridgeFile(f, block2)).toBe('updated');
    content = readFileSync(f, 'utf-8');
    expect(content.split(BRIDGE_START).length - 1).toBe(1); // exactly one start marker
    expect(content).toContain('managed by UAP (v2)');
    expect(content).toContain('# Existing instructions');
  });

  it('bridgeFile creates a brand-new file when none exists', () => {
    const d = tmp();
    const f = join(d, 'GEMINI.md');
    expect(existsSync(f)).toBe(false);
    expect(bridgeFile(f, buildBridgeBlock(d))).toBe('created');
    expect(readFileSync(f, 'utf-8')).toContain(BRIDGE_START);
  });

  it('nativeMemoryTargets detects agents by their footprint', () => {
    const d = tmp();
    mkdirSync(join(d, '.opencode'), { recursive: true });
    writeFileSync(join(d, 'CLAUDE.md'), '# c\n');
    const detected = nativeMemoryTargets(d).filter((t) => t.detected).map((t) => t.platform);
    expect(detected).toContain('claude-code');
    expect(detected).toContain('opencode/codex/factory');
  });

  it('claudeMemoryIndexPath maps cwd to ~/.claude/projects/<dashed-cwd>/memory/MEMORY.md', () => {
    const p = claudeMemoryIndexPath('/home/u/proj-x');
    expect(p).toBe(join(homedir(), '.claude', 'projects', '-home-u-proj-x', 'memory', 'MEMORY.md'));
  });

  it('bridgeMemory only writes detected agents by default; --all writes more', () => {
    const d = tmp();
    writeFileSync(join(d, 'AGENTS.md'), '# a\n');
    // Keep the Claude memory-index target (which resolves under homedir()) inside
    // the temp dir so the --all path never pollutes the real ~/.claude.
    const prevHome = process.env.HOME;
    process.env.HOME = d;
    try {
      const detectedOnly = bridgeMemory(d, {}).filter((r) => r.action !== 'unchanged');
      const all = bridgeMemory(d, { all: true });
      expect(all.length).toBeGreaterThanOrEqual(detectedOnly.length);
      // AGENTS.md was present → its bridge is applied
      expect(bridgeMemory(d, {}).some((r) => r.file.endsWith('AGENTS.md'))).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});
