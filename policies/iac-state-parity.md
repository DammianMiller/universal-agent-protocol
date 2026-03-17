# Infrastructure as Code State Parity

All infrastructure and configuration changes MUST be reflected in Infrastructure as Code (IaC) files. No manual or ad-hoc changes that bypass version-controlled configuration.

## Rules

1. **Always apply state changes to IaC.** When modifying infrastructure, services, or configuration, update the corresponding IaC files (Terraform, Pulumi, CloudFormation, Ansible, Docker Compose, Kubernetes manifests, etc.) to ensure reproducibility.
   - Never make manual changes to infrastructure without updating IaC
   - All environment variables, secrets references, and service configurations must be in IaC

2. **Always use the OSS version.** When there is an option between a proprietary and open-source solution, prefer the open-source version unless explicitly instructed otherwise.
   - Evaluate OSS alternatives before recommending proprietary tools
   - Document the rationale when proprietary is chosen

3. **Configuration drift prevention.** Before applying changes, verify that the current state matches the IaC definition. If drift is detected, reconcile before making new changes.

4. **Reproducibility verification.** After making IaC changes, verify that the configuration can be applied cleanly from scratch (plan/dry-run).

## Enforcement Level

[REQUIRED]

## Related Tools

- terraform: Infrastructure provisioning
- docker-compose: Container orchestration
- kubernetes: Container orchestration
- ansible: Configuration management
