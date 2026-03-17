#!/usr/bin/env node
/**
 * UAP Commands Plugin for opencode
 *
 * Defines UAP-specific commands that can be used within opencode.
 */

export const uapCommands = {
  name: 'uap',
  description: 'Universal Agent Protocol commands',
  commands: [
    {
      name: 'init',
      description: 'Initialize UAP in current project',
      usage: 'uap init',
    },
    {
      name: 'setup',
      description: 'Run comprehensive UAP setup',
      usage: 'uap setup [-p all | memory | hooks | mcp-router]',
    },
    {
      name: 'install',
      description: 'Install UAP plugins for a harness',
      usage: 'uap install <harness>',
    },
    {
      name: 'task',
      description: 'Create and manage tasks',
      usage: 'uap task create --type <task|bug|feature> --title "<description>"',
    },
    {
      name: 'worktree',
      description: 'Manage git worktrees for isolated development',
      usage: 'uap worktree <command>',
    },
    {
      name: 'memory',
      description: 'Query and manage memory system',
      usage: 'uap memory query "<query>"',
    },
  ],
};

export default uapCommands;
