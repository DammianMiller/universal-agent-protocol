# kubectl Verify and Backport

Agents MAY use kubectl to diagnose issues, test fixes, and verify results directly on clusters. ANY resource created or modified via kubectl MUST be backported to Infrastructure as Code.

## Rules

1. **kubectl for diagnosis and verification.** Agents are encouraged to use `kubectl` directly against clusters for fast feedback: checking pod logs, service endpoints, cache connectivity, applying quick patches to prove a theory, and verifying that IaC-applied changes work correctly.
   - `kubectl get`, `kubectl logs`, `kubectl describe`, `kubectl exec` are always permitted
   - `kubectl apply`, `kubectl create`, `kubectl patch` are permitted for testing but trigger the backport requirement

2. **Mandatory backport to IaC.** ANY resource created or modified via `kubectl` MUST be backported to Terraform `.tf` files (or equivalent IaC). Two options:
   - (a) `terraform import` the kubectl-created resource into Terraform state
   - (b) Delete the kubectl-created resource and recreate it via Terraform (preferred)
   - Option (b) is preferred unless the resource contains data that cannot be recreated

3. **100% IaC parity required.** No unmanaged resources may exist in any cluster except those in the documented IaC Exceptions list (operator-managed secrets, ephemeral CI resources, system resources). Every permanent resource must have a corresponding IaC definition.

4. **Audit trail.** When using kubectl to create or modify resources, document what was done and why in the commit message when backporting to IaC.

## Enforcement Level

[REQUIRED]

## Related Tools

- kubectl: Kubernetes cluster management
- terraform: Infrastructure as Code
- terraform-import: State import for existing resources
