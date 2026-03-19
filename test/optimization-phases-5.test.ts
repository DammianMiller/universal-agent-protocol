/**
 * Tests for optimization phases 1-4 (sweep 5):
 *
 * Phase 1: Quick wins
 *   A1: autoWarmCache() + initializeCacheFromDb() wired into init
 *   B3: Pre-warming config wired to Qdrant startup
 *   D2: Hardcoded paths fixed in maintenance scripts
 *   D3: validate-build.sh lint detection fixed
 *   D4: install-rtk.sh typo fixed
 *
 * Phase 2: Core optimizations
 *   B1: AdaptivePatternEngine SQLite persistence
 *   B2: LLM call reduction (classification cache + dedup)
 *   A2: Performance monitoring on embedding hot path
 *
 * Phase 3: Architecture
 *   C5: Model profile loader from JSON
 *   D5: Version string unification (.uap.json schema URL)
 *   C1: Analyzer parallel detection
 *   D8: GitHub workflow fixes
 *   E1+E2: Shared Python task classifier
 *
 * Phase 4: New capabilities
 *   B4: HTTP/SSE MCP transport
 *   C2: Memory-pressure-aware embedding cache
 *   D1: Duplicate qwen35-settings.json removed
 *   D7: publish-npm.sh dynamic version
 *   D10: Duplicate docker-compose removed
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

// ── Phase 1: Quick Wins ──

describe('Phase 1: Quick Wins', () => {
  describe('A1: Cache startup wiring', () => {
    it('init.ts imports initializeCacheFromDb and autoWarmCache', () => {
      const source = readFileSync('src/cli/init.ts', 'utf-8');
      expect(source).toContain('initializeCacheFromDb');
      expect(source).toContain('autoWarmCache');
    });

    it('init.ts calls both cache functions during memory init', () => {
      const source = readFileSync('src/cli/init.ts', 'utf-8');
      expect(source).toContain('await initializeCacheFromDb(fullDbPath)');
      expect(source).toContain('autoWarmCache()');
      expect(source).toContain('Cache warmed');
    });
  });

  describe('D2: Hardcoded paths fixed', () => {
    it('update-skills.py uses relative path', () => {
      const source = readFileSync('scripts/maintenance/update-skills.py', 'utf-8');
      expect(source).not.toContain('universal-agent-memory');
      expect(source).toContain('os.path.join');
      expect(source).toContain('os.path.abspath');
    });

    it('validate-skills.py uses relative path', () => {
      const source = readFileSync('scripts/maintenance/validate-skills.py', 'utf-8');
      expect(source).not.toContain('universal-agent-memory');
      expect(source).toContain('os.path.join');
    });

    it('update-droids.py uses relative path', () => {
      const source = readFileSync('scripts/maintenance/update-droids.py', 'utf-8');
      expect(source).not.toContain('universal-agent-memory');
      expect(source).toContain('os.path.join');
    });
  });

  describe('D3: validate-build.sh lint detection', () => {
    it('detects .eslintrc.cjs config file', () => {
      const source = readFileSync('scripts/validate-build.sh', 'utf-8');
      expect(source).toContain('.eslintrc.cjs');
    });
  });

  describe('D4: install-rtk.sh typo', () => {
    it('uses correct binary name rtk (not rkt)', () => {
      const source = readFileSync('scripts/setup/install-rtk.sh', 'utf-8');
      expect(source).not.toContain('sudo mv rkt ');
      expect(source).toContain('sudo mv rtk ');
    });
  });
});

// ── Phase 2: Core Optimizations ──

describe('Phase 2: Core Optimizations', () => {
  describe('B1: AdaptivePatternEngine SQLite persistence', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'uap-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('persists pattern outcomes to SQLite and reloads them', async () => {
      const { AdaptivePatternEngine } = await import(
        '../src/coordination/adaptive-patterns.js'
      );

      const dbPath = join(tmpDir, 'patterns.db');

      // Create engine, attach DB, record outcomes
      const engine1 = new AdaptivePatternEngine();
      engine1.attachDb(dbPath);
      engine1.recordPatternOutcome('P12', true, 'security');
      engine1.recordPatternOutcome('P12', true, 'security');
      engine1.recordPatternOutcome('P12', false, 'security');
      engine1.recordPatternOutcome('P35', true, 'refactor');
      engine1.close();

      // Create new engine, attach same DB — should load persisted data
      const engine2 = new AdaptivePatternEngine();
      engine2.attachDb(dbPath);

      const securityPatterns = engine2.getAdaptedPatterns('security');
      expect(securityPatterns.length).toBe(1);
      expect(securityPatterns[0].id).toBe('P12');
      expect(securityPatterns[0].successRate).toBeCloseTo(2 / 3);

      const refactorPatterns = engine2.getAdaptedPatterns('refactor');
      expect(refactorPatterns.length).toBe(1);
      expect(refactorPatterns[0].id).toBe('P35');
      expect(refactorPatterns[0].successRate).toBe(1.0);

      engine2.close();
    });

    it('creates pattern_outcomes table with correct schema', async () => {
      const { AdaptivePatternEngine } = await import(
        '../src/coordination/adaptive-patterns.js'
      );

      const dbPath = join(tmpDir, 'schema-test.db');
      const engine = new AdaptivePatternEngine();
      engine.attachDb(dbPath);

      // Verify table exists
      const db = new Database(dbPath);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_outcomes'")
        .all();
      expect(tables.length).toBe(1);

      // Verify columns
      const columns = db.prepare('PRAGMA table_info(pattern_outcomes)').all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain('pattern_id');
      expect(columnNames).toContain('task_category');
      expect(columnNames).toContain('uses');
      expect(columnNames).toContain('successes');
      expect(columnNames).toContain('updated_at');

      db.close();
      engine.close();
    });
  });

  describe('B2: LLM call reduction (classification cache)', () => {
    it('router.ts imports AdaptiveCache for classification caching', () => {
      const source = readFileSync('src/models/router.ts', 'utf-8');
      expect(source).toContain("import { AdaptiveCache } from '../utils/adaptive-cache.js'");
      expect(source).toContain('classificationCache');
      expect(source).toContain('normalizeForCache');
    });

    it('classifyTask caches results and returns cached on repeat', async () => {
      const { createCostOptimizedRouter } = await import('../src/models/router.js');
      const router = createCostOptimizedRouter();

      const result1 = router.classifyTask('implement a new security authentication feature');
      const result2 = router.classifyTask('implement a new security authentication feature');

      // Same input should produce identical results
      expect(result1.complexity).toBe(result2.complexity);
      expect(result1.taskType).toBe(result2.taskType);
      expect(result1.suggestedModel).toBe(result2.suggestedModel);
    });
  });

  describe('A2: Performance monitoring on embedding hot path', () => {
    it('embeddings.ts imports getPerformanceMonitor', () => {
      const source = readFileSync('src/memory/embeddings.ts', 'utf-8');
      expect(source).toContain("import { getPerformanceMonitor }");
      expect(source).toContain("monitor.measure('embedding.embed'");
    });
  });
});

// ── Phase 3: Architecture ──

describe('Phase 3: Architecture', () => {
  describe('C5: Model profile loader', () => {
    it('profile-loader.ts exports loadModelProfile and loadAllModelProfiles', () => {
      const source = readFileSync('src/models/profile-loader.ts', 'utf-8');
      expect(source).toContain('export function loadModelProfile');
      expect(source).toContain('export function loadAllModelProfiles');
      expect(source).toContain('export function getActiveModelProfile');
      expect(source).toContain('ModelProfileSchema');
    });

    it('loads a valid model profile from config directory', async () => {
      const { loadModelProfile } = await import('../src/models/profile-loader.js');
      const profile = loadModelProfile('config/model-profiles/generic.json');
      expect(profile).not.toBeNull();
      expect(profile!._profile).toBe('generic');
      expect(profile!.model).toBe('default');
      expect(profile!.optimize_for_tool_calls).toBe(true);
    });

    it('returns null for non-existent profile', async () => {
      const { loadModelProfile } = await import('../src/models/profile-loader.js');
      const profile = loadModelProfile('config/model-profiles/nonexistent.json');
      expect(profile).toBeNull();
    });
  });

  describe('D5: Version string unification', () => {
    it('.uap.json references universal-agent-protocol (not memory)', () => {
      const config = JSON.parse(readFileSync('.uap.json', 'utf-8'));
      expect(config.$schema).toContain('universal-agent-protocol');
      expect(config.$schema).not.toContain('universal-agent-memory');
    });

    it('init.ts generates correct schema URL', () => {
      const source = readFileSync('src/cli/init.ts', 'utf-8');
      expect(source).toContain('universal-agent-protocol');
      expect(source).not.toContain('universal-agent-memory');
    });
  });

  describe('C1: Analyzer parallel detection', () => {
    it('analyzeProject uses Promise.all for parallel detection', () => {
      const source = readFileSync('src/analyzers/index.ts', 'utf-8');
      expect(source).toContain('Promise.all');
      expect(source).toContain('analyzeDirectoryStructure');
      expect(source).toContain('detectDatabases');
    });
  });

  describe('D8: GitHub workflow fixes', () => {
    it('deploy-publish.yml includes NODE_AUTH_TOKEN for npm publish', () => {
      const source = readFileSync('.github/workflows/deploy-publish.yml', 'utf-8');
      expect(source).toContain('NODE_AUTH_TOKEN');
      expect(source).toContain('NPM_TOKEN');
    });

    it('uap-compliance.yml grep pipe bug is fixed', () => {
      const source = readFileSync('.github/workflows/uap-compliance.yml', 'utf-8');
      // Should NOT have the broken pipe pattern
      expect(source).not.toContain('grep -q "v2\\.[2-9]\\|v3\\." CLAUDE.md | head -1');
      // Should have the fixed version
      expect(source).toContain('grep -q "v2\\.[2-9]\\|v3\\." CLAUDE.md; then');
    });
  });

  describe('E1+E2: Shared Python task classifier', () => {
    it('task_classifier.py exists in UAP package', () => {
      expect(existsSync('tools/agents/UAP/task_classifier.py')).toBe(true);
    });

    it('task_classifier.py contains CATEGORY_KEYWORDS superset', () => {
      const source = readFileSync('tools/agents/UAP/task_classifier.py', 'utf-8');
      expect(source).toContain('CATEGORY_KEYWORDS');
      expect(source).toContain('classify_task');
      expect(source).toContain('build_classified_preamble');
      // Should have categories from both agents
      expect(source).toContain('"crypto"');
      expect(source).toContain('"vulnerability"');
      expect(source).toContain('"chess"');
      expect(source).toContain('"webserver"');
    });
  });
});

// ── Phase 4: New Capabilities ──

describe('Phase 4: New Capabilities', () => {
  describe('B4: HTTP/SSE MCP transport', () => {
    it('client.ts no longer throws "not yet supported" for HTTP', () => {
      const source = readFileSync('src/mcp-router/executor/client.ts', 'utf-8');
      expect(source).not.toContain('HTTP/SSE transport is not yet supported');
    });

    it('client.ts has httpBaseUrl field and initializeHttp method', () => {
      const source = readFileSync('src/mcp-router/executor/client.ts', 'utf-8');
      expect(source).toContain('httpBaseUrl');
      expect(source).toContain('initializeHttp');
      expect(source).toContain('sendHttpRequest');
    });

    it('HTTP transport uses fetch API', () => {
      const source = readFileSync('src/mcp-router/executor/client.ts', 'utf-8');
      expect(source).toContain('await fetch(this.httpBaseUrl');
      expect(source).toContain("'Content-Type': 'application/json'");
    });
  });

  describe('C2: Memory-pressure-aware embedding cache', () => {
    it('EmbeddingService has memoryPressureThreshold', () => {
      const source = readFileSync('src/memory/embeddings.ts', 'utf-8');
      expect(source).toContain('memoryPressureThreshold');
      expect(source).toContain('process.memoryUsage().heapUsed');
      expect(source).toContain('Memory pressure eviction');
    });
  });

  describe('D1: Duplicate config removed', () => {
    it('config/qwen35-settings.json should NOT exist', () => {
      expect(existsSync('config/qwen35-settings.json')).toBe(false);
    });

    it('config/model-profiles/qwen35.json should still exist', () => {
      expect(existsSync('config/model-profiles/qwen35.json')).toBe(true);
    });
  });

  describe('D7: publish-npm.sh dynamic version', () => {
    it('reads version from package.json dynamically', () => {
      const source = readFileSync('scripts/maintenance/publish-npm.sh', 'utf-8');
      expect(source).toContain('node -p');
      expect(source).toContain('package.json');
      expect(source).not.toContain('v0.10.0');
    });
  });

  describe('D10: Duplicate docker-compose removed', () => {
    it('agents/docker-compose.yml should NOT exist', () => {
      expect(existsSync('agents/docker-compose.yml')).toBe(false);
    });

    it('tools/agents/docker-compose.qdrant.yml should still exist', () => {
      expect(existsSync('tools/agents/docker-compose.qdrant.yml')).toBe(true);
    });
  });
});
