#!/usr/bin/env node
/**
 * UAP Skills Plugin for opencode
 *
 * Defines domain-specific skills that agents can use.
 */

export interface USkillDefinition {
  id: string;
  name: string;
  description: string;
  category: 'development' | 'testing' | 'deployment' | 'documentation';
  triggers: string[];
  enabled: boolean;
}

export const uapSkills: USkillDefinition[] = [
  {
    id: 'git-workflow',
    name: 'Git Workflow',
    description: 'Manages git workflows with worktrees and branches',
    category: 'development',
    triggers: ['git', 'branch', 'commit', 'push'],
    enabled: true,
  },
  {
    id: 'testing-patterns',
    name: 'Testing Patterns',
    description: 'Applies testing best practices and patterns',
    category: 'testing',
    triggers: ['test', 'spec', 'coverage'],
    enabled: true,
  },
  {
    id: 'ci-cd-setup',
    name: 'CI/CD Setup',
    description: 'Configures continuous integration and deployment pipelines',
    category: 'deployment',
    triggers: ['ci', 'cd', 'pipeline', 'workflow'],
    enabled: false,
  },
  {
    id: 'documentation-gen',
    name: 'Documentation Generator',
    description: 'Generates and maintains project documentation',
    category: 'documentation',
    triggers: ['doc', 'readme', 'comment'],
    enabled: true,
  },
];

export default uapSkills;
