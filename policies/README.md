# UAP Default Policies

These policies can be enabled/disabled during `uap setup` or via `uap-policy` CLI.

## Available Policies

| Policy                   | Default | Level       | Description                                |
| ------------------------ | ------- | ----------- | ------------------------------------------ |
| image-asset-verification | OFF     | RECOMMENDED | Enforce deterministic image operations     |
| iac-state-parity         | ON      | REQUIRED    | Enforce IaC for all infrastructure changes |

## Usage

```bash
# Add a policy
uap-policy add -f policies/image-asset-verification.md -c image -l RECOMMENDED -t image,vision,asset

# List active policies
uap-policy list

# Check if an operation would be allowed
uap-policy check -o "vision_count" -a '{"image":"photo.png"}'

# View audit trail
uap-policy audit
```
