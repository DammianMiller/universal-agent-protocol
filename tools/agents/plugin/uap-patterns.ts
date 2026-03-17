#!/usr/bin/env node
/**
 * UAP Patterns Plugin for opencode
 *
 * Provides reusable coding patterns and distilled knowledge from tbench.
 */

export interface UpatternDefinition {
  id: string;
  name: string;
  description: string;
  category: 'memory' | 'workflow' | 'architecture' | 'testing';
  tags: string[];
}

export const uapPatterns: UpatternDefinition[] = [
  {
    id: 'generic-uap-patterns',
    name: 'Generic UAP Patterns',
    description: 'Distilled patterns from tbench-specific implementation',
    category: 'workflow',
    tags: ['memory', 'hooks', 'patterns'],
  },
  {
    id: 'worktree-isolation',
    name: 'Worktree Isolation Pattern',
    description: 'Use git worktrees for isolated feature development',
    category: 'workflow',
    tags: ['git', 'isolation', 'parallel'],
  },
  {
    id: 'session-persistence',
    name: 'Session Persistence Pattern',
    description: 'Maintain state across sessions using memory system',
    category: 'memory',
    tags: ['state', 'persistence', 'context'],
  },
  {
    id: 'task-tracking',
    name: 'Task Tracking Pattern',
    description: 'Track and manage tasks with UAP task system',
    category: 'workflow',
    tags: ['tasks', 'tracking', 'management'],
  },
  {
    id: 'agent-coordination',
    name: 'Agent Coordination Pattern',
    description: 'Coordinate multiple AI agents for complex tasks',
    category: 'architecture',
    tags: ['agents', 'coordination', 'parallel'],
  },
];

export default uapPatterns;
