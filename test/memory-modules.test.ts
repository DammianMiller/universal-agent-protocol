/**
 * Tests for memory modules - smoke tests
 */

import { describe, it, expect } from 'vitest';

describe('ActiveContext Module', () => {
  it('should export ActiveContextManager class', async () => {
    const module = await import('../src/memory/active-context.ts');
    expect(module.ActiveContextManager).toBeDefined();
  });
});

describe('Deduplicated Memory Module', () => {
  it('should export DeduplicatedMemory class', async () => {
    const module = await import('../src/memory/dedup-memory.ts');
    expect(module.DeduplicatedMemory).toBeDefined();
  });
});

describe('Merge Claude MD Module', () => {
  it('should export mergeClaudeMDs function', async () => {
    const module = await import('../src/memory/merge-claude-md.ts');
    expect(module.mergeClaudeMDs).toBeDefined();
  });
});

describe('Memory Patterns Module', () => {
  it('should export memory patterns', async () => {
    const module = await import('../src/memory/patterns.ts');
    expect(module).toBeDefined();
  });
});

describe('Semantic Edge Graph Module', () => {
  it('should export SemanticEdgeGraph class', async () => {
    const module = await import('../src/memory/semantic-edge-graph.ts');
    expect(module.SemanticEdgeGraph).toBeDefined();
  });
});

describe('Smart Consolidator Module', () => {
  it('should export SmartConsolidator class', async () => {
    const module = await import('../src/memory/smart-consolidator.ts');
    expect(module.SmartConsolidator).toBeDefined();
  });
});

describe('View Memory Module', () => {
  it('should export ViewMemory class', async () => {
    const module = await import('../src/memory/view-memory.ts');
    expect(module.ViewMemory).toBeDefined();
  });
});

describe('Wrapped Memory Module', () => {
  it('should export WrappedMemory class', async () => {
    const module = await import('../src/memory/wrapped-memory.ts');
    expect(module.WrappedMemory).toBeDefined();
  });
});

describe('Semantic Retrieval Module', () => {
  it('should export SemanticRetrieval class', async () => {
    const module = await import('../src/memory/semantic-retrieval.ts');
    expect(module.SemanticRetrieval).toBeDefined();
  });
});

describe('Dedup Detector Module', () => {
  it('should export DedupDetector class', async () => {
    const module = await import('../src/memory/dedup-detector.ts');
    expect(module.DedupDetector).toBeDefined();
  });
});

describe('Context Pruner Module', () => {
  it('should export ContextPruner class', async () => {
    const module = await import('../src/memory/context-pruner.ts');
    expect(module.ContextPruner).toBeDefined();
  });
});

describe('Prepopulate Module', () => {
  it('should export prepopulateMemory function', async () => {
    const module = await import('../src/memory/prepopulate.ts');
    expect(module.prepopulateMemory).toBeDefined();
  });
});

describe('Semantic Compression Module', () => {
  it('should export SemanticCompression class', async () => {
    const module = await import('../src/memory/semantic-compression.ts');
    expect(module.SemanticCompression).toBeDefined();
  });
});

describe('Knowledge Graph Module', () => {
  it('should export KnowledgeGraph class', async () => {
    const module = await import('../src/memory/knowledge-graph.ts');
    expect(module.KnowledgeGraph).toBeDefined();
  });
});
