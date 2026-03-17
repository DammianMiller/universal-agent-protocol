# IaC Pipeline Enforcement

ALL Terraform operations (plan, apply, destroy) MUST go through the CI/CD pipeline. NEVER run Terraform locally. The pipeline has secrets, state backend, security scanning, and SOC2 audit logging that local execution cannot replicate.

## Rules

1. **Never run Terraform locally.** `terraform plan`, `terraform apply`, and `terraform destroy` are FORBIDDEN on local machines and agent sessions. All Terraform operations must go through the designated CI/CD pipeline (e.g. `iac-terraform-cicd.yml` in GitHub Actions).
   - The pipeline has secrets, state backend credentials, security scanning (Checkov, tfsec, Terrascan), cost analysis, and SOC2 audit logging
   - Local execution skips all of these controls and risks state corruption, secret exposure, or unaudited changes
   - `terraform fmt`, `terraform validate`, and `terraform init -backend=false` are permitted locally for syntax checking only

2. **Pipeline is the only apply path.** The workflow for infrastructure changes is: edit `.tf` files -> commit -> PR -> pipeline plans -> review -> merge -> pipeline applies -> kubectl verify. No shortcuts.

3. **Secrets never leave the pipeline.** Infrastructure secrets (cloud tokens, database passwords, API keys) exist only in the CI/CD secret store. Never attempt to replicate them locally or pass them as environment variables in agent sessions.

## Enforcement Level

[REQUIRED]

## Related Tools

- terraform: Infrastructure provisioning (pipeline-only)
- github-actions: CI/CD pipeline execution
- checkov: IaC security scanning
- tfsec: Terraform security scanning
