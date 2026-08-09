import { CapabilityRouter, getCapabilityRouter } from './capability-router.js';
import { PatternRouter, getPatternRouter } from './pattern-router.js';
import { maybeDesignInjection } from '../design/reactor-inject.js';
import { maybePrinciplesInjection } from '../principles/reactor-inject.js';
import { maybeBoardInjection } from './board-inject.js';
import { maybeCollaborationInjection } from './collaboration-inject.js';
import { maybeStateInjection } from '../state/reactor-inject.js';
import { maybePersistenceInjection } from './persistence-inject.js';

export type ReactorEvent = 'session-start' | 'user-prompt' | 'pre-tool' | 'post-tool' | 'stop' | 'session-end';

export interface ReactorContext {
  event: ReactorEvent;
  promptText?: string;
  changedFiles?: string[];
  tool?: string;
  cwd?: string;
  sessionId?: string;
  surfaced?: string[];
}

export interface ReactorAction {
  kind: 'spawn-expert' | 'suggest-skill' | 'enforce' | 'link-task';
  target: string;
  confidence: number;
  reason: string;
}

export interface ReactorResult {
  inject: string;
  block: boolean;
  reason: string;
  actions: ReactorAction[];
  surfacedKeys: string[];
  confidence: number;
}

export interface ReactorOptions {
  injectThreshold?: number;
  autoSpawnThreshold?: number;
  autoSpawnTaskTypes?: string[];
  maxInjectChars?: number;
}

export interface ReactorDeps {
  capabilityRouter?: CapabilityRouter;
  patternRouter?: PatternRouter;
}

const DEFAULT_INJECT_THRESHOLD = 0.30;
const DEFAULT_AUTO_SPAWN_THRESHOLD = 0.80;
const DEFAULT_MAX_INJECT_CHARS = 1200;

// #3-B: capabilities that imply writing/modifying source. When a task routes to
// one of these, the reactor proactively tells the agent to route file writes
// through `uap deliver` BEFORE it hits the (blocking) delivery-enforcement gate
// — weak local models otherwise retry the blocked edit or hallucinate completion.
const CODE_CAPABILITIES = new Set<string>([
  'typescript', 'javascript', 'python', 'rust', 'go', 'cpp', 'java',
  'frontend', 'backend', 'cli', 'api-design',
]);

interface InjectItem {
  key: string;
  name: string;
  confidence: number;
  type: 'droid' | 'skill' | 'pattern';
  title?: string;
}

export function resolve(
  ctx: ReactorContext,
  opts?: ReactorOptions,
  deps?: ReactorDeps
): ReactorResult {
  const injectThreshold = opts?.injectThreshold ?? DEFAULT_INJECT_THRESHOLD;
  const autoSpawnThreshold = opts?.autoSpawnThreshold ?? DEFAULT_AUTO_SPAWN_THRESHOLD;
  const maxInjectChars = opts?.maxInjectChars ?? DEFAULT_MAX_INJECT_CHARS;
  const autoSpawnTaskTypes = opts?.autoSpawnTaskTypes ?? [];

  const capabilityRouter = deps?.capabilityRouter ?? getCapabilityRouter();
  const patternRouter = deps?.patternRouter ?? getPatternRouter();

  const result: ReactorResult = {
    inject: '',
    block: false,
    reason: '',
    actions: [],
    surfacedKeys: [],
    confidence: 0,
  };

  if (!ctx.promptText) {
    return result;
  }

  const routeResult = capabilityRouter.routeTask(
    {
      id: 'reactor-ephemeral',
      title: ctx.promptText,
      type: 'task',
      status: 'open',
      priority: 2,
      labels: [],
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
    ctx.changedFiles ?? []
  );

  const confidence = routeResult.confidence;

  const matchedPatterns = patternRouter.matchPatterns(ctx.promptText);

  // DESIGN.md "guide new": when this is UI/UX work and the project has a
  // DESIGN.md, surface the design-system summary so new UI stays on-token. This
  // can fire independently of routing confidence (it's keyed off file/prompt
  // signals), and is deduped per session via the `design:system` surfaced key.
  const designKey = 'design:system';
  const designInject =
    ctx.cwd && !(ctx.surfaced ?? []).includes(designKey)
      ? maybeDesignInjection(ctx.cwd, ctx.promptText, ctx.changedFiles)
      : null;

  // Implementation-state manifest: machine-derived project identity + exact
  // implementation state (version, branch, latest shipped changes) so every
  // session starts with real knowledge instead of drifted docs. Deduped per
  // session via `state:manifest`.
  const stateKey = 'state:manifest';
  const stateInject =
    ctx.cwd && !(ctx.surfaced ?? []).includes(stateKey)
      ? maybeStateInjection(ctx.cwd)
      : null;

  // Collaboration board: surface recent peer posts (findings/dead-ends/flags/
  // handoffs) so shared knowledge compounds. Fires regardless of routing
  // confidence; deduped per session via the `board:recent` surfaced key.
  const boardKey = 'board:recent';
  const boardInject =
    ctx.cwd && !(ctx.surfaced ?? []).includes(boardKey)
      ? maybeBoardInjection(ctx.cwd)
      : null;

  // Collaboration auto-activation: surface how/when to use the collaboration
  // tooling (board/findings/staged/challenge) when a multi-agent or
  // collaboration-shaped context is detected. Config-gated (collaboration.mode);
  // deduped per session via `collab:active`.
  const collabKey = 'collab:active';
  const collabInject =
    ctx.cwd && !(ctx.surfaced ?? []).includes(collabKey)
      ? maybeCollaborationInjection(ctx.cwd, ctx.promptText)
      : null;

  // Engineering principles: fires ONLY while the rule-1 stance is unresolved
  // for this project + session, asking the user once whether obsolete paths get
  // removed or preserved. Once recorded it goes quiet — the principles
  // themselves reach the model through the deliver prompt and the policy block,
  // so repeating them per turn would be pure context cost. Deduped per session
  // via `principles:stance`.
  const principlesKey = 'principles:stance';
  const principlesInject =
    ctx.cwd && !(ctx.surfaced ?? []).includes(principlesKey)
      ? maybePrinciplesInjection(ctx.cwd, ctx.promptText, ctx.changedFiles, ctx.sessionId)
      : null;

  // Hands-free persistence (Options A-D): when a multi-epic build is in
  // progress (active completion ledger with remaining items), inject a
  // "keep going until the whole build is complete — REMAINING: ..." directive
  // so any model persists like Fable. Deduped per session via `handsfree:persist`.
  const persistKey = 'handsfree:persist';
  const persistInject =
    ctx.cwd && !(ctx.surfaced ?? []).includes(persistKey)
      ? maybePersistenceInjection(ctx.cwd)
      : null;

  // #3-B: delivery routing. Surface up-front (deduped per session via
  // `deliver:routing`) whenever the task routes to a code capability, so the
  // agent calls deliver instead of editing source directly and tripping the gate.
  const deliverKey = 'deliver:routing';
  // #3-C2: only fire when there is a real code signal — a routed code capability
  // at/above the inject threshold, OR an actual source file in changedFiles.
  // Prevents false-positives on low-confidence planning/monitoring prompts.
  const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt)$/i;
  const hasSourceFile = (ctx.changedFiles ?? []).some((f) => SOURCE_FILE_RE.test(f));
  const codeCapMatch =
    (routeResult.matchedCapabilities ?? []).some((c) => CODE_CAPABILITIES.has(c)) &&
    confidence >= injectThreshold;
  const isCodeTask = codeCapMatch || hasSourceFile;
  //
  // The text must match what the gate ACTUALLY does, which is narrower than
  // "all source edits". `delivery_enforcement.py` allows a trivial Edit
  // (under UAP_DELIVER_TRIVIAL_EDIT_CHARS changed characters, default 240 —
  // its own comment calls a full decompose→epics→gates cycle unwarranted for a
  // one-line tweak), and never fires on deleting or renaming a file, or on
  // docs/tests/scripts. It blocks whole-file Writes, larger Edits, and shell
  // writes.
  //
  // Saying "direct Edit/Write is gated and will be blocked" was both false and
  // expensive: it reads as "deliver is the only way to touch code", so work the
  // gate would have allowed gets pushed through a convergence loop anyway. Live
  // 2026-08-09: a three-file DELETION was routed through deliver on this advice
  // — deletion is not gated at all — and the loop, having nothing to write,
  // improvised an unrequested `pgrx` dependency that broke the build. The loop's
  // job is to make gates pass; handed a task with nothing to author, it invents
  // work. Route by whether the change needs convergence, not by whether it
  // touches code.
  const deliverInject =
    isCodeTask && !(ctx.surfaced ?? []).includes(deliverKey)
      ? 'Route SUBSTANTIVE code changes through the `deliver` tool (or ' +
        '`uap deliver "<one-line description>"`): new files, whole-file rewrites, ' +
        'and edits whose outcome you are not already certain of. Deliver writes ' +
        'the files and converges them against the real gates — do not report ' +
        'completion until it reports success.\n\n' +
        'Do NOT route work that needs no convergence. Small surgical edits ' +
        '(roughly under 240 changed characters), deleting or renaming files, and ' +
        'changes to docs, tests, scripts or config are not gated — make them ' +
        'directly and verify with the project\'s own build/test command. Handing ' +
        'deliver a task with nothing to author invites it to invent work.'
      : null;

  // Standalone context blocks (design + board) ride even on low-confidence turns.
  const buildContextBlocks = (): { inject: string; keys: string[] } => {
    const blocks: string[] = [];
    const keys: string[] = [];
    if (stateInject) {
      blocks.push(`## Project state (auto-generated)\n${stateInject}`);
      keys.push(stateKey);
    }
    if (deliverInject) {
      blocks.push(`## Writing code — route through deliver\n${deliverInject}`);
      keys.push(deliverKey);
    }
    if (collabInject) {
      blocks.push(`## Agent collaboration\n${collabInject}`);
      keys.push(collabKey);
    }
    if (persistInject) {
      blocks.push(`## Hands-free build — keep going until 100% complete\n${persistInject}`);
      keys.push(persistKey);
    }
    if (boardInject) {
      blocks.push(`## Collaboration board\n${boardInject}`);
      keys.push(boardKey);
    }
    if (designInject) {
      blocks.push(`## Design system (DESIGN.md)\n${designInject}`);
      keys.push(designKey);
    }
    if (principlesInject) {
      blocks.push(`## Engineering principles — resolve the stance once\n${principlesInject}`);
      keys.push(principlesKey);
    }
    return { inject: blocks.join('\n\n'), keys };
  };

  if (confidence < injectThreshold && (!matchedPatterns || matchedPatterns.length === 0)) {
    // No experts/patterns — but still surface standalone context (board/design).
    const ctxBlocks = buildContextBlocks();
    if (ctxBlocks.inject) {
      result.inject = ctxBlocks.inject;
      result.reason = 'standalone collaboration/design context';
      result.surfacedKeys = ctxBlocks.keys;
      result.confidence = confidence;
    }
    return result;
  }

  const recommendedDroids = routeResult.recommendedDroids ?? [];
  const recommendedSkills = routeResult.recommendedSkills ?? [];

  const surfacedSet = new Set(ctx.surfaced ?? []);

  const items: InjectItem[] = [];

  // Experts/skills are gated by the confidence threshold independently: a
  // matched pattern keeps the result from being silent, but low-confidence
  // experts must NOT ride along on a pattern match.
  if (confidence >= injectThreshold) {
    for (const d of recommendedDroids) {
      const key = `droid:${d}`;
      if (!surfacedSet.has(key)) {
        items.push({ key, name: d, confidence, type: 'droid' });
      }
    }

    for (const sk of recommendedSkills) {
      const key = `skill:${sk}`;
      if (!surfacedSet.has(key)) {
        items.push({ key, name: sk, confidence, type: 'skill' });
      }
    }
  }

  if (matchedPatterns) {
    for (const p of matchedPatterns) {
      const key = `pattern:${p.abbreviation}`;
      if (!surfacedSet.has(key)) {
        items.push({ key, name: p.abbreviation, confidence, type: 'pattern', title: p.title });
      }
    }
  }

  items.sort((a, b) => b.confidence - a.confidence);

  let currentInject = '';
  const finalItems: InjectItem[] = [];
  for (const item of items) {
    const line = item.type === 'pattern'
      ? `  - **${item.name}**: ${item.title || item.name} (confidence: ${item.confidence.toFixed(2)})`
      : `  - **${item.name}** (confidence: ${item.confidence.toFixed(2)})`;
    if (currentInject.length + line.length <= maxInjectChars) {
      currentInject += line + '\n';
      finalItems.push(item);
    }
  }

  const inject = currentInject.trim();

  const actions: ReactorAction[] = [];
  const surfacedKeys: string[] = [];

  for (const item of finalItems) {
    surfacedKeys.push(item.key);
    if (item.type === 'droid') {
      const shouldSpawn = autoSpawnTaskTypes.some((t) => item.name.includes(t));
      if (confidence >= autoSpawnThreshold && shouldSpawn) {
        actions.push({
          kind: 'spawn-expert',
          target: item.name,
          confidence: item.confidence,
          reason: `Auto-spawning expert droid ${item.name} based on confidence ${confidence} >= ${autoSpawnThreshold}`,
        });
      } else {
        actions.push({
          kind: 'suggest-skill',
          target: item.name,
          confidence: item.confidence,
          reason: `Recommended droid ${item.name} for task`,
        });
      }
    } else if (item.type === 'skill') {
      actions.push({
        kind: 'suggest-skill',
        target: item.name,
        confidence: item.confidence,
        reason: `Recommended skill ${item.name} for task`,
      });
    } else if (item.type === 'pattern') {
      actions.push({
        kind: 'enforce',
        target: item.name,
        confidence: item.confidence,
        reason: `Pattern ${item.name} matched`,
      });
    }
  }

  // Prepend standalone context (collaboration board, then DESIGN.md) ahead of
  // the expert/pattern items.
  const ctxBlocks = buildContextBlocks();
  if (ctxBlocks.inject) {
    result.inject = `${ctxBlocks.inject}${inject ? '\n\n' + inject : ''}`;
    surfacedKeys.push(...ctxBlocks.keys);
  } else {
    result.inject = inject;
  }
  result.block = false;
  result.reason =
    `Routing confidence ${confidence.toFixed(2)}` +
    `${matchedPatterns && matchedPatterns.length > 0 ? ', patterns matched' : ''}` +
    `${stateInject ? ', project-state surfaced' : ''}` +
    `${collabInject ? ', collaboration activated' : ''}` +
    `${boardInject ? ', board surfaced' : ''}` +
    `${designInject ? ', design-system surfaced' : ''}`;
  result.actions = actions;
  result.surfacedKeys = surfacedKeys;
  result.confidence = confidence;

  return result;
}
