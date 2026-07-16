/**
 * `uap fidelity` — inspect or set the maximum-fidelity verification mode.
 *
 *   uap fidelity                 # status: effective mode + source + vision config
 *   uap fidelity max             # set fidelity.mode = max in .uap.json
 *   uap fidelity standard        # set fidelity.mode = standard
 *   uap fidelity --json          # machine-readable (consumed by enforcers/dashboard)
 */
import { resolveFidelity, type FidelityMode } from '../delivery/fidelity.js';
import { modifyUapConfig } from '../utils/config-loader.js';

export interface FidelityOptions {
  json?: boolean;
}

export async function fidelityCommand(action: string | undefined, options: FidelityOptions = {}): Promise<void> {
  const cwd = process.cwd();

  if (action === 'max' || action === 'standard') {
    const mode = action as FidelityMode;
    modifyUapConfig(cwd, (raw) => {
      const fidelity = (raw.fidelity as Record<string, unknown>) ?? {};
      fidelity.mode = mode;
      return { ...raw, fidelity };
    });
    if (!options.json) {
      console.log(`✓ fidelity.mode set to ${mode}`);
      if (mode === 'max') {
        console.log('  Max fidelity now gates delivery/verify: raised verifier floor, acceptance required,');
        console.log('  blocking vision review, fail-closed visual gate. (UAP_FIDELITY overrides at runtime.)');
        // "Never go full" saturation note: max is full commitment on the gate
        // axis -- name the escape hatches, and warn if the policy axis is
        // saturated too (advisory only; never blocks).
        console.log('  Escape hatches that remain: UAP_FIDELITY=standard (runtime), review waivers, operator overrides.');
        try {
          const { listPolicyChoices, lintSaturation } = await import('./policy-select.js');
          const choices = await listPolicyChoices();
          const on = new Set(choices.filter((c) => c.installed && c.enabled).map((c) => c.name));
          for (const w of lintSaturation(choices, on, { fidelityMax: true })) {
            console.log(`  \u26a0 ${w}`);
          }
        } catch {
          /* advisory only */
        }
      }
    } else {
      console.log(JSON.stringify({ ok: true, mode }));
    }
    return;
  }

  // status (default)
  const f = resolveFidelity(cwd);
  if (options.json) {
    console.log(JSON.stringify(f));
    return;
  }
  console.log(`Fidelity mode: ${f.mode}  (from ${f.source})`);
  if (f.max) {
    console.log('  • verifier floor: runtime + integration (not just fast)');
    console.log('  • acceptance judge: REQUIRED');
    console.log('  • vision aesthetic review: BLOCKING' + (f.visionEndpoint ? '' : '  ⚠ no vision endpoint configured'));
    console.log('  • visual gate: FAIL-CLOSED without a browser');
    console.log(`  • visual regression baselines: ${f.visualBaselines ? 'on' : 'off'}`);
    console.log(`  • vision min score: ${f.visionMinScore}/10`);
    if (f.visionEndpoint) console.log(`  • vision endpoint: ${f.visionEndpoint}${f.visionModel ? ` (${f.visionModel})` : ''}`);
  } else {
    console.log('  Standard verification (cheap-first tiers, advisory vision, fail-open visual).');
    console.log('  Enable strongest gates with: uap fidelity max');
  }
}
