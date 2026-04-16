# iac-parity

**Category**: infrastructure
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: terraform, helm, iac, drift, reproducibility

## Rule

Any live-state change MUST be paired with an IaC change in the same worktree:

- `kubectl patch|apply|edit|create|delete` → must also modify `infra/terraform/**`, `infra/helm_charts/**`, or `infra/kubernetes/**`
- Helm `--set` overrides → must also update `values.yaml`
- DigitalOcean / cloud console changes are forbidden; use Terraform

## Why

User's global rule: "always apply state changes to IaC to ensure reproducibility." The repo has ~30 `IAC_PARITY_*`/`DRIFT_ANALYSIS_*` retrospectives — each a drift incident. Catching at author-time eliminates the loop.

## Enforcement

Python enforcer `iac_parity.py` verifies the worktree has staged/unstaged diffs under the IaC paths when a mutating cluster command is issued.

```rules
- title: "Live state changes require IaC diff"
  keywords: [kubectl, helm, doctl, terraform, aws, gcloud, apply, patch, create, delete, edit]
  antiPatterns: [--force, --no-iac, manual-console]
- title: "No ad-hoc cloud console changes"
  keywords: [doctl, aws, gcloud, console]
  antiPatterns: [click-ops, manual-edit]
```
