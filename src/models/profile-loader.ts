/**
 * Model Profile Loader
 *
 * Loads model profiles from config/model-profiles/*.json at runtime.
 * Previously these profiles were reference-only documentation; now they
 * can be consumed by the ModelRouter for richer configuration.
 *
 * Profiles include pricing, rate limits, server optimization settings,
 * and running configurations that the hardcoded ModelPresets lack.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { z } from 'zod';
import { createLogger } from '../utils/logger.js';

const log = createLogger('profile-loader');

/**
 * Schema for a model profile JSON file.
 * Validates the structure while allowing provider-specific extensions.
 */
export const ModelProfileSchema = z.object({
  _profile: z.string(),
  _description: z.string().optional(),
  model: z.string(),
  provider: z.string().optional(),
  api_base_url: z.string().optional(),
  max_tokens: z.number().default(4096),
  temperature: z.number().default(0.6),
  top_p: z.number().optional(),
  timeout_ms: z.number().default(120000),
  context_window: z.number().default(32768),
  optimize_for_tool_calls: z.boolean().default(true),
  enable_thinking: z.boolean().default(false),
  dynamic_temperature: z
    .object({
      enabled: z.boolean().default(false),
      decay: z.number().optional(),
      floor: z.number().optional(),
    })
    .optional(),
  tool_call_batching: z
    .object({
      enabled: z.boolean().default(true),
      system_prompt_suffix: z.string().optional(),
    })
    .optional(),
  pricing: z
    .object({
      input_per_1m: z.number(),
      output_per_1m: z.number(),
      cache_write_per_1m: z.number().optional(),
      cache_read_per_1m: z.number().optional(),
      currency: z.string().default('USD'),
    })
    .optional(),
  rate_limits: z
    .object({
      requests_per_minute: z.number().optional(),
      tokens_per_minute: z.number().optional(),
    })
    .optional(),
  running_config: z.record(z.unknown()).optional(),
});

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/**
 * Load a single model profile from a JSON file.
 * Returns null if the file doesn't exist or fails validation.
 */
export function loadModelProfile(filePath: string): ModelProfile | null {
  if (!existsSync(filePath)) {
    log.debug(`Profile not found: ${filePath}`);
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const raw = JSON.parse(content);
    const result = ModelProfileSchema.safeParse(raw);

    if (!result.success) {
      log.warn(`Profile validation failed for ${filePath}: ${result.error.message}`);
      return null;
    }

    return result.data;
  } catch (error) {
    log.warn(`Failed to load profile ${filePath}: ${error}`);
    return null;
  }
}

/**
 * Load all model profiles from a directory.
 * Returns a map of profile name to profile data.
 */
export function loadAllModelProfiles(
  profileDir?: string
): Map<string, ModelProfile> {
  const profiles = new Map<string, ModelProfile>();

  // Try multiple locations
  const searchDirs = profileDir
    ? [profileDir]
    : [
        join(process.cwd(), 'config', 'model-profiles'),
        join(process.cwd(), 'config'),
      ];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;

    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

      for (const file of files) {
        const filePath = join(dir, file);
        const profile = loadModelProfile(filePath);
        if (profile) {
          const name = basename(file, '.json');
          profiles.set(name, profile);
          log.debug(`Loaded profile: ${name}`);
        }
      }
    } catch (error) {
      log.debug(`Could not read profile directory ${dir}: ${error}`);
    }
  }

  if (profiles.size > 0) {
    log.info(`Loaded ${profiles.size} model profiles`);
  }

  return profiles;
}

/**
 * Get the active model profile based on UAP_MODEL_PROFILE env var.
 * Falls back to 'generic' if not set.
 */
export function getActiveModelProfile(profileDir?: string): ModelProfile | null {
  const profileName = process.env.UAP_MODEL_PROFILE || 'generic';
  const profiles = loadAllModelProfiles(profileDir);
  return profiles.get(profileName) || null;
}
