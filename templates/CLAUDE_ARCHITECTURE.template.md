# Architecture Guide Template

**Version**: {{VERSION}}
**Branch**: {{DEFAULT_BRANCH}}
**Last Updated**: {{STRUCTURE_DATE}}

---

## Cluster Topology

{{#if HAS_MULTI_CLUSTER}}
This project operates multiple dedicated clusters - **one concern per cluster**.

| Cluster | Context | Purpose | Services |
|---------|---------|---------|----------|
{{#each CLUSTERS}}
| **{{name}}** | `{{context}}` | {{purpose}} | {{services}} |
{{/each}}
{{else}}
Single cluster deployment.

### Cluster Commands

```bash
kubectl config use-context {{MAIN_CLUSTER_CONTEXT}}
```
{{/if}}

---

## Cross-Cluster Communication Rules

{{#if HAS_MULTI_CLUSTER}}
**CRITICAL**: Always use public HTTPS URLs for cross-cluster communication.

### Do's and Don'ts

| ✅ DO | ❌ DON'T |
|-------|----------|
| Use public HTTPS URLs | Use cluster-internal DNS across clusters |
| Use service accounts for auth | Use internal IPs for cross-cluster |

### Whitelisted URLs
{{#each WHITELISTED_URLS}}
- `{{this}}`
{{/each}}
{{/if}}

---

## Technology Stack

| Layer | Technology | Version |
|-------|------------|---------|
{{#each TECH_STACK}}
| **{{layer}}** | {{technology}} | {{version}} |
{{/each}}

---

## High Availability

| Component | Configuration |
|-----------|---------------|
{{#each HA_CONFIG}}
| **{{component}}** | {{configuration}} |
{{/each}}

---

## Infrastructure as Code Policy

### Two-Phase Infrastructure Workflow

```
PHASE 1: LOCAL PROOF (ALLOWED - NO SECRETS)
  - Read-only operations
  - terraform plan (via pipeline for secrets)

PHASE 2: IaC PARITY (MANDATORY - VIA PIPELINE)
  - Translate manual changes to Terraform/K8s YAML
  - Deploy via pipeline
  - Delete manual/ephemeral resources
```

### Secrets

**ALL secrets are stored in GitHub Actions secrets.** Operations requiring secrets MUST use pipelines.

---

## Service URLs

{{#each SERVICE_URLS}}
| {{name}} | {{url}} |
{{/each}}

---

## See Also

- `docs/ARCHITECTURE-OVERVIEW.md` - Detailed architecture
- `.factory/compliance_rules.yaml` - Architecture constraints (if applicable)
