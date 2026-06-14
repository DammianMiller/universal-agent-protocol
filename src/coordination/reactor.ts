import { CapabilityRouter, getCapabilityRouter } from './capability-router.js';
import { PatternRouter, getPatternRouter } from './pattern-router.js';

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

  if (confidence < injectThreshold && (!matchedPatterns || matchedPatterns.length === 0)) {
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

  result.inject = inject;
  result.block = false;
  result.reason = `Routing confidence ${confidence.toFixed(2)}${matchedPatterns && matchedPatterns.length > 0 ? ', patterns matched' : ''}`;
  result.actions = actions;
  result.surfacedKeys = surfacedKeys;
  result.confidence = confidence;

  return result;
}
