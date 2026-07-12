/**
 * `uap plan` — record/inspect plan validation for the validate-plan-on-change
 * gate. After running the `validate the plan` prompt, `uap plan validate` stamps
 * `.uap/plan_state.json` so the enforcer lets plan-file writes through for the
 * validation window.
 *
 *   uap plan validate     # record that the current plan has been validated
 *   uap plan status       # show last validation + whether it's still fresh
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface PlanOptions {
  json?: boolean;
}

function stateDir(cwd: string): string {
  return join(cwd, process.env.UAP_STATE_DIR || '.uap');
}
function statePath(cwd: string): string {
  return join(stateDir(cwd), 'plan_state.json');
}
function windowSec(): number {
  const w = parseInt(process.env.UAP_PLAN_VALIDATE_WINDOW || '300', 10);
  return Number.isFinite(w) ? w : 300;
}

function readState(cwd: string): { validated_at?: number } {
  try {
    return JSON.parse(readFileSync(statePath(cwd), 'utf-8'));
  } catch {
    return {};
  }
}

export async function planCommand(
  action: string | undefined,
  options: PlanOptions = {},
  cwd: string = process.cwd()
): Promise<void> {
  if (action === 'validate') {
    const dir = stateDir(cwd);
    mkdirSync(dir, { recursive: true });
    const prev = readState(cwd);
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(statePath(cwd), JSON.stringify({ ...prev, validated_at: now }, null, 2));
    if (options.json) {
      console.log(JSON.stringify({ ok: true, validated_at: now }));
    } else {
      console.log('✓ Plan validation recorded. Plan-file writes are unblocked for the validation window.');
      console.log(`  (window: ${windowSec()}s — re-run \`uap plan validate\` after that or after a substantive plan change.)`);
    }
    return;
  }

  // status (default)
  const st = readState(cwd);
  const validatedAt = Number(st.validated_at) || 0;
  const ageSec = validatedAt ? Math.floor(Date.now() / 1000) - validatedAt : null;
  const fresh = ageSec !== null && ageSec <= windowSec();
  if (options.json) {
    console.log(JSON.stringify({ validated_at: validatedAt || null, ageSec, fresh, window: windowSec() }));
    return;
  }
  if (!validatedAt) {
    console.log('Plan validation: never recorded. A plan-file write will require `validate the plan` + `uap plan validate`.');
    return;
  }
  console.log(`Plan validation: ${fresh ? 'FRESH' : 'STALE'} — last validated ${ageSec}s ago (window ${windowSec()}s).`);
  if (!fresh) console.log('  Re-run the `validate the plan` prompt, then `uap plan validate`, before editing a plan.');
}

export { statePath as planStatePath, windowSec as planWindowSec };
