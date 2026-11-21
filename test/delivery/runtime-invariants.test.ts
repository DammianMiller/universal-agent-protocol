import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRuntimeHollownessNote,
  loadBlueprintInvariants,
  scanStaticHollowness,
} from '../../src/delivery/runtime-invariants.js';
import { saveOutcomeBlueprint } from '../../src/delivery/outcome-blueprint.js';
import { runAcceptanceGate } from '../../src/delivery/acceptance-judge.js';

describe('runtime-invariants anti-hollowness gate (Option B3)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uap-invariants-'));
    mkdirSync(join(root, 'src'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('catches undefined key lookup on an imported static constant lookup table (PAL.water class)', () => {
    writeFileSync(
      join(root, 'src', 'palette.js'),
      `export const PAL = {\n  stone: '#888888',\n  wood: '#6b4226',\n  roof: '#2d3a4b',\n};\n`,
      'utf-8'
    );
    writeFileSync(
      join(root, 'src', 'scene.js'),
      `import { PAL } from './palette.js';\nexport function paint() {\n  const a = PAL.stone;\n  const b = PAL.water;\n  return [a, b];\n}\n`,
      'utf-8'
    );

    const findings = scanStaticHollowness(root);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe('undefined-table-key');
    expect(findings[0].symbol).toBe('PAL.water');
    expect(findings[0].file).toBe('src/scene.js');
    expect(findings[0].detail).toContain("undefined key 'water'");
  });

  it('catches undefined key lookup on a local static constant table', () => {
    writeFileSync(
      join(root, 'src', 'status.ts'),
      `const STATUS_CODES = {\n  ok: 200,\n  notFound: 404,\n} as const;\nexport function getFail() { return STATUS_CODES.serverError; }\n`,
      'utf-8'
    );

    const findings = scanStaticHollowness(root);
    expect(findings.some((f) => f.symbol === 'STATUS_CODES.serverError')).toBe(true);
  });

  it('produces zero false positives on normal valid lookups, prototype methods, mutated dicts, or strings/comments', () => {
    writeFileSync(
      join(root, 'src', 'clean.ts'),
      [
        'export const ROUTES = { home: "/", health: "/health" };',
        'const dynamicCache: Record<string, number> = { init: 1 };',
        'dynamicCache.extra = 2;',
        'export function handle() {',
        '  // Comment mentioning ROUTES.missing should be ignored',
        '  const msg = "ROUTES.missing inside string literal";',
        '  const has = ROUTES.hasOwnProperty("home");',
        '  return { url: ROUTES.home, dyn: dynamicCache.extra, has, msg };',
        '}',
      ].join('\n'),
      'utf-8'
    );

    const findings = scanStaticHollowness(root);
    expect(findings).toEqual([]);
  });

  it('detects stubbed exported handlers throwing TODO/not implemented', () => {
    writeFileSync(
      join(root, 'src', 'worker.ts'),
      `export function runPipeline() {\n  throw new Error('TODO: implement pipeline');\n}\n`,
      'utf-8'
    );

    const findings = scanStaticHollowness(root);
    expect(findings.some((f) => f.kind === 'empty-subsystem-stub' && f.symbol === 'runPipeline')).toBe(true);
  });

  it('combines static hollowness findings, Blueprint invariants, and runtime telemetry', () => {
    writeFileSync(
      join(root, 'src', 'table.ts'),
      `const CFG = { host: 'localhost' };\nexport const p = CFG.port;\n`,
      'utf-8'
    );
    saveOutcomeBlueprint(root, {
      subsystems: [{ name: 'Server', purpose: 'HTTP API', keyArtifacts: ['src/table.ts'] }],
      fidelityTargets: ['Bind valid port'],
      runtimeInvariants: [
        {
          subsystem: 'Server',
          invariant: 'Server binds non-undefined port and answers /health 200',
          howToVerify: 'GET /health',
        },
      ],
      verificationPerspectives: ['Cold start'],
      antiPatterns: ['Undefined config reads'],
    });

    const invariants = loadBlueprintInvariants(root);
    expect(invariants).toHaveLength(1);

    const note = buildRuntimeHollownessNote(root, {
      execNote: 'exit 0',
      visualNote: 'rendered 1 page',
    });
    expect(note).toContain('STATIC HOLLOWNESS / RUNTIME DEFECTS DETECTED');
    expect(note).toContain('CFG.port');
    expect(note).toContain('BLUEPRINT RUNTIME INVARIANTS');
    expect(note).toContain('Server binds non-undefined port');
    expect(note).toContain('RUNTIME / INTERACTION / VISUAL TELEMETRY');
  });

  it('feeds static hollowness findings automatically into runAcceptanceGate prompts', async () => {
    writeFileSync(
      join(root, 'src', 'palette.js'),
      `export const PAL = { sky: '#00f' };\nexport const c = PAL.water;\n`,
      'utf-8'
    );

    let capturedPrompt = '';
    const res = await runAcceptanceGate({
      spec: 'Render scene with valid colors',
      projectRoot: root,
      executor: async (prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify({
          criteria: [{ requirement: 'Valid colors', met: false, reason: 'PAL.water is undefined' }],
          pass: false,
        });
      },
    });
    expect(capturedPrompt).toContain('PAL.water');
    expect(capturedPrompt).toContain('STATIC HOLLOWNESS');
    expect(res.passed).toBe(false);
  });
});
