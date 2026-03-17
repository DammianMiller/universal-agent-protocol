#!/usr/bin/env node
/**
 * UAP Plugin Index
 *
 * This file serves as the main entry point for all UAP plugins.
 * It exports all available plugins, hooks, and utilities.
 */

import { uapCommands } from './uap-commands.js';
import { uapDroids } from './uap-droids.js';
import { uapSkills } from './uap-skills.js';
import { uapPatterns } from './uap-patterns.js';

export const UAP_VERSION = '7.0.2';

export interface UAPPluginManifest {
  name: string;
  version: string;
  description: string;
  hooks?: string[];
  droids?: string[];
  skills?: string[];
  patterns?: string[];
}

export const uapPluginManifest: UAPPluginManifest = {
  name: 'universal-agent-protocol',
  version: UAP_VERSION,
  description: 'Universal Agent Protocol - AI agents that learn and remember across sessions',
  hooks: ['session-start.sh', 'pre-compact.sh'],
  droids: uapDroids.map((d) => d.id),
  skills: uapSkills.map((s) => s.id),
  patterns: uapPatterns.map((p) => p.id),
};

export { uapCommands, uapDroids, uapSkills, uapPatterns };

// Default export for easy importing
export default {
  version: UAP_VERSION,
  manifest: uapPluginManifest,
  commands: uapCommands,
  droids: uapDroids,
  skills: uapSkills,
  patterns: uapPatterns,
};
