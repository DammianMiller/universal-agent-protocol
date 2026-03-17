# Infrastructure Definition of Done

Infrastructure work is NOT DONE until the IaC pipeline applies without error AND kubectl verification confirms the fix works. kubectl-only fixes are incomplete.

## Rules

1. **Pipeline apply is required.** A fix is NOT DONE until the Terraform CI/CD pipeline has run `apply` without error. Writing `.tf` files and committing them is necessary but not sufficient. The pipeline must successfully apply the changes.

2. **kubectl verification is required.** After the pipeline applies, use `kubectl` to verify the fix works in the cluster. Check pod status, service endpoints, logs, and any other relevant indicators.

3. **Both conditions must be met.** The definition of done for any infrastructure task requires BOTH:
   - IaC pipeline `apply` succeeds without error (IaC is the source of truth)
   - `kubectl` verification confirms the fix is working in the cluster
   - kubectl verification alone is insufficient — IaC must be applied first

4. **Document the verification.** When closing a task or PR, include evidence of both pipeline success and kubectl verification (e.g. pipeline run URL, kubectl output showing the fix).

5. **Workflow sequence.** The complete workflow is: edit `.tf` files -> commit -> PR -> pipeline plans -> review -> merge -> pipeline applies -> kubectl verify -> task done.

## Enforcement Level

[REQUIRED]

## Related Tools

- terraform: Infrastructure as Code (pipeline-only)
- kubectl: Cluster verification
- github-actions: CI/CD pipeline execution
