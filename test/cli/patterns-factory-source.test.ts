/**
 * Pattern indexer .factory/patterns source tests
 *
 * Verifies the generated index script knows how to index the file-based
 * pattern router (.factory/patterns/index.json + PNN_*.md) so the
 * always-enforced patterns (P12 Output Existence, P35 Decoder-First) are
 * retrievable instead of being fragmented into generic heading sub-sections.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateScripts } from '../../src/cli/patterns.js';

describe('pattern indexer: .factory/patterns source', () => {
  let proj: string;
  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'uap-patterns-'));
    writeFileSync(
      join(proj, '.uap.json'),
      JSON.stringify({
        version: '1.0.0',
        project: { name: 'test-proj' },
        memory: { patternRag: { enabled: true } },
      })
    );
  });
  afterEach(() => rmSync(proj, { recursive: true, force: true }));

  it('generated index script includes the .factory/patterns extractor', async () => {
    await generateScripts(proj, { force: true });
    const script = readFileSync(
      join(proj, 'agents/scripts/index_patterns_to_qdrant.py'),
      'utf8'
    );
    expect(script).toContain('def scan_factory_patterns');
    expect(script).toContain('"patterns"');
    expect(script).toContain('index.json');
    expect(script).toContain('"source": "factory-pattern"');
  });

  it('wires scan_factory_patterns into main() and preserves PNN identity', async () => {
    await generateScripts(proj, { force: true });
    const script = readFileSync(
      join(proj, 'agents/scripts/index_patterns_to_qdrant.py'),
      'utf8'
    );
    // Invoked in main() and merged into the indexed set
    expect(script).toMatch(/factory_patterns = scan_factory_patterns\(PROJECT_ROOT\)/);
    expect(script).toContain('all_docs.extend(factory_patterns)');
    // Canonical "PNN: Title" identity preserved (e.g. "P12: Output Existence Verification")
    expect(script).toContain('f"P{pid}: {title}"');
  });
});
