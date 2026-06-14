# UAP Auto-Apply ("Reactor") — Design & Contract

Status: in implementation (feature/227-uap-auto-apply-reactor)
Goal: every UAP capability that is appropriate to apply automatically fires
automatically and *dynamically* (context-aware) across all supported coding
agents, instead of requiring manual invocation.

## 1. Two modes (never conflated)

- **Enforce** — deterministic, hard gates that must always fire (worktree,
  policy/compliance, delivery, schema-diff, completion). These *block*
  (exit 2 / throw). Already largely wired; this feature fills the gaps.
- **Assist** — capabilities that *should* fire when contextually appropriate
  (memory recall, pattern RAG, expert-route, skill surfacing, model routing,
  task linking). These *inject context* the model sees — raising the odds it
  uses the right tool without removing judgement. Optionally **auto-spawn**
  an expert above a confidence threshold for whitelisted task types.

## 2. Architecture: one resolver, many adapters

A single harness-agnostic entrypoint `uap react --event <evt>` consumes a JSON
payload on stdin and emits a JSON result. Harness adapters are thin shims that
normalise each harness's event name/format, call `uap react`, then map
`inject` → injected context and `block` → exit-2/throw.

```
harness hook ──payload──▶ uap react ──▶ resolve() ──▶ { inject, block, actions }
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
   CapabilityRouter.routeTask     PatternRouter.matchPatterns      memory recall (async, later phase)
   → experts + skills + conf      → enforcement patterns           → relevant memories
```

The resolver composes existing, tested code: `CapabilityRouter.routeTask`
(`src/coordination/capability-router.ts`), `PatternRouter.matchPatterns`
(`src/coordination/pattern-router.ts`), and `ExpertOrchestrator.plan`
(`src/coordination/expert-orchestrator.ts`).

## 3. Resolver contract (`src/coordination/reactor.ts`)

```ts
export type ReactorEvent =
  | 'session-start' | 'user-prompt' | 'pre-tool' | 'post-tool' | 'stop' | 'session-end';

export interface ReactorContext {
  event: ReactorEvent;
  promptText?: string;     // the user's message (user-prompt event)
  changedFiles?: string[]; // files in play (routing signal)
  tool?: string;           // tool name (pre/post-tool)
  cwd?: string;
  sessionId?: string;
  surfaced?: string[];     // dedup keys already injected this session
}

export interface ReactorAction {
  kind: 'spawn-expert' | 'suggest-skill' | 'enforce' | 'link-task';
  target: string;          // droid/skill/pattern id
  confidence: number;      // 0..1
  reason: string;
}

export interface ReactorResult {
  inject: string;          // markdown context card; '' when nothing relevant
  block: boolean;          // hard gate (enforce mode)
  reason: string;
  actions: ReactorAction[];
  surfacedKeys: string[];  // keys to add to the session dedup cache
  confidence: number;      // overall routing confidence
}

export interface ReactorOptions {
  injectThreshold?: number;       // default 0.30 — below → stay silent
  autoSpawnThreshold?: number;    // default 0.80 — above + whitelisted → spawn action
  autoSpawnTaskTypes?: string[];  // whitelist, e.g. ['security','migration','release']
  maxInjectChars?: number;        // default 1200 — token-budget guard
}

export interface ReactorDeps {        // for hermetic testing
  capabilityRouter?: CapabilityRouter;
  patternRouter?: PatternRouter;
}

export function resolve(
  ctx: ReactorContext,
  opts?: ReactorOptions,
  deps?: ReactorDeps,
): ReactorResult;
```

### Behaviour (the oracle — see `test/reactor.test.ts`)

1. `user-prompt` with a substantive coding prompt → builds a `Task` from
   `promptText`/`changedFiles`, runs `routeTask` + `matchPatterns`, returns a
   non-empty `inject` listing recommended experts, skills, and matched
   patterns; `confidence` mirrors routing confidence.
2. Routing confidence `< injectThreshold` **and** no matched patterns →
   `inject === ''` (silence beats noise).
3. Auto-spawn: confidence `>= autoSpawnThreshold` **and** a recommended
   capability whose task type ∈ `autoSpawnTaskTypes` → an action with
   `kind:'spawn-expert'`. Below threshold or off-whitelist → only
   `kind:'suggest-skill'` / no spawn.
4. Dedup: any item whose key ∈ `ctx.surfaced` is excluded from `inject` and
   from `actions`; `surfacedKeys` returns only the newly-surfaced keys.
5. Budget: `inject.length <= maxInjectChars` (truncate lowest-confidence items
   first; never hard-cut mid-item).
6. Assist never blocks: for non-enforce events `block === false` always.

## 4. Feature → auto-application matrix

| Feature | Trigger | Mode |
|---|---|---|
| memory recall | per-prompt (semantic on prompt) | Assist |
| patterns RAG | per-prompt | Assist |
| expert-route / droids | per-prompt when substantial coding | Assist (+auto-spawn) |
| skills | per-prompt, surface top-N | Assist |
| model routing | per-task complexity | Assist |
| task link/create | per-prompt | Assist |
| worktree gate | pre-tool | Enforce |
| policy/compliance | pre-tool + stop | Enforce |
| delivery routing | substantial coding → `uap deliver` | Enforce |
| schema-diff | schema-file edits (post-tool) | Enforce |
| completion gate | stop | Enforce |
| HALO analyze | session-end | Assist |
| deploy flush | on deliver success | Enforce |
| rtk token-opt | pre-tool (bash) | Enforce (already) |
| ideate | on-demand only (router suggests when stuck) | Assist |

## 5. Per-harness wiring

| Harness | Per-prompt inject point | Notes |
|---|---|---|
| Claude | `UserPromptSubmit` hook → `uap react` | supported, currently unwired |
| Cursor | `userPromptSubmit` (mirrors Claude) | |
| OpenCode | `experimental.chat.system.transform` | generalise existing uap-pattern-rag.ts/uap-skills.ts |
| Factory | `UserPromptSubmit` (pattern-rag-prompt.sh) | also **fix empty SessionStart** |
| Forge | pre-prompt shell fn or session-level | installer auto-sources |
| Codex | none → MCP `uap_react` tool + AGENTS.md | degraded mode (no hooks) |

`uap hooks install <target>` writes the correct per-harness wiring so a fresh
`uap setup` yields full parity.

## 6. Anti-noise & safety

- Confidence gate (only inject above threshold).
- Per-session dedup cache (never re-inject the same item twice).
- Inject token budget (hard cap, truncate lowest-confidence first).
- Enforce stays hard; assist can never block.

## 7. Rollout phases

1. **Resolver core** (`src/coordination/reactor.ts`) + contract tests.
2. **CLI** `uap react` + JSON I/O + tests.
3. **Reference harness** wiring: Claude `UserPromptSubmit` + OpenCode transform.
4. **Parity**: Cursor, Factory (fix SessionStart), Forge; `uap hooks install`.
5. **Codex degraded mode**: MCP `uap_react` tool + AGENTS.md.
6. **Enforce gap-fill**: schema-diff post-tool, completion-gate-on-stop, deploy-on-deliver.

All source units are implemented via the `uap deliver` convergence loop against
the contract tests (the protected oracle).
