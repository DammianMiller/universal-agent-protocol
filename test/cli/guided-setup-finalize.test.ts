/**
 * Regression guard for the finalizeGuidedSetup() extraction (the shared apply
 * block used by the recommended, interactive-preset, and headless --profile
 * flows). Heavy side-effect modules are mocked so we assert the control flow:
 *   - exactly ONE success outro (guards the duplicate-outro regression)
 *   - the wizard config is applied exactly once with the given selections
 *   - a cancelled confirm aborts before any apply
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Partial mocks (spread the real module) so other exports these modules provide
// stay intact for any test file sharing the module graph — otherwise a bare
// factory drops sibling exports and breaks unrelated suites.
vi.mock('../../src/cli/init.js', async (o) => ({ ...(await (o as () => Promise<object>)()), initCommand: vi.fn(async () => {}) }));
vi.mock('../../src/cli/setup.js', async (o) => ({ ...(await (o as () => Promise<object>)()), runSetupSteps: vi.fn(async () => {}) }));
vi.mock('../../src/cli/tool-calls.js', async (o) => ({ ...(await (o as () => Promise<object>)()), toolCallsCommand: vi.fn(async () => {}) }));
vi.mock('../../src/cli/setup-backup.js', async (o) => ({ ...(await (o as () => Promise<object>)()), backupInstructionFiles: vi.fn(() => ({ backedUp: [], date: '2026-07-07' })) }));
vi.mock('../../src/cli/setup-extract.js', async (o) => ({ ...(await (o as () => Promise<object>)()), extractInteractive: vi.fn(async () => {}) }));
vi.mock('../../src/cli/wizard-config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    applyWizardConfig: vi.fn(async () => '/tmp/.uap.json'),
    writeProxyEnv: vi.fn(() => '/tmp/.uap/proxy.env'),
  };
});

import { finalizeGuidedSetup } from '../../src/cli/guided-setup.js';
import { maxSelections, applyWizardConfig } from '../../src/cli/wizard-config.js';
import type { PromptUI } from '../../src/cli/prompt-ui.js';

/** Minimal PromptUI spy; confirm answer is configurable. */
function spyUI(confirmAnswer = true) {
  const outros: string[] = [];
  const ui: PromptUI = {
    intro: vi.fn(),
    outro: vi.fn((m: string) => { outros.push(m); }),
    note: vi.fn(),
    confirm: vi.fn(async () => confirmAnswer),
    select: vi.fn(async (o: { initialValue?: unknown }) => o.initialValue),
    multiselect: vi.fn(async (o: { initialValues?: unknown }) => o.initialValues ?? []),
    text: vi.fn(async () => ''),
  } as unknown as PromptUI;
  return { ui, outros };
}

describe('finalizeGuidedSetup control flow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits exactly one success outro (no duplicate) and applies config once', async () => {
    const { ui, outros } = spyUI(true);
    const selections = maxSelections({ platforms: ['claude'], localModel: null, hasDocker: false });
    await finalizeGuidedSetup('/tmp/proj', ui, { backup: false, extract: false }, selections);
    // exactly one outro, and it is the success banner (not the cancel one)
    expect(outros).toHaveLength(1);
    expect(outros[0]).toMatch(/Setup complete/);
    expect(applyWizardConfig).toHaveBeenCalledTimes(1);
    expect(applyWizardConfig).toHaveBeenCalledWith('/tmp/proj', selections);
  });

  it('aborts on a declined confirm without applying config', async () => {
    const { ui, outros } = spyUI(false);
    const selections = maxSelections({ platforms: ['claude'], localModel: null, hasDocker: false });
    await finalizeGuidedSetup('/tmp/proj', ui, { backup: false, extract: false }, selections);
    expect(applyWizardConfig).not.toHaveBeenCalled();
    expect(outros).toHaveLength(1);
    expect(outros[0]).toMatch(/cancelled/i);
  });
});
