# UAP Plugins

This directory contains all UAP (Universal Agent Protocol) plugins, hooks, and utilities.

## Plugin Files

### TypeScript Plugins

- **uap-commands.ts** - Defines UAP-specific commands for opencode integration
- **uap-droids.ts** - Specialized agent droids (code reviewer, security auditor, etc.)
- **uap-skills.ts** - Domain-specific skills (git workflow, testing patterns, etc.)
- **uap-patterns.ts** - Reusable coding patterns distilled from experience

### Shell Hooks

- **session-start.sh** - Runs at session initialization to enforce UAP compliance
- **pre-compact.sh** - Runs before context compression to preserve critical information

## Usage

### Install Plugins

To install all UAP plugins for opencode:

```bash
uap install opencode
```

This will copy all plugin files to `~/.opencode/plugin/`.

### Available Droids

- **code-reviewer** - Reviews code changes for quality and security
- **security-auditor** - Audits code for security vulnerabilities
- **performance-optimizer** - Analyzes and optimizes performance bottlenecks
- **unit-tester** - Generates comprehensive unit tests
- **debug-helper** - Helps diagnose and fix bugs

### Available Skills

- **git-workflow** - Manages git workflows with worktrees and branches
- **testing-patterns** - Applies testing best practices and patterns
- **ci-cd-setup** - Configures continuous integration and deployment pipelines
- **documentation-gen** - Generates and maintains project documentation

### Available Patterns

- **generic-uap-patterns** - Distilled patterns from tbench-specific implementation
- **worktree-isolation** - Use git worktrees for isolated feature development
- **session-persistence** - Maintain state across sessions using memory system
- **task-tracking** - Track and manage tasks with UAP task system
- **agent-coordination** - Coordinate multiple AI agents for complex tasks

## Plugin Manifest

Each plugin is registered in the `index.ts` file which exports:

- Version information
- Plugin manifest with hooks, droids, skills, and patterns
- Individual plugin modules

## Creating New Plugins

To add a new plugin:

1. Create a new TypeScript file in this directory
2. Export definitions using the appropriate interfaces
3. Add to the `index.ts` exports
4. Register in the `uapPluginManifest`

Example:

```typescript
export interface MyPlugin {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export const myPlugin: MyPlugin = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'Description of my plugin',
  enabled: true,
};
```

## License

Part of Universal Agent Protocol v0.10.3
