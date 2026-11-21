import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatBlueprintContract,
  generateOutcomeBlueprint,
  loadOutcomeBlueprint,
  maybeBlueprintInjection,
  parseOutcomeBlueprint,
  renderBlueprintMarkdown,
  saveOutcomeBlueprint,
  type OutcomeBlueprint,
} from '../../src/delivery/outcome-blueprint.js';
import { defaultPromptBuilder } from '../../src/delivery/convergence-loop.js';
import { resolve as resolveReactor } from '../../src/coordination/reactor.js';
import { resolveAcceptanceSpecAuto } from '../../src/cli/verify.js';

const SAMPLE_BLUEPRINT_JSON = JSON.stringify({
  subsystems: [
    {
      name: 'Parser Engine',
      purpose: 'Parse query DSL into typed AST nodes',
      keyArtifacts: ['src/parser.ts', 'src/ast.ts'],
    },
    {
      name: 'Execution Planner',
      purpose: 'Compile AST into streaming iterator pipeline',
      keyArtifacts: ['src/planner.ts'],
    },
  ],
  fidelityTargets: [
    'Support nested boolean predicates and projection clauses without fallback stubs',
    'Include deterministic benchmark fixtures covering 10k rows',
  ],
  runtimeInvariants: [
    {
      subsystem: 'Parser Engine',
      invariant: 'Malformed inputs return structured syntax errors with line/column numbers',
      howToVerify: 'Run parser test suite on invalid grammar corpus',
    },
    {
      subsystem: 'Execution Planner',
      invariant: 'Planner emits non-empty execution plan nodes for all supported clauses',
      howToVerify: 'Assert compiled pipeline step count > 0 and output matches reference',
    },
  ],
  verificationPerspectives: [
    'Valid complex nested query execution',
    'Invalid syntax error recovery and location accuracy',
    'Empty dataset and boundary cardinality edge cases',
  ],
  antiPatterns: [
    'Hardcoding canned outputs for sample queries',
    'Leaving unimplemented operator branches returning empty arrays',
  ],
});

describe('outcome-blueprint (Option B1)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uap-blueprint-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('parses structured blueprint JSON even when wrapped in reasoning prose', () => {
    const raw = `Let me carefully plan all subsystems first.\n\n${SAMPLE_BLUEPRINT_JSON}\nDone.`;
    const bp = parseOutcomeBlueprint(raw);
    expect(bp).not.toBeNull();
    expect(bp!.subsystems).toHaveLength(2);
    expect(bp!.subsystems[0].name).toBe('Parser Engine');
    expect(bp!.fidelityTargets).toHaveLength(2);
    expect(bp!.runtimeInvariants).toHaveLength(2);
    expect(bp!.verificationPerspectives).toHaveLength(3);
    expect(bp!.antiPatterns).toHaveLength(2);
  });

  it('returns null on unparseable or empty blueprint responses', () => {
    expect(parseOutcomeBlueprint('not json at all')).toBeNull();
    expect(parseOutcomeBlueprint('{"subsystems":[],"fidelityTargets":[]}')).toBeNull();
  });

  it('generates and persists .uap/blueprint.json and .uap/blueprint.md', async () => {
    const bp = await generateOutcomeBlueprint({
      instruction: 'Build a query engine with parser, planner, and CLI runner',
      projectRoot: root,
      executor: async () => SAMPLE_BLUEPRINT_JSON,
    });
    expect(bp).not.toBeNull();
    expect(existsSync(join(root, '.uap', 'blueprint.json'))).toBe(true);
    expect(existsSync(join(root, '.uap', 'blueprint.md'))).toBe(true);

    const loaded = loadOutcomeBlueprint(root);
    expect(loaded?.subsystems).toHaveLength(2);
    const md = readFileSync(join(root, '.uap', 'blueprint.md'), 'utf-8');
    expect(md).toContain('# Outcome Blueprint');
    expect(md).toContain('Parser Engine');
    expect(md).toContain('Runtime Invariants');
  });

  it('fails soft (returns null) when the blueprint executor throws', async () => {
    const bp = await generateOutcomeBlueprint({
      instruction: 'Build something',
      projectRoot: root,
      executor: async () => {
        throw new Error('backend unavailable');
      },
    });
    expect(bp).toBeNull();
  });

  it('formats a concise blueprint contract and injects it into ConvergenceLoop prompts', () => {
    const bp = parseOutcomeBlueprint(SAMPLE_BLUEPRINT_JSON) as OutcomeBlueprint;
    const contract = formatBlueprintContract(bp);
    expect(contract).toContain('OUTCOME BLUEPRINT');
    expect(contract).toContain('Parser Engine');
    expect(contract).toContain('Runtime invariants');

    const turn1 = defaultPromptBuilder({
      instruction: 'Build query engine',
      turn: 1,
      blueprintContract: contract,
    });
    expect(turn1).toContain('OUTCOME BLUEPRINT');

    const turn2 = defaultPromptBuilder({
      instruction: 'Build query engine',
      turn: 2,
      feedback: 'test failed',
      blueprintContract: contract,
    });
    expect(turn2).toContain('OUTCOME BLUEPRINT');
  });

  it('maybeBlueprintInjection stays quiet for short/simple prompts and fires for multi-subsystem prompts', () => {
    expect(maybeBlueprintInjection(root, 'fix typo in readme')).toBeNull();

    const complexPrompt =
      'Architect and implement a multi-stage ingestion pipeline with schema validation, streaming deduplication, retry queue, metrics exporter, and CLI inspector.';
    const injected = maybeBlueprintInjection(root, complexPrompt);
    expect(injected).not.toBeNull();
    expect(injected).toContain('Phase 0 Outcome Blueprint');

    // When .uap/blueprint.md exists, it surfaces the saved blueprint directly even on short prompts.
    const bp = parseOutcomeBlueprint(SAMPLE_BLUEPRINT_JSON) as OutcomeBlueprint;
    saveOutcomeBlueprint(root, bp);
    const fromDisk = maybeBlueprintInjection(root, 'continue');
    expect(fromDisk).toContain('.uap/blueprint.md');
    expect(fromDisk).toContain('Parser Engine');
  });

  it('wires into reactor.resolve with blueprint:phase0 deduplication', () => {
    const bp = parseOutcomeBlueprint(SAMPLE_BLUEPRINT_JSON) as OutcomeBlueprint;
    saveOutcomeBlueprint(root, bp);

    const first = resolveReactor({
      event: 'user-prompt',
      promptText: 'implement the planner subsystem',
      cwd: root,
    });
    expect(first.surfacedKeys).toContain('blueprint:phase0');
    expect(first.inject).toContain('Phase 0 Outcome Blueprint');

    const second = resolveReactor({
      event: 'user-prompt',
      promptText: 'implement the planner subsystem',
      cwd: root,
      surfaced: ['blueprint:phase0'],
    });
    expect(second.surfacedKeys).not.toContain('blueprint:phase0');
  });

  it('resolveAcceptanceSpecAuto discovers .uap/blueprint.md and .uap/blueprint.json', () => {
    const bp = parseOutcomeBlueprint(SAMPLE_BLUEPRINT_JSON) as OutcomeBlueprint;
    mkdirSync(join(root, '.uap'), { recursive: true });
    writeFileSync(join(root, '.uap', 'blueprint.json'), JSON.stringify(bp), 'utf-8');

    const fromJson = resolveAcceptanceSpecAuto(root);
    expect(fromJson).toContain('Parser Engine');
    expect(fromJson).toContain('Runtime Invariants');

    writeFileSync(join(root, '.uap', 'blueprint.md'), renderBlueprintMarkdown(bp), 'utf-8');
    const fromMd = resolveAcceptanceSpecAuto(root);
    expect(fromMd).toContain('# Outcome Blueprint');
  });
});
