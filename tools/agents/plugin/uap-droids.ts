#!/usr/bin/env node
/**
 * UAP Droids Plugin for opencode
 *
 * Defines specialized agent droids that can be invoked via UAP.
 */

export interface UDroidDefinition {
  id: string;
  name: string;
  description: string;
  category: 'code' | 'review' | 'debug' | 'test' | 'deploy';
  enabled: boolean;
}

export const uapDroids: UDroidDefinition[] = [
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    description: 'Reviews code changes for quality and security',
    category: 'review',
    enabled: true,
  },
  {
    id: 'security-auditor',
    name: 'Security Auditor',
    description: 'Audits code for security vulnerabilities',
    category: 'review',
    enabled: true,
  },
  {
    id: 'performance-optimizer',
    name: 'Performance Optimizer',
    description: 'Analyzes and optimizes performance bottlenecks',
    category: 'code',
    enabled: true,
  },
  {
    id: 'unit-tester',
    name: 'Unit Tester',
    description: 'Generates comprehensive unit tests',
    category: 'test',
    enabled: true,
  },
  {
    id: 'debug-helper',
    name: 'Debug Helper',
    description: 'Helps diagnose and fix bugs',
    category: 'debug',
    enabled: true,
  },
];

export default uapDroids;
