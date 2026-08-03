/**
 * Harness disclosure card (harness plan area F, 2026-07-31).
 *
 * "Stop Comparing LLM Agents Without Disclosing the Harness" (arXiv 2605.23950)
 * measures harness variance at 18.48 pp^2 against model variance at 2.37 pp^2 —
 * a 7.8x ratio — and finds that 6 of 9 model rankings REVERSE when the harness
 * changes. A benchmark number without its harness is therefore not a weak
 * result; it is an uninterpretable one. Their remedy is a disclosure card over
 * seven layers (ETCSOVG), emitted with every reported score.
 *
 * We emit ours for a second reason the paper does not need: the card is the
 * DECLARED SEARCH SPACE. `ToolMod` and `MiddlewareMod` in the self-harness loop
 * mutate fields named here, so "what can the harness change about itself" and
 * "what did the harness look like when it scored X" are the same document.
 */

/** One disclosed layer. `fields` is ordered; renderers must not sort it. */
export interface HarnessLayer {
  /** Single-letter ETCSOVG code. */
  code: 'E' | 'T' | 'C' | 'S' | 'O' | 'V' | 'G';
  name: string;
  fields: Array<{ key: string; value: string }>;
}

export interface HarnessCard {
  /** Card schema version — bump when a layer's field set changes meaningfully. */
  version: string;
  /** UAP version the run used. */
  uapVersion: string;
  /** Model identifier, when the caller knows it. */
  model?: string;
  layers: HarnessLayer[];
}

export interface HarnessCardInput {
  uapVersion: string;
  model?: string;
  /** Tool names offered to the model this run. */
  tools?: readonly string[];
  /** Whether `run_bash` was permitted. */
  allowBash?: boolean;
  /** Whether the kernel sandbox was active. */
  sandboxed?: boolean;
  /** Estimated-token ceiling for one agentic session, if set. */
  contextTokenBudget?: number;
  /**
   * Per-completion `max_tokens` ceiling. Disclosed because a reasoning model
   * spends this budget on a hidden thinking channel BEFORE emitting any answer
   * token, so a budget set for the answer alone silently yields EMPTY
   * completions (finish_reason=length) that look like format non-compliance.
   * The raw bench adapter hardcoded 4096 while this repo's profile for the same
   * local model allocates 81920 — a 20x starvation that pinned both arms toward
   * the floor and appeared nowhere in any report.
   */
  completionTokenBudget?: number;
  /** Max tool-call rounds before a final answer is forced. */
  maxToolRounds?: number;
  /** Per-command bash timeout, ms. */
  bashTimeoutMs?: number;
  /** Memory retrieval mode in force. */
  memoryMode?: string;
  /** Gate ladder / verification rails engaged. */
  verification?: readonly string[];
  /** Extra middleware identifiers active on the proxy path. */
  middleware?: readonly string[];
  /**
   * Edit-matching strategy in force for the RUN. Injected, not read from
   * `process.env` at render time — a card built in the reporting process would
   * otherwise disclose the reporter's environment rather than the run's.
   */
  editStrategy?: string;
  /** Bytes returned per read_file call for the run. */
  readWindowBytes?: number;
  /** Whether the stub-substance guard was active for the run. */
  stubGuard?: boolean;
  /** Whether the anti-gutting guard was active for the run. */
  guttingGuard?: boolean;
}

const CARD_VERSION = '1';

function yes(v: boolean | undefined): string {
  return v === undefined ? 'unknown' : v ? 'yes' : 'no';
}

function num(v: number | undefined): string {
  return v === undefined ? 'unset' : String(v);
}

/**
 * Build the card from the harness configuration actually in force.
 *
 * Honest-by-construction: a field the caller did not supply reads 'unknown' or
 * 'unset' rather than a plausible default. A card that guesses is worse than no
 * card, because it will be cited.
 */
export function buildHarnessCard(input: HarnessCardInput): HarnessCard {
  const tools = input.tools ?? [];
  return {
    version: CARD_VERSION,
    uapVersion: input.uapVersion,
    model: input.model,
    layers: [
      {
        code: 'E',
        name: 'Execution',
        fields: [
          { key: 'substrate', value: input.sandboxed ? 'uap sandbox (kernel-contained)' : 'host process' },
          { key: 'shell', value: yes(input.allowBash) },
          { key: 'bash_timeout_ms', value: num(input.bashTimeoutMs) },
          { key: 'workdir_scope', value: 'project root; path escapes refused' },
        ],
      },
      {
        code: 'T',
        name: 'Tool',
        fields: [
          { key: 'tools', value: tools.length > 0 ? tools.join(', ') : 'unknown' },
          { key: 'schema_style', value: 'openai function-calling (JSON schema)' },
          { key: 'edit_strategy', value: input.editStrategy ?? 'unknown' },
          { key: 'batch_edits', value: tools.includes('edit_file') ? 'yes (edits[])' : 'unknown' },
          { key: 'error_format', value: 'prose, actionable, corrective steer named' },
        ],
      },
      {
        code: 'C',
        name: 'Context',
        fields: [
          { key: 'token_budget', value: num(input.contextTokenBudget) },
          { key: 'completion_budget', value: num(input.completionTokenBudget) },
          { key: 'read_window_bytes', value: num(input.readWindowBytes) },
          { key: 'memory_mode', value: input.memoryMode ?? 'unknown' },
          { key: 'compression', value: 'semantic units + dynamic compressor' },
        ],
      },
      {
        code: 'S',
        name: 'Scheduling',
        fields: [
          { key: 'max_tool_rounds', value: num(input.maxToolRounds) },
          { key: 'stopping_rule', value: 'finish tool, round cap, or context budget' },
          { key: 'forced_write', value: 'write-only tool set after a read-only streak' },
          { key: 'retry', value: 'convergence loop re-executes on gate failure' },
        ],
      },
      {
        code: 'O',
        name: 'Observability',
        fields: [
          { key: 'tool_call_corpus', value: 'telemetry.db tool_calls (per call, classified)' },
          { key: 'traces', value: 'HALO spans + agentic event stream' },
          { key: 'attribution', value: 'component + failure class per call' },
        ],
      },
      {
        code: 'V',
        name: 'Verification',
        fields: [
          {
            key: 'rails',
            value:
              input.verification && input.verification.length > 0
                ? input.verification.join(', ')
                : 'unknown',
          },
          { key: 'paired_stats', value: 'cell-for-cell pairing + held-out disjoint suite' },
        ],
      },
      {
        code: 'G',
        name: 'Governance',
        fields: [
          { key: 'protected_paths', value: 'tests/oracles, locked contracts, gate configs, agent-internal' },
          { key: 'stub_guard', value: yes(input.stubGuard) },
          { key: 'gutting_guard', value: yes(input.guttingGuard) },
          { key: 'middleware', value: (input.middleware ?? []).join(', ') || 'none' },
          { key: 'secrets', value: 'sanitized env; local-only credential scope' },
        ],
      },
    ],
  };
}

/** Render the card as the markdown block that ships with a benchmark report. */
export function renderHarnessCard(card: HarnessCard): string {
  const lines: string[] = [];
  lines.push(`## Harness disclosure card (ETCSOVG v${card.version})`);
  lines.push('');
  lines.push(`- UAP: \`${card.uapVersion}\``);
  if (card.model) lines.push(`- Model: \`${card.model}\``);
  lines.push('');
  lines.push('| Layer | Field | Value |');
  lines.push('|---|---|---|');
  for (const layer of card.layers) {
    for (const f of layer.fields) {
      lines.push(`| ${layer.code} ${layer.name} | ${f.key} | ${f.value} |`);
    }
  }
  lines.push('');
  lines.push(
    '> Harness variance dominates model variance (18.48 pp² vs 2.37 pp², arXiv 2605.23950). ' +
      'A score without this card is not comparable to any other score.',
  );
  return lines.join('\n');
}

/**
 * The subset of card fields the self-harness loop is allowed to MUTATE.
 *
 * Keeping this list next to the card is the point: a knob that is searched but
 * not disclosed makes every historical score incomparable to the next one.
 */
export const MUTABLE_CARD_FIELDS = [
  'T.edit_strategy',
  'T.tools',
  'C.read_window_bytes',
  'C.token_budget',
  // Memory is the LARGEST single component in the AHE ablation (+5.6pp). Leaving
  // it out of the searchable set meant the retrieval mode could never be A/B'd,
  // so the gate that keeps active reconstruction off could never open.
  'C.memory_mode',
  'S.max_tool_rounds',
  'G.middleware',
] as const;
