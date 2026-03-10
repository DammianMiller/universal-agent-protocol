<!--
  PROJECT.md Template - Project-Specific Configuration
  
  This file contains ALL project-specific content that gets merged into CLAUDE.md.
  By separating project content from the universal template:
  
  1. Template upgrades are SEAMLESS - just update CLAUDE.template.md
  2. No merge conflicts - project content stays in PROJECT.md
  3. Project knowledge persists across template versions
  4. Easy to review what's project-specific vs universal
  
  Usage:
  - CLAUDE.md imports this file via {{> PROJECT}}
  - Generator reads PROJECT.md and injects into template
  - Only edit this file for project-specific content
-->

# {{PROJECT_NAME}} - Project Configuration

## Project Overview

{{#if DESCRIPTION}}
> {{DESCRIPTION}}
{{/if}}

**Repository**: `{{PROJECT_NAME}}`
**Default Branch**: `{{DEFAULT_BRANCH}}`
**Last Updated**: {{STRUCTURE_DATE}}

---

## Repository Structure

```
{{PROJECT_NAME}}/
{{{REPOSITORY_STRUCTURE}}}
```

---

{{#if ARCHITECTURE_OVERVIEW}}
## Architecture

{{{ARCHITECTURE_OVERVIEW}}}

{{/if}}
{{#if CORE_COMPONENTS}}
## Core Components

{{{CORE_COMPONENTS}}}

{{/if}}
{{#if DATABASE_ARCHITECTURE}}
## Database Architecture

{{{DATABASE_ARCHITECTURE}}}

{{/if}}
{{#if AUTH_FLOW}}
## Authentication Flow

{{{AUTH_FLOW}}}

{{/if}}
---

## Quick Reference

{{#if CLUSTER_CONTEXTS}}
### Clusters
```bash
{{{CLUSTER_CONTEXTS}}}
```

{{/if}}
{{#if PROJECT_URLS}}
### URLs
{{{PROJECT_URLS}}}

{{/if}}
{{#if KEY_WORKFLOWS}}
### Workflows
```
{{{KEY_WORKFLOWS}}}
```

{{/if}}
{{#if ESSENTIAL_COMMANDS}}
### Commands
```bash
{{{ESSENTIAL_COMMANDS}}}
```

{{/if}}
---

{{#if LANGUAGE_DROIDS}}
## Language Droids
| Droid | Purpose |
|-------|---------|
{{{LANGUAGE_DROIDS}}}

{{/if}}
{{#if DISCOVERED_SKILLS}}
## Available Skills
| Skill | Purpose |
|-------|---------|
{{{DISCOVERED_SKILLS}}}

{{/if}}
{{#if MCP_PLUGINS}}
## MCP Plugins
| Plugin | Purpose |
|--------|---------|
{{{MCP_PLUGINS}}}

{{/if}}
---

{{#if HAS_INFRA}}
## Infrastructure

{{#if HAS_PIPELINE_POLICY}}
**ALL infrastructure changes go through CI/CD pipelines. No exceptions.**

### Approved Operations
```bash
gh workflow run ops-approved-operations.yml \
  -f operation=restart \
  -f target=deployment/my-service \
  -f namespace=production
```

### PROHIBITED Commands
```bash
# ❌ NEVER run locally
terraform apply
terraform destroy
kubectl apply -f ...
kubectl delete ...
```
{{else}}
{{{INFRA_WORKFLOW}}}
{{/if}}

{{/if}}
---

## Testing

1. Create worktree: `{{WORKTREE_CREATE_CMD}} <slug>`
2. Update/create tests
3. Run tests: `{{TEST_COMMAND}}`
4. Run lint: `{{LINT_COMMAND}}`
5. Create PR: `{{WORKTREE_PR_CMD}} <id>`

---

## Config Files
| File | Purpose |
|------|---------|
{{#if KEY_CONFIG_FILES}}
{{{KEY_CONFIG_FILES}}}
{{else}}
| `README.md` | Project documentation |
| `.uap.json` | UAP agent memory configuration |
| `package.json` | Node.js project configuration |
{{/if}}

{{#if HAS_PIPELINE_POLICY}}
### Policy Documents
| Document | Purpose |
|----------|---------|
| `docs/adr/ADR-0006-pipeline-only-infrastructure-changes.md` | Pipeline-only policy |

{{/if}}
---

{{#if TROUBLESHOOTING}}
## Troubleshooting
{{{TROUBLESHOOTING}}}

{{/if}}
{{#if PREPOPULATED_KNOWLEDGE}}
## Project Knowledge

{{{PREPOPULATED_KNOWLEDGE}}}
{{/if}}

---

## Completion Checklist

```
☐ Tests pass ({{TEST_COMMAND}})
☐ Lint/typecheck pass ({{LINT_COMMAND}})
☐ Worktree used (not {{DEFAULT_BRANCH}})
☐ Memory updated
☐ PR created
☐ Parallel reviews passed
{{#if HAS_INFRA}}
☐ Terraform plan verified
{{/if}}
{{#if HAS_PIPELINE_POLICY}}
☐ No manual kubectl commands (use pipelines)
☐ No local terraform apply (use pipelines)
{{/if}}
☐ No secrets in code
```
