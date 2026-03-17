/**
 * Hierarchical Prompting System for UAP
 *
 * Based on Droid's #1 Terminal-Bench strategy:
 * 1. Tool Descriptions: High-level capabilities
 * 2. System Prompts: Behavioral guidelines
 * 3. System Notifications: Time-sensitive context (at END for recency bias)
 */

import { type TaskClassification } from '../memory/task-classifier.js';

export interface HierarchicalPrompt {
  toolDescriptions: string;
  systemPrompt: string;
  taskPrompt: string;
  memoryContext: string;
  systemNotification: string;
}

/**
 * Build a hierarchical prompt optimized for agentic models
 */
export function buildHierarchicalPrompt(
  taskInstruction: string,
  classification: TaskClassification,
  memoryContext: string,
  options: {
    timeRemaining?: number;
    attemptNumber?: number;
    previousErrors?: string[];
  } = {}
): string {
  const sections: string[] = [];

  // Layer 1: Tool Descriptions (high-level capabilities)
  sections.push(getToolDescriptions(classification));

  // Layer 2: System Prompt (behavioral guidelines)
  sections.push(getSystemPrompt(classification));

  // Layer 3: Memory Context (relevant knowledge)
  if (memoryContext) {
    sections.push(`## Memory Context\n\n${memoryContext}`);
  }

  // Layer 4: Task Prompt
  sections.push(`## Task\n\n${taskInstruction}`);

  // Layer 5: System Notification (at END for recency bias - CRITICAL)
  sections.push(getSystemNotification(classification, options));

  return sections.join('\n\n');
}

/**
 * Get tool descriptions for the task category
 */
function getToolDescriptions(classification: TaskClassification): string {
  const baseTools = `## Available Capabilities

You have access to these capabilities:
- **File Operations**: Read, write, create, and modify files
- **Shell Execution**: Run commands in bash/shell
- **Code Generation**: Write code in multiple languages
- **Analysis**: Understand and analyze code, logs, and data`;

  const categoryTools: Record<string, string> = {
    sysadmin: `
- **System Administration**: Configure services, manage processes, networking
- **Package Management**: Install/update packages via apt, yum, pip, npm
- **Service Control**: systemctl, journalctl for service management`,

    security: `
- **Security Analysis**: Identify vulnerabilities, audit code
- **Cryptography**: Hash, encrypt, decrypt, certificate management
- **Secret Management**: Handle credentials securely`,

    'ml-training': `
- **ML Frameworks**: PyTorch, TensorFlow, scikit-learn, transformers
- **Data Processing**: pandas, numpy, dataset handling
- **GPU Operations**: CUDA, model training, inference`,

    debugging: `
- **Debugging Tools**: Stack traces, logging, profiling
- **Version Management**: git, conda, pip, dependency resolution
- **Error Analysis**: Identify root causes, propose fixes`,

    coding: `
- **Code Quality**: Linting, formatting, type checking
- **Design Patterns**: Implement standard patterns correctly
- **Testing**: Write and run tests, verify behavior`,

    testing: `
- **Test Frameworks**: vitest, jest, pytest, mocha
- **Coverage Analysis**: Measure and improve test coverage
- **Mocking**: Create mocks, stubs, spies for isolation`,
  };

  return baseTools + (categoryTools[classification.category] || '');
}

/**
 * Get system prompt with behavioral guidelines
 */
function getSystemPrompt(classification: TaskClassification): string {
  const basePrompt = `## Guidelines

### Core Principles
1. **State assumptions explicitly** before writing code
2. **Handle edge cases** - empty inputs, null values, errors
3. **Verify your solution** works before reporting success
4. **Follow existing patterns** in the codebase`;

  const categoryGuidelines: Record<string, string> = {
    sysadmin: `
### System Administration Guidelines
- Use modern commands: \`ip\` over \`ifconfig\`, \`ss\` over \`netstat\`
- Check service status with \`systemctl status\` before changes
- Backup configs before modifying: \`cp file file.bak\`
- Use \`journalctl -u service\` for service logs
- Parallel builds: \`make -j$(nproc)\``,

    security: `
### Security Guidelines
- NEVER log sensitive data (passwords, tokens, keys)
- Use parameterized queries, never string concatenation
- Validate ALL user input before processing
- Research CVE details before attempting exploits
- Use secure defaults (HTTPS, strong hashing)`,

    'ml-training': `
### ML Training Guidelines
- Start with smaller models for faster iteration
- Cache datasets to avoid repeated downloads
- Use \`CUDA_VISIBLE_DEVICES\` for GPU selection
- Monitor memory usage during training
- Save checkpoints periodically`,

    debugging: `
### Debugging Guidelines
- Reproduce the error before attempting fixes
- Check logs and stack traces carefully
- Use \`pip check\` / \`conda list\` for dependency issues
- Use \`git reflog\` to recover lost work
- Add verbose flags (-v, --debug) for more info`,

    coding: `
### Coding Guidelines
- Follow existing code style and patterns
- Write self-documenting code with clear names
- Include JSDoc/docstrings for public APIs
- Handle errors explicitly with try/catch
- Export types alongside implementations`,

    testing: `
### Testing Guidelines
- Test edge cases: empty, null, undefined
- Use mocks for external dependencies
- One assertion per test when possible
- Name tests descriptively: "should X when Y"
- Run tests before committing`,
  };

  return basePrompt + (categoryGuidelines[classification.category] || '');
}

/**
 * Get system notification (time-sensitive, at END for recency bias)
 */
function getSystemNotification(
  classification: TaskClassification,
  options: {
    timeRemaining?: number;
    attemptNumber?: number;
    previousErrors?: string[];
  }
): string {
  const notifications: string[] = ['## ⚠️ CRITICAL REMINDERS'];

  // Time warning if relevant
  if (options.timeRemaining !== undefined && options.timeRemaining < 60000) {
    notifications.push(
      `\n**TIME WARNING**: Only ${Math.round(options.timeRemaining / 1000)}s remaining!`
    );
    notifications.push('- Focus on completing the core requirement');
    notifications.push('- Skip optional optimizations');
  }

  // Attempt warning
  if (options.attemptNumber && options.attemptNumber > 1) {
    notifications.push(`\n**ATTEMPT ${options.attemptNumber}**: Previous attempts failed.`);

    if (options.previousErrors && options.previousErrors.length > 0) {
      notifications.push('\n**Previous errors to fix:**');
      for (const error of options.previousErrors.slice(0, 3)) {
        notifications.push(`- ${error}`);
      }
    }
  }

  // Category-specific critical reminders
  const categoryReminders: Record<string, string[]> = {
    sysadmin: ['Verify service is running after changes', 'Check firewall rules if network issues'],
    security: ['Never expose secrets in output or logs', 'Sanitize all external input'],
    'ml-training': ['Check GPU memory before large models', 'Verify dataset paths exist'],
    debugging: ['Identify root cause, not just symptoms', 'Test fix actually resolves the issue'],
    coding: ['Return ONLY the code requested', 'Include all necessary imports'],
    testing: ['Ensure tests actually run assertions', 'Mock external dependencies'],
  };

  const reminders = categoryReminders[classification.category] || [];
  if (reminders.length > 0) {
    notifications.push('\n**Final checks:**');
    for (const reminder of reminders) {
      notifications.push(`- ${reminder}`);
    }
  }

  // Universal final reminder
  notifications.push('\n**Before submitting:**');
  notifications.push('- Verify solution compiles/runs');
  notifications.push('- Check all requirements are met');
  notifications.push('- Handle edge cases explicitly');

  return notifications.join('\n');
}

/**
 * Build environment bootstrap prompt (gather system info)
 */
export function buildEnvironmentBootstrap(): string {
  return `## Environment Discovery

Run these commands to understand the environment:

\`\`\`bash
# System info
echo "=== SYSTEM ===" && uname -a
echo "=== OS ===" && cat /etc/os-release 2>/dev/null | head -5

# Available tools
echo "=== TOOLS ===" && which python python3 pip pip3 npm node go cargo 2>/dev/null

# Resources
echo "=== DISK ===" && df -h / 2>/dev/null
echo "=== MEM ===" && free -h 2>/dev/null

# Current context
echo "=== CWD ===" && pwd && ls -la
echo "=== GIT ===" && git status 2>/dev/null | head -5
\`\`\`

Use this information to:
1. Choose appropriate tools (use what's available)
2. Check resource constraints
3. Understand the current state
`;
}

/**
 * Build planning prompt
 */
export function buildPlanningPrompt(_task: string, steps: string[]): string {
  const plan = steps
    .map((step, i) => {
      const status = i === 0 ? '[>]' : '[ ]';
      return `${status} ${i + 1}. ${step}`;
    })
    .join('\n');

  return `## Execution Plan

${plan}

**Instructions:**
- Complete steps in order
- Mark each step done after completion
- If a step fails, debug before continuing
- Update plan if new steps are discovered
`;
}

/**
 * Update planning prompt with progress
 */
export function updatePlanningPrompt(
  steps: string[],
  completedSteps: number,
  currentStepInProgress: boolean
): string {
  const plan = steps
    .map((step, i) => {
      let status: string;
      if (i < completedSteps) {
        status = '[x]';
      } else if (i === completedSteps && currentStepInProgress) {
        status = '[>]';
      } else {
        status = '[ ]';
      }
      return `${status} ${i + 1}. ${step}`;
    })
    .join('\n');

  return `## Progress Update

${plan}

**Status:** ${completedSteps}/${steps.length} steps completed
`;
}
