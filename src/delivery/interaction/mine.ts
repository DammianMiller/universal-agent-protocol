/**
 * Manifest mining — turn a requirements document into probes.
 *
 * Two halves, deliberately:
 *
 *  - a DETERMINISTIC baseline that needs no model and always produces something
 *    real (it loads the artifact, drives its start interaction, and asserts the
 *    loop is alive and error-free). Tonight's fatal defect would have been
 *    caught by the baseline alone.
 *  - a MODEL pass that reads the requirements and proposes artifact-specific
 *    probes. Its output is validated and any probe naming an observable the
 *    artifact does not expose is dropped rather than shipped, because a probe
 *    that cannot observe anything reports failures the agent then "fixes" in
 *    working code.
 *
 * The model is an accelerator, never a dependency: with no model configured the
 * gate still runs, still gates, and still says plainly which requirements it
 * could not cover.
 */

import type { LoopExecutor } from '../convergence-loop.js';
import { hashSpec, validateManifest } from './manifest.js';
import type {
  ArtifactKind,
  InteractionManifest,
  Probe,
  Requirement,
} from './types.js';

/** Split a requirements document into candidate requirement lines. */
export function extractRequirements(specText: string): Requirement[] {
  const lines = specText
    .split('\n')
    .map((l) => l.trim())
    // Bullets and numbered items are where requirements actually live; prose
    // paragraphs are usually framing.
    .filter((l) => /^[-*•]\s+|^\d+[.)]\s+/.test(l))
    .map((l) => l.replace(/^[-*•]\s+|^\d+[.)]\s+/, '').trim())
    .filter((l) => l.length >= 12 && l.length <= 300);

  const seen = new Set<string>();
  const out: Requirement[] = [];
  for (const text of lines) {
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `R${out.length + 1}`, text, source: 'requirements' });
  }
  return out;
}

/**
 * Probes that apply to any web artifact, with no knowledge of what it does.
 * This is the floor: it cannot prove features work, but it does prove the thing
 * loads, responds to a click, and is still running afterwards — which is
 * precisely the class the visual gate reports as a pass.
 */
export function baselineWebProbes(requirementIds: string[] = []): Probe[] {
  return [
    {
      id: 'baseline-loads',
      requirementIds,
      mode: 'core',
      description: 'the artifact loads and reports no runtime errors',
      steps: [{ do: 'wait', ms: 1500 }],
      asserts: [
        { expect: 'truthy', expr: 'document.body !== null', label: 'the document rendered' },
        { expect: 'noErrors' },
      ],
    },
    {
      id: 'baseline-survives-interaction',
      requirementIds,
      mode: 'core',
      description: 'the artifact survives a click and keyboard input without dying',
      steps: [
        { do: 'click', x: 640, y: 400 },
        { do: 'wait', ms: 600 },
        { do: 'key', key: 'Escape' },
        { do: 'wait', ms: 400 },
        { do: 'click', x: 640, y: 400 },
        { do: 'wait', ms: 2000 },
      ],
      // The watchdog supplies the "is the loop still ticking" invariant; this
      // probe's job is to make sure something actually drove the artifact first.
      asserts: [{ expect: 'noErrors' }],
    },
  ];
}

const MINE_PROMPT = `You are deriving an INTERACTION TEST MANIFEST for a built artifact.

You will be given (1) the requirements the artifact was built from and (2) a
listing of its source. Produce probes that drive the artifact with real input
and assert against its OWN runtime state.

Return ONLY a JSON object of this shape, with no prose and no code fence:

{
  "watch": ["<expression yielding a number>", ...],
  "probes": [
    {
      "id": "kebab-case-id",
      "requirementIds": ["R1"],
      "mode": "core" | "soak" | "accelerated",
      "description": "what this proves, in one line",
      "steps": [
        {"do":"click","x":640,"y":400}, {"do":"wait","ms":800},
        {"do":"move","x":640,"y":560}, {"do":"down"}, {"do":"up"},
        {"do":"key","key":"Escape"},
        {"do":"repeat","times":20,"steps":[...]},
        {"do":"inject","expr":"<mutates state — ACCELERATED PROBES ONLY>"}
      ],
      "asserts": [
        {"expect":"equals","expr":"<expr>","value":"<v>"},
        {"expect":"gte","expr":"<expr>","value":1},
        {"expect":"increases","expr":"<expr>","overMs":12000,"by":1},
        {"expect":"changes","expr":"<expr>","overMs":8000},
        {"expect":"noErrors"}
      ]
    }
  ]
}

RULES
- Every expression must name state the artifact ACTUALLY exposes. Read the
  source listing and use the real identifiers. A module that only exports
  functions does not expose its internal arrays — do not invent members.
- Top-level \`const\`/\`let\` in a classic script are NOT properties of window;
  reference them bare (\`gameState\`), not as \`window.gameState\`.
- NEVER inject the state you then assert. Injection exists only to REACH a
  hard-to-reach path in an "accelerated" probe; the assertion must still be
  about what the artifact does next.
- Prefer assertions that would FAIL on a plausible bug: "score increases after
  sustained fire" catches a broken kill path; "score is a number" catches nothing.
- Use "soak" mode for anything proving sustained operation (many levels, long
  sessions). Use "core" for the primary promised behaviours.
`;

export interface MineOptions {
  projectRoot: string;
  kind: ArtifactKind;
  entry: string;
  /** The requirements text (mission, DESIGN.md, ledger plan). */
  specText: string;
  /** Source listing given to the model so it uses REAL identifiers. */
  sourceDigest?: string;
  executor?: LoopExecutor;
}

interface ModelManifestPart {
  watch?: string[];
  probes?: Probe[];
}

/** Strip a fence if the model added one despite instructions. */
export function parseMinedJson(raw: string): ModelManifestPart | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as ModelManifestPart;
  } catch {
    return null;
  }
}

/**
 * Build a manifest. Always returns one: the deterministic baseline is included
 * even when the model is absent or returns junk, so the gate never silently
 * degrades into "nothing to check".
 */
export async function mineManifest(opts: MineOptions): Promise<InteractionManifest> {
  const requirements = extractRequirements(opts.specText);
  const allIds = requirements.map((r) => r.id);
  // Baseline probes carry NO requirement ids. They prove the artifact loads and
  // survives input — nothing about any specific promise. Linking them to R1
  // would report that requirement as covered when nothing tested it, which is
  // exactly the false assurance the coverage ledger exists to prevent.
  const probes: Probe[] = [...baselineWebProbes()];
  let watch: string[] = [];

  if (opts.executor) {
    try {
      const prompt = `${MINE_PROMPT}\n\nREQUIREMENTS:\n${requirements
        .map((r) => `${r.id}: ${r.text}`)
        .join('\n')}\n\nSOURCE:\n${(opts.sourceDigest ?? '').slice(0, 24_000)}\n`;
      const parsed = parseMinedJson(await opts.executor(prompt));
      if (parsed) {
        if (Array.isArray(parsed.watch)) watch = parsed.watch.filter((w) => typeof w === 'string');
        for (const p of parsed.probes ?? []) {
          // Keep only probes that reference requirements we actually extracted,
          // so a hallucinated requirement id cannot smuggle in an unanchored probe.
          const ids = (p.requirementIds ?? []).filter((id) => allIds.includes(id));
          if (ids.length === 0) continue;
          probes.push({ ...p, requirementIds: ids });
        }
      }
    } catch {
      // A mining failure must not disable the gate — the baseline still runs.
    }
  }

  const manifest: InteractionManifest = {
    version: 1,
    kind: opts.kind,
    entry: opts.entry,
    specHash: hashSpec(opts.specText),
    generatedAt: new Date().toISOString(),
    requirements,
    probes,
    ...(watch.length > 0 ? { watch } : {}),
  };

  // Drop anything structurally invalid rather than shipping a manifest the
  // runner will reject wholesale (one bad model probe must not lose the rest).
  // Then RE-VALIDATE: a manifest that is still invalid after filtering would be
  // written to disk, fail to load forever, and make the gate report "no
  // manifest" — i.e. pass — on every subsequent run.
  const dropInvalidProbes = (m: InteractionManifest): string[] => {
    const problems = validateManifest(m);
    if (problems.length === 0) return [];
    const bad = new Set(
      problems
        .map((p) => /^probe (\S+):/.exec(p)?.[1])
        .filter((id): id is string => Boolean(id))
    );
    if (bad.size > 0) m.probes = m.probes.filter((p) => !bad.has(p.id));
    return validateManifest(m);
  };
  const remaining = dropInvalidProbes(manifest);
  if (remaining.length > 0) {
    // Whatever is left is not probe-scoped (a bad `watch` entry, a bad kind).
    // Fall back to the baseline rather than persisting something unloadable.
    manifest.probes = baselineWebProbes();
    delete manifest.watch;
    const stillBad = validateManifest(manifest);
    if (stillBad.length > 0) {
      throw new Error(`mined manifest is invalid and could not be repaired: ${stillBad.join('; ')}`);
    }
  }
  return manifest;
}
