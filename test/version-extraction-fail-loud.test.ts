/**
 * The create-release job's version extraction must be fail-loud.
 *
 * The original one-liner nested escaped double quotes inside single quotes
 * ('require(\"./package.json\")...'). node received invalid JS, the $( )
 * swallowed the error, and the step "succeeded" with VERSION empty — the
 * tag check then queried the bare refs/tags/v refspec, which matches the
 * junk `v` tag (2026-10-09), so EVERY release was skipped as "already
 * existing". The v2.41.0 through v2.43.1 master pushes all no-oped this
 * way and shipped nothing until they were published by hand.
 *
 * These tests pin the properties that made that failure mode possible:
 * the extraction line must be shell-flat (no quote nesting), the step must
 * refuse to continue on an empty result, and the command it embeds must
 * actually return the version.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKFLOW = join(process.cwd(), '.github', 'workflows', 'deploy-verify.yml');

function getPackageVersion(): string {
  return (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;
}

describe('create-release: version extraction is fail-loud', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');

  it('extracts the version with flat shell quoting (no escaped-quote nesting)', () => {
    // The broken one-liner had require(\" ... \") inside single quotes: node
    // got invalid JS, $( ) swallowed it, VERSION came out empty.
    expect(yml).not.toContain('require(\\"./package.json\\")');
    // The replacement command, verbatim.
    expect(yml).toContain("VERSION=$(node -p \"require('./package.json').version\")");
  });

  it('refuses to continue when the extraction yields nothing', () => {
    // Without this guard an empty VERSION made the tag check degrade to the
    // bare refs/tags/v refspec — which matches the junk `v` tag — and every
    // release then "already existed".
    expect(yml).toContain('if [ -z "$VERSION" ]; then');
    expect(yml).toMatch(/::error::package\.json version extraction failed/);
    expect(yml).toMatch(/echo "VERSION=\$VERSION" >> \$GITHUB_OUTPUT/);
  });

  it('the embedded extraction command returns the real version', () => {
    // Behavioural: run the exact command the workflow embeds and compare
    // with package.json — proves the quoting is valid for node, not just
    // textually different.
    const out = execFileSync('node', ['-p', "require('./package.json').version"], {
      encoding: 'utf8',
    }).trim();
    expect(out).toBe(getPackageVersion());
    expect(out).not.toBe('');
  });
});
