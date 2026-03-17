# UAP Default Policies

These policies can be enabled/disabled during `uap setup` or via `uap-policy` CLI.

## Available Policies

| Policy                   | Default | Level       | Description                                          |
| ------------------------ | ------- | ----------- | ---------------------------------------------------- |
| iac-state-parity         | ON      | REQUIRED    | Enforce IaC for all infrastructure changes           |
| iac-pipeline-enforcement | ON      | REQUIRED    | All Terraform ops go through CI/CD pipeline only     |
| kubectl-verify-backport  | ON      | REQUIRED    | kubectl-created resources must be backported to IaC  |
| definition-of-done-iac   | ON      | REQUIRED    | IaC pipeline apply + kubectl verify = done           |
| mandatory-file-backup    | ON      | REQUIRED    | Backup files before modification                     |
| image-asset-verification | OFF     | RECOMMENDED | Enforce deterministic image operations               |

## Usage

```bash
# Add a policy
uap-policy add -f policies/iac-pipeline-enforcement.md -c security -l REQUIRED -t iac,terraform,pipeline

# List active policies
uap-policy list

# Check if an operation would be allowed
uap-policy check -o "terraform_apply" -a '{"command":"terraform apply"}'

# View audit trail
uap-policy audit
```
