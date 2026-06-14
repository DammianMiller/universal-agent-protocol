/**
 * Tests for the PostToolUse schema-change reminder (enforce gap-fill).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const HOOK = join(__dirname, '../templates/hooks/uap-schema-post.sh');

function run(payload: string): string {
  const r = spawnSync('bash', [HOOK], { input: payload, encoding: 'utf-8' });
  return `${r.stderr ?? ''}${r.stdout ?? ''}`;
}

describe('uap-schema-post (PostToolUse schema-change reminder)', () => {
  it('reminds when a schema/contract file is edited', () => {
    const out = run(JSON.stringify({ tool_input: { file_path: 'src/api/user.schema.ts' } }));
    expect(out).toContain('schema-gate');
    expect(out).toContain('uap schema-diff');
  });

  it('also matches .proto / .graphql / .prisma contract files', () => {
    for (const f of ['api/users.proto', 'schema.graphql', 'db/schema.prisma']) {
      expect(run(JSON.stringify({ tool_input: { file_path: f } }))).toContain('schema-gate');
    }
  });

  it('stays silent for ordinary source files', () => {
    expect(run(JSON.stringify({ tool_input: { file_path: 'src/utils/helper.ts' } })).trim()).toBe('');
  });
});
