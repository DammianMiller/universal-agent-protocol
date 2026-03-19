#!/usr/bin/env node
/**
 * Thin wrapper for `uap-policy` standalone entry point.
 * All command implementations are in src/cli/policy.ts (registerPolicyCommands).
 */
import { Command } from 'commander';
import { registerPolicyCommands } from '../cli/policy.js';

const program = new Command();
program.name('uap-policy').description('UAP policy management');
registerPolicyCommands(program);
// registerPolicyCommands creates a 'policy' subcommand, but for standalone use
// we want the commands at the top level. Re-parse with the 'policy' prefix injected.
const args = process.argv.slice(0, 2).concat(['policy'], process.argv.slice(2));
program.parse(args);
