/**
 * Bundled starter/reference tuning profiles, keyed by model family. Shipped as
 * typed constants (not loose JSON) so they are guaranteed present at runtime in
 * `dist/` regardless of asset-copy steps.
 */

import type { FlagConfig } from '../flags.js';
import { QWEN36_PROFILE } from './qwen36.js';
import { OPUS48_PROFILE } from './opus48.js';

export { QWEN36_PROFILE } from './qwen36.js';
export { OPUS48_PROFILE } from './opus48.js';

/** model-family key → bundled config. Keys are matched via normalizeModel. */
export const BUNDLED_PROFILES: Record<string, FlagConfig> = {
  'qwen36-a3b': QWEN36_PROFILE,
  'opus-4.8': OPUS48_PROFILE,
};
