import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * qwen38-27b-dflash2.env is the default llama-server profile as of 2026-08-20.
 *
 * These tests pin the settings that the measured 1.4x speedup actually depends on.
 * Each one guards a specific way the profile could be "tidied" into something
 * slower or broken without anyone noticing, because the server would still start
 * and still answer -- just worse.
 */
const PROFILE = join(process.cwd(), 'config', 'llama-profiles', 'qwen38-27b-dflash2.env');

function envOf(src: string): Record<string, string> {
  // Parse the way systemd's EnvironmentFile= does -- literal KEY=VALUE, no shell.
  const out: Record<string, string> = {};
  for (const line of src.split('\n')) {
    if (!line || line.trimStart().startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

describe('qwen38-27b-dflash2 profile -- the settings the speedup depends on', () => {
  const env = envOf(readFileSync(PROFILE, 'utf-8'));

  it('uses the DFlash2 engine with a separate drafter file', () => {
    expect(env.LLAMA_ENABLE_SPEC_DECODING).toBe('true');
    expect(env.LLAMA_SPEC_TYPE).toBe('draft-dflash');
    // draft-mtp reads its head from --model; draft-dflash CANNOT -- it needs this.
    expect(env.LLAMA_DRAFT_MODEL).toMatch(/DFlash2.*\.gguf$/);
  });

  it('keeps n-max at 4 -- 7 was measured SLOWER despite a longer accepted block', () => {
    expect(env.LLAMA_DRAFT_MAX).toBe('4');
  });

  /**
   * The continuity script ALWAYS passes --spec-draft-n-min and --spec-draft-p-min.
   * The 1.4x was measured with llama.cpp's dflash defaults (0 / 0.00). Inheriting
   * the draft-mtp values (1 / 0.75) would gate a block-diffusion drafter on a
   * per-token probability it was never measured with -- silently slower, still
   * apparently working. This is the easiest regression to introduce by tidying.
   */
  it('pins n-min and p-min to 0, not the draft-mtp values', () => {
    expect(Number(env.LLAMA_DRAFT_MIN)).toBe(0);
    expect(Number(env.LLAMA_DRAFT_P_MIN)).toBe(0);
  });

  /**
   * The drafter's own 2048-token sliding window is why its KV is ~80 MiB instead of
   * scaling with the target's 131072/slot, and therefore why this fits in the
   * ~1.1 GiB of headroom that is left. Setting LLAMA_DRAFT_CTX_SIZE would size the
   * draft context explicitly and can blow that budget.
   */
  it('leaves the draft context size unset so the drafter KV stays small', () => {
    expect(env.LLAMA_DRAFT_CTX_SIZE).toBeUndefined();
  });

  it('holds the production shape: 2 slots at 131072 ctx each', () => {
    // --ctx-size is the TOTAL across slots, so per-slot ctx is the quotient.
    expect(Number(env.LLAMA_PARALLEL)).toBe(2);
    expect(Number(env.LLAMA_CTX_SIZE) / Number(env.LLAMA_PARALLEL)).toBe(131072);
  });

  /**
   * The proxy admits work based on its own rails, not on what the server can
   * actually hold. --ctx-size is the TOTAL across slots, so the per-slot figure
   * the proxy needs is the quotient -- pasting 262144 into PROXY_CONTEXT_WINDOW
   * is the classic version of this bug and turns a queue into context-overflow
   * errors. The profile carries the two rail values so the pairing is reviewable
   * in one file; this test stops them drifting apart from the flags above.
   */
  it('documents proxy rails that match the slot arithmetic', () => {
    const src = readFileSync(PROFILE, 'utf-8');
    const perSlot = Number(env.LLAMA_CTX_SIZE) / Number(env.LLAMA_PARALLEL);
    expect(src).toContain(`PROXY_CONTEXT_WINDOW=${perSlot}`);
    expect(src).toContain(`PROXY_CONCURRENCY_LIMIT=${env.LLAMA_PARALLEL}`);
    // The rail must be the per-slot context, never the total.
    expect(src).not.toContain(`PROXY_CONTEXT_WINDOW=${env.LLAMA_CTX_SIZE}`);
  });

  /**
   * The VRAM delta against draft-mtp was never measured with a paired probe, and
   * the doc's own table reports LESS free VRAM for draft-mtp at this tier than
   * this profile claims for itself -- which cannot both be true. An unqualified
   * "~1.9 GiB free on draft-mtp" is the specific wrong number that was here, on a
   * card with ~1.1 GiB of slack, so it must not come back without a measurement.
   */
  it('does not claim an unmeasured VRAM delta against the fallback profile', () => {
    const src = readFileSync(PROFILE, 'utf-8');
    expect(src).not.toMatch(/against\s+~?1\.9\s*GiB\s+free\s+on\s+the\s+draft-mtp/i);
    expect(src).toMatch(/marginal\s*\n?#?\s*cost vs draft-mtp is NOT measured/i);
  });

  /**
   * The PR-27342 binary can deadlock on SIGTERM. systemd contains that (SIGKILL
   * after TimeoutStopSec, cgroup releases the VRAM); a hand-started server does
   * not, and leaves an orphan holding ~21 GiB with no listening socket, which
   * then starves the real service on load. Observed 2026-08-20.
   */
  it('warns that the build hangs on shutdown and must be driven by systemd', () => {
    const src = readFileSync(PROFILE, 'utf-8');
    expect(src).toMatch(/SHUTDOWN HANGS/);
    expect(src).toContain('systemctl --user');
  });

  it('runs the qwen-sharp chat template like every other Qwen profile', () => {
    expect(env.LLAMA_CHAT_TEMPLATE_FILE).toContain('tools/agents/config/qwen-sharp.jinja');
  });

  /**
   * The engine is an UNMERGED upstream PR, so the build is not reproducible from
   * a clean checkout of llama.cpp master. The vendored patch is the only thing
   * standing between us and an unreproducible binary if that worktree is lost.
   */
  it('ships the engine patch alongside, since the PR is not merged upstream', () => {
    const patch = join(process.cwd(), 'config', 'llama-patches', 'dflash2-pr27342.patch');
    expect(existsSync(patch)).toBe(true);
    const src = readFileSync(patch, 'utf-8');
    // The tensors v1 has no loader for -- the reason a rebuild is mandatory.
    expect(src).toContain('DFLASH_SELECTOR');
    expect(src).toContain('DFLASH_ATTN_CONV');
  });
});

describe('qwen38-27b-mtp profile -- retained as the fallback', () => {
  it('still exists and still uses draft-mtp', () => {
    // The DFlash2 profile leaves ~1.1 GiB VRAM free on a card with an OOM history,
    // so the slower-but-roomier profile is the documented first step back.
    const f = join(process.cwd(), 'config', 'llama-profiles', 'qwen38-27b-mtp.env');
    expect(existsSync(f)).toBe(true);
    expect(envOf(readFileSync(f, 'utf-8')).LLAMA_SPEC_TYPE).toBe('draft-mtp');
  });
});
