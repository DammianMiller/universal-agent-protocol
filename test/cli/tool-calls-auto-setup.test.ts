import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as wizardConfig from '../../src/cli/wizard-config.js';

/**
 * Model profiles are fully automatic — the active profile auto-switches with
 * the model routing (see src/models/profile-map.ts) and is NEVER selected by a
 * user at setup time, in either the guided `uap setup` flow or the standalone
 * `uap-tool-calls setup` command. These guards fail loudly if the interactive
 * profile picker (or its plumbing) is ever re-introduced.
 */
describe('model profile is fully automatic (no interactive pick)', () => {
  it('wizard-config no longer exports profileChoicesFor (picker plumbing removed)', () => {
    expect('profileChoicesFor' in wizardConfig).toBe(false);
  });

  it('standalone uap-tool-calls setup is non-interactive (no profile prompt in source)', () => {
    const src = readFileSync(join(process.cwd(), 'src/cli/tool-calls.ts'), 'utf-8');
    // No inquirer-driven profile selection anywhere in the tool-calls CLI.
    expect(src).not.toMatch(/inquirer/);
    expect(src).not.toMatch(/promptProfileSelection/);
    expect(src).not.toMatch(/Select a model profile/);
    // And it must not pin toolCalls.modelProfile (that would defeat auto-switch).
    expect(src).not.toMatch(/saveProfileToConfig/);
  });
});
