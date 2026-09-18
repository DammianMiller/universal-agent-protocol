/**
 * Classifier entry point: backend selection + threshold application.
 *
 * Backend chain (first available wins):
 *   1. trained head at ~/.config/uap/classifier-head.json (future; §6 v2)
 *   2. baseline-tfidf-v1 (always available, airgap-pure)
 * Thresholds come from reviewed policy config (config/classify-thresholds.json
 * in the project, or ~/.config/uap/), never from model output.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BaselineBackend } from './baseline.js';
import {
  AssessResult,
  ClassifierBackend,
  ClassifyError,
  DEFAULT_THRESHOLDS,
  Question,
  QuestionThresholds,
  ThresholdConfig,
} from './types.js';

export * from './types.js';
export { BaselineBackend } from './baseline.js';
export { recordShadow, shadowLogPath, type ShadowRecord } from './shadow.js';

export function defaultBackend(): ClassifierBackend {
  // v1: the trained-head slot exists in the chain but no head format is
  // committed yet — landing small, one dimension end-to-end. When a head
  // ships it inserts here without touching consumers.
  return new BaselineBackend();
}

export function thresholdPaths(projectDir: string): string[] {
  return [
    join(projectDir, 'config', 'classify-thresholds.json'),
    join(homedir(), '.config', 'uap', 'classify-thresholds.json'),
  ];
}

export function loadThresholds(
  projectDir: string,
  explicitPath?: string,
): Record<string, QuestionThresholds> {
  const candidates = explicitPath ? [explicitPath] : thresholdPaths(projectDir);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let cfg: ThresholdConfig;
    try {
      cfg = JSON.parse(readFileSync(p, 'utf-8')) as ThresholdConfig;
    } catch (err) {
      throw new ClassifyError(`threshold config at ${p} is not valid JSON: ${(err as Error).message}`);
    }
    if (cfg.version !== 1 || typeof cfg.questions !== 'object' || cfg.questions === null) {
      throw new ClassifyError(`threshold config at ${p}: expected {version: 1, questions: {...}}`);
    }
    for (const [name, t] of Object.entries(cfg.questions)) {
      const tauOk = t.tau === undefined || (Number.isFinite(t.tau) && t.tau >= 0 && t.tau <= 1);
      const floorOk = Number.isFinite(t.confidenceFloor) && t.confidenceFloor >= 0 && t.confidenceFloor <= 1;
      if (!tauOk || !floorOk) {
        throw new ClassifyError(
          `threshold config at ${p}: questions.${name} needs confidenceFloor (and optional tau) in [0,1]`,
        );
      }
    }
    return cfg.questions;
  }
  if (explicitPath) {
    throw new ClassifyError(`threshold config not found: ${explicitPath}`);
  }
  return {};
}

export interface DecidedAssessment {
  name: string;
  value: AssessResult[string]['value'];
  probability: number;
  confidence: number;
  /** True when confidence < floor: the caller must defer to its heuristic. */
  defer: boolean;
  backend: string;
}

/** Assess + apply reviewed thresholds. The returned `defer` flag is the
 * shadow-mode contract: below the confidence floor, the classifier advises
 * but the heuristic decides. */
export function assessWithThresholds(
  state: string,
  questions: Question[],
  thresholds: Record<string, QuestionThresholds>,
  backend: ClassifierBackend = defaultBackend(),
): DecidedAssessment[] {
  const result = backend.assess(state, questions);
  return questions.map((q) => {
    const a = result[q.name];
    if (!a) {
      throw new ClassifyError(`backend "${backend.name}" returned no assessment for "${q.name}"`);
    }
    const t = thresholds[q.name] ?? DEFAULT_THRESHOLDS;
    let value = a.value;
    if (q.kind === 'noul') {
      value = a.probability >= (t.tau ?? DEFAULT_THRESHOLDS.tau!);
    }
    return {
      name: q.name,
      value,
      probability: a.probability,
      confidence: a.confidence,
      defer: a.confidence < t.confidenceFloor,
      backend: a.backend,
    };
  });
}
