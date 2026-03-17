# IaC-Parity: Infrastructure as Code Parity

**Category**: Infrastructure
**Abbreviation**: IaC-Parity

## Pattern

All infrastructure changes must have Terraform/Kubernetes YAML equivalent. Manual changes require IaC parity before completion.

## Rule

```
Manual change → Terraform/K8s YAML → Pipeline deployment → 100% match.
```

## Implementation

1. Local testing is ALLOWED for proving solutions
2. IaC parity is MANDATORY before completion
3. All secrets must use GitHub Actions pipelines

## Two-Phase Infrastructure Workflow

```
PHASE 1: LOCAL PROOF (ALLOWED - NO SECRETS)
  - kubectl get/describe/logs (read-only)
  - terraform plan (via pipeline for secrets)
  - Direct cloud console for rapid prototyping

PHASE 2: IaC PARITY (MANDATORY)
  - Translate manual changes to Terraform/K8s YAML
  - Commit IaC to feature branch
  - Run terraform plan via pipeline
  - Deploy via pipeline
  - Delete manual/ephemeral resources
```

## Approved Pipelines

| Task | Pipeline |
|------|----------|
| Kubernetes ops | `ops-approved-operations.yml` |
| Terraform changes | `iac-terraform-cicd.yml` |
| Ephemeral envs | `ops-create-ephemeral.yml` |

## Anti-Pattern

❌ Manual changes without IaC equivalent
❌ Local kubectl apply with secrets
❌ Claiming done before pipeline verification
