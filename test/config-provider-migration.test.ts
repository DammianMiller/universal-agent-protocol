/**
 * Removing an enum value from a zod schema is not a local change.
 *
 * `loadUapConfig()` runs `AgentContextConfigSchema.parse()` inside a try/catch
 * that returns null for the WHOLE config on any failure. So dropping
 * `chroma`/`pinecone`/`serverless` from the provider enum would have meant that
 * one stale `"provider": "chroma"` in a user's .uap.json silently blanked every
 * other setting in the file — memory, delivery, routing, all of it — with no
 * error anyone would see.
 *
 * `.catch('qdrant')` is the migration that makes the removal safe under a
 * compat=preserve / maturity=production stance: an unknown value falls back to
 * the default and the rest of the config survives.
 *
 * `serverless` deserves its own note: it was never a provider. The serverless
 * Qdrant manager is gated by `memory.longTerm.serverless.enabled`, a separate
 * key, so the enum entry only ever offered a selection that selected nothing.
 */
import { describe, it, expect } from 'vitest';
import { LongTermMemorySchema } from '../src/types/config.js';

describe('long-term memory provider enum', () => {
  it('keeps the providers that have a backend', () => {
    for (const provider of ['qdrant', 'github', 'qdrant-cloud', 'none']) {
      expect(LongTermMemorySchema.parse({ provider }).provider).toBe(provider);
    }
  });

  it('migrates a removed value to the default instead of failing', () => {
    // The load-bearing assertion: parse must SUCCEED, because a throw here
    // nulls the entire config one level up.
    for (const stale of ['chroma', 'pinecone', 'serverless']) {
      const parsed = LongTermMemorySchema.parse({ provider: stale });
      expect(parsed.provider).toBe('qdrant');
    }
  });

  it('does not blank neighbouring settings when the provider is stale', () => {
    const parsed = LongTermMemorySchema.parse({
      provider: 'chroma',
      collection: 'my_memories',
      endpoint: 'http://localhost:6333',
    });
    expect(parsed.collection).toBe('my_memories');
    expect(parsed.endpoint).toBe('http://localhost:6333');
  });

  it('still defaults when the provider is absent', () => {
    expect(LongTermMemorySchema.parse({}).provider).toBe('qdrant');
  });
});
