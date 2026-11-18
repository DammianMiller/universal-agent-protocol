/**
 * doc-style class tests — the fourth outcome class, harvested from the
 * v2.51.1 rewrite corpus; plus the durable escalation records (Wave 1.4
 * repo-side half: the ladder firing is the operator's placement queue).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractDocVector } from '../../src/quality/doc-style.js';
import { resolveClass, storeArtifactAnchor } from '../../src/quality/classes.js';
import { deriveTier, gapReport } from '../../src/quality/tiers.js';
import { runTierLadder, TierLadderCandidate } from '../../src/quality/tier-ladder.js';
import { qualityCommand } from '../../src/cli/quality.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-docstyle-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function docFile(name: string, text: string): string {
  const p = join(tmp, name);
  writeFileSync(p, text);
  return p;
}

/** Exemplar prose in the shipped corpus style: short sentences, no em dashes. */
const EXEMPLAR = [
  '# Guide',
  '',
  'UAP installs hooks into your agent harness. The hooks mediate every tool call.',
  'Memory is one store shared by every agent. Recall first on non-trivial work.',
  'The gate runs at commit time. It blocks new violations only.',
  'Anchors are measuring references. They never ship with the package.',
  'Use a worktree for every change. The gate refuses direct master edits.',
  'Version bumps go through the script. It needs a clean tree first.',
].join('\n');

/** Degraded prose: em dashes, long sentences, and a repeated line. */
const DEGRADED = [
  '# Guide',
  '',
  'UAP installs hooks into your agent harness — and the hooks mediate every tool call — while the memory layer stores durable facts — so every agent compounds the same knowledge instead of siloing recall per session.',
  'The gate runs at commit time — it blocks new violations only.',
  'The gate runs at commit time — it blocks new violations only.',
  'Anchors are measuring references — they never ship with the package.',
  'Use a worktree for every change — the gate refuses direct master edits.',
  'Version bumps go through the script — it needs a clean tree first.',
].join('\n');

describe('extractDocVector', () => {
  it('measures exemplar-style prose at zero em dashes and sane lengths', () => {
    const v = extractDocVector(docFile('ex.md', EXEMPLAR))!;
    expect(v.scalars?.emDashPer1k).toBe(0);
    expect(v.scalars?.dupSentenceFrac).toBe(0);
    expect(v.scalars?.sentenceLenMean).toBeGreaterThan(5);
    expect(v.scalars?.sentenceLenMean).toBeLessThan(20);
    expect(v.scalars?.wordLenMean).toBeGreaterThan(3);
    expect(v.scalars?.wordLenMean).toBeLessThan(7);
    expect(v.scalars?.proseChars).toBeGreaterThan(200);
    expect(v.extractorVersion).toBe(1);
    expect(v.sha256).toHaveLength(64);
  });

  it('is deterministic: the same file extracts to the same vector', () => {
    const p = docFile('same.md', EXEMPLAR);
    expect(extractDocVector(p)!.scalars).toEqual(extractDocVector(p)!.scalars);
  });

  it('flags degraded prose: em dashes, repeats, and long sentences', () => {
    const v = extractDocVector(docFile('bad.md', DEGRADED))!;
    expect(v.scalars?.emDashPer1k).toBeGreaterThan(0.5);
    expect(v.scalars?.dupSentenceFrac).toBeGreaterThan(0.05);
    // 16+ words/sentence vs ~9 for exemplar prose — the readability gap
    expect(v.scalars?.sentenceLenMean).toBeGreaterThan(15);
  });

  it('strips scaffolding: a dash inside a code fence does not count', () => {
    const withCode = `${EXEMPLAR}\n\n\`\`\`bash\nrun --flag — weird\n\`\`\`\n| a | b — c |\n|---|---|\n`;
    const v = extractDocVector(docFile('code.md', withCode))!;
    expect(v.scalars?.emDashPer1k).toBe(0);
  });

  it('fails soft to null on unreadable files', () => {
    expect(extractDocVector(join(tmp, 'nope.md'))).toBeNull();
  });
});

describe('registry: doc-style class', () => {
  it('carries the four axes, the artifact phrase, and the writing sampling profile', () => {
    const spec = resolveClass('doc-style');
    expect(spec.artifact).toBe('documentation (Markdown)');
    expect(Object.keys(spec.axes).sort()).toEqual(['dupSentenceFrac', 'emDashPer1k', 'sentenceLenMean', 'wordLenMean']);
    expect(spec.sampling).toEqual({ temperature: 0.4 });
    expect(spec.degenerate?.({ scalars: { proseChars: 42 } } as never)).toContain('degenerate document');
  });
});

describe('doc-style tier: anchor, derive, gap', () => {
  it('derives the style tier from exemplar anchors and fails a degraded doc with directives', () => {
    storeArtifactAnchor(tmp, 'doc-style', docFile('ex1.md', EXEMPLAR));
    storeArtifactAnchor(tmp, 'doc-style', docFile('ex2.md', EXEMPLAR.replace('Guide', 'Guide two')));
    const tier = deriveTier(tmp, 'doc-style', 'v2-51-1')!;
    expect(tier.key).toBe('doc-style/v2-51-1');
    expect(Object.keys(tier.thresholds).sort()).toEqual(
      ['dupSentenceFrac', 'emDashPer1k', 'sentenceLenMean', 'wordLenMean'],
    );
    // exemplars carry zero em dashes: the ceiling is 0 / 0.75 = 0
    expect(tier.thresholds.emDashPer1k).toEqual({ max: 0 });

    const good = gapReport(tmp, docFile('cap-good.md', EXEMPLAR.replace('Guide', 'Capture')), 'doc-style/v2-51-1');
    expect(good.kind).toBe('ok');
    expect(good.report.pass).toBe(true);

    const bad = gapReport(tmp, docFile('cap-bad.md', DEGRADED), 'doc-style/v2-51-1');
    expect(bad.kind).toBe('ok');
    expect(bad.report.pass).toBe(false);
    const failing = bad.report.axes.filter((a) => a.status === 'fail').map((a) => a.axis);
    expect(failing).toContain('emDashPer1k');
    expect(failing).toContain('dupSentenceFrac');
    const directiveText = bad.report.axes.map((a) => a.directive).join(' ');
    expect(directiveText).toContain('replace prose em dashes');
    expect(directiveText).toContain('cut repeated sentences');
  });

  it('a stub document is degenerate evidence, not a pass', () => {
    storeArtifactAnchor(tmp, 'doc-style', docFile('ex.md', EXEMPLAR));
    deriveTier(tmp, 'doc-style', 'v2-51-1')!;
    const stub = docFile('stub.md', '# Title\n\n```json\n{"a": 1}\n```\n');
    const res = gapReport(tmp, stub, 'doc-style/v2-51-1');
    expect(res.kind).toBe('ok');
    expect(res.report.pass).toBe(false);
    expect(res.report.worst).toBe('degenerate');
  });
});

describe('escalation records (Wave 1.4 repo-side half)', () => {
  it('a stalled ladder appends one line per fired escalation to .uap/quality/escalations.jsonl', async () => {
    storeArtifactAnchor(tmp, 'doc-style', docFile('ex.md', EXEMPLAR));
    deriveTier(tmp, 'doc-style', 'v2-51-1')!;
    const stalled: TierLadderCandidate[] = [{ id: 'flat', artifactPath: docFile('flat.md', DEGRADED) }];
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey: 'doc-style/v2-51-1',
      generate: () => stalled,
      maxRounds: 4,
      plateauRounds: 1,
    });
    expect(result.outcome).toBe('cut-exhausted');
    // plateau=1: rounds 2 and 3 escalate (round 4 is the last), round 1 improves
    const logFile = join(tmp, '.uap', 'quality', 'escalations.jsonl');
    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].tier).toBe('doc-style/v2-51-1');
    expect(lines[0].round).toBe(2);
    expect(lines[1].round).toBe(3);
    expect(lines[0].summary).toContain('plateau');
    expect(lines[0].summary).toContain('worst');
  });
});

describe('qualityCommand: doc-style surfaces', () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  });

  it('profile --class doc-style prints the prose scalars', async () => {
    const p = docFile('cap.md', DEGRADED);
    await qualityCommand('profile', { file: p, class: 'doc-style' });
    expect(process.exitCode).toBeUndefined();
    const out = logs.join('\n');
    expect(out).toContain('emDashPer1k=');
    expect(out).toContain('sentenceLenMean=');
    expect(out).toContain('dupSentenceFrac=');
  });

  it('a stub anchor is stored but refused at derive time (degenerate anchors never set policy)', async () => {
    const stub = docFile('stub.md', '# Title\n\n```json\n{"a": 1}\n```\n');
    await qualityCommand('anchor', { projectDir: tmp, target: 'doc-style', file: stub });
    expect(process.exitCode).toBeUndefined();
    await qualityCommand('derive', { projectDir: tmp, target: 'doc-style', name: 'x' });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('no anchors');
  });

  it('contract for a doc-style tier carries the punctuation directive and sampling', async () => {
    storeArtifactAnchor(tmp, 'doc-style', docFile('ex.md', EXEMPLAR));
    deriveTier(tmp, 'doc-style', 'v2-51-1')!;
    await qualityCommand('contract', { projectDir: tmp, tier: 'doc-style/v2-51-1' });
    expect(process.exitCode).toBeUndefined();
    const out = logs.join('\n');
    expect(out).toContain('emDashPer1k: at most 0');
    expect(out).toContain('replace prose em dashes');
    expect(out).toContain('temperature 0.4');
  });
});
