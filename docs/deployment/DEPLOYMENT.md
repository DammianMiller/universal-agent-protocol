# UAP Deployment Guide

**Version:** 1.0.0  
**Last Updated:** 2026-03-13  
**Status:** ✅ Production Ready

---

## Executive Summary

This guide provides comprehensive deployment options for Universal Agent Protocol (UAP), including model providers, Infrastructure as Code (IaC) providers, and CI/CD providers. All options include enforcement workflows for production deployments.

### Quick Reference

| Category  | Default               | Alternatives               | Recommendation                    |
| --------- | --------------------- | -------------------------- | --------------------------------- |
| **Model** | Local Qwen3.5 35B A3B | Sonnet 4.6 API, OpenRouter | ✅ Local for production           |
| **IaC**   | Terraform             | Pulumi, Crossplane         | ✅ Terraform for most teams       |
| **CI/CD** | GitHub Actions        | GitLab CI, CircleCI        | ✅ GitHub Actions for integration |

---

## 1. Model Providers

### 1.1 Local Qwen3.5 35B A3B (Recommended)

**Provider:** `llama.cpp` via `@ai-sdk/openai-compatible`

**Configuration:**

```json
{
  "provider": {
    "llama.cpp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local Qwen3.5 35B A3B",
      "options": {
        "baseURL": "http://localhost:8080/v1",
        "apiKey": "sk-local",
        "maxVRAM": 16384,
        "quantization": "IQ4_XS",
        "contextWindow": 262144,
        "outputTokens": 16384
      },
      "models": {
        "qwen35-a3b-iq4xs": {
          "name": "Qwen3.5 35B A3B (IQ4_XS)",
          "limit": {
            "context": 262144,
            "output": 16384
          },
          "sonnet4-equivalent": {
            "enabled": true,
            "optimizations": [
              "tool_call_optimization",
              "streaming_efficiency",
              "tool_reference_simulation",
              "parallel_tool_calls",
              "structured_output"
            ],
            "temperature_settings": {
              "build": 0.1,
              "plan": 0.2,
              "memory": 0.0,
              "review": 0.1
            }
          }
        }
      }
    }
  },
  "model": "llama.cpp/qwen35-a3b-iq4xs"
}
```

**Hardware Requirements:**

| VRAM     | Quantization | Max Context | Recommended Use      |
| -------- | ------------ | ----------- | -------------------- |
| **16GB** | IQ4_XS       | 128K        | General purpose      |
| **16GB** | q4_k_m       | 32K         | Balanced performance |
| **16GB** | q3_k_m       | 256K        | Maximum context      |
| **24GB** | q5_k_m       | 64K         | Best accuracy        |
| **24GB** | q4_k_m       | 128K        | Balanced             |
| **24GB** | q3_k_m       | 256K        | Maximum context      |

**Pros:**

- ✅ **Free** - No per-token costs
- ✅ **100% uptime** - Local control
- ✅ **256K context** - Full context retention
- ✅ **Privacy** - Data stays local
- ✅ **Low latency** - ~50ms first token

**Cons:**

- ❌ Requires 16-24GB VRAM hardware
- ❌ Initial setup complexity
- ❌ Hardware investment

**Best For:**

- Production deployments
- Privacy-sensitive applications
- High-volume usage
- Cost optimization

### 1.2 Claude 3.5 Sonnet API

**Provider:** `anthropic`

**Configuration:**

```json
{
  "provider": {
    "anthropic": {
      "name": "Claude 3.5 Sonnet",
      "options": {
        "apiKey": "${ANTHROPIC_API_KEY}",
        "maxTokens": 8192
      },
      "models": {
        "claude-3-5-sonnet-20241022": {
          "name": "Claude 3.5 Sonnet",
          "limit": {
            "context": 200000,
            "output": 8192
          }
        }
      }
    }
  },
  "model": "anthropic/claude-3-5-sonnet-20241022"
}
```

**Hardware Requirements:**

- None (cloud-based)

**Pros:**

- ✅ No hardware required
- ✅ High quality outputs
- ✅ Native tool call support
- ✅ Reliable API

**Cons:**

- ❌ **$3/1M input tokens** - Significant cost at scale
- ❌ 200K context limit
- ❌ ~100ms first token latency
- ❌ Data leaves local environment

**Best For:**

- Testing and development
- Low-volume usage
- When local hardware unavailable
- Hybrid deployments

### 1.3 OpenRouter Aggregation

**Provider:** `openrouter`

**Configuration:**

```json
{
  "provider": {
    "openrouter": {
      "npm": "@openrouter/ai-sdk-provider",
      "name": "OpenRouter",
      "options": {
        "apiKey": "${OPENROUTER_API_KEY}"
      },
      "models": {
        "qwen/qwen-2.5-35b-instruct:free": {
          "name": "Qwen 2.5 35B (Free)",
          "limit": { "context": 32000, "output": 4096 }
        },
        "mistralai/mistral-large": {
          "name": "Mistral Large",
          "limit": { "context": 32000, "output": 32000 }
        }
      }
    }
  }
}
```

**Hardware Requirements:**

- None (cloud-based)

**Pros:**

- ✅ Multiple model options
- ✅ Pay-per-use pricing
- ✅ Free tier available

**Cons:**

- ❌ **$0.2-2/1M tokens** - Variable pricing
- ❌ 32K-128K context limits
- ❌ ~200ms first token latency
- ❌ Not recommended for production

**Best For:**

- Experimentation
- Low-volume testing
- Model comparison

---

## 2. Infrastructure as Code (IaC) Providers

### 2.1 Terraform (Default - Recommended)

**Provider:** `hashicorp/terraform`

**Configuration:**

```json
{
  "iac": {
    "provider": "terraform",
    "version": "1.9.0",
    "backend": {
      "type": "s3",
      "config": {
        "bucket": "${TF_STATE_BUCKET}",
        "key": "infra/terraform.tfstate",
        "region": "us-east-1"
      }
    },
    "workspaces": {
      "enabled": true,
      "prefix": "uap-"
    },
    "enforcement": {
      "mode": "strict",
      "allowDirectInfra": false,
      "rapidIterationAllowed": true,
      "rapidIterationWorkflow": {
        "enableDirectChanges": true,
        "directChangeTypes": ["kubectl", "helm", "terraform apply -target"],
        "rapidIterationPath": ".factory/rapid-iteration/",
        "backportWorkflow": {
          "enabled": true,
          "steps": [
            "Detect direct changes via git diff",
            "Generate Terraform configuration from changes",
            "Validate with terraform fmt && terraform validate",
            "Commit to IaC branch",
            "PR for review",
            "Merge to main after CI passes"
          ]
        }
      }
    }
  }
}
```

**Enforcement Hooks:**

```bash
#!/bin/bash
# .factory/hooks/pre-commit-iac.sh

set -euo pipefail

CHANGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

# IaC enforcement
if echo "$CHANGED_FILES" | grep -qE '^(terraform/|\.tf$|pulumi/|crossplane/)'; then
  echo "✅ IaC file detected - validating..."

  if [ -d "terraform" ]; then
    terraform fmt -check -recursive || {
      echo "❌ Terraform format check failed"
      exit 1
    }
    terraform validate || {
      echo "❌ Terraform validation failed"
      exit 1
    }
  fi
fi

# Block direct infra changes
if echo "$CHANGED_FILES" | grep -qE '^kubernetes/|^manifests/|^/etc/|^/var/' && \
   ! echo "$CHANGED_FILES" | grep -q '.factory/rapid-iteration/'; then
  echo "❌ ERROR: Direct infrastructure changes are blocked"
  echo "✅ Use IaC: terraform apply"
  echo "✅ Or rapid iteration: .factory/rapid-iteration/ (backport required)"
  exit 1
fi

exit 0
```

**Pros:**

- ✅ **Industry standard** - Mature ecosystem
- ✅ **State management** - S3 backend
- ✅ **Workspaces** - Environment isolation
- ✅ **Strict enforcement** - IaC-only mode
- ✅ **Rapid iteration** - Backport workflow

**Cons:**

- ❌ Learning curve for HCL
- ❌ State file management
- ❌ Initial setup complexity

**Best For:**

- Most teams (default recommendation)
- Production environments
- Multi-environment setups

### 2.2 Pulumi

**Provider:** `pulumi/pulumi`

**Configuration:**

```json
{
  "iac": {
    "provider": "pulumi",
    "version": "3.117.0",
    "language": "typescript",
    "runtime": "node",
    "backend": {
      "url": "pulumi.com/${PULUMI_USER}"
    },
    "enforcement": {
      "mode": "strict",
      "allowDirectInfra": false,
      "rapidIterationAllowed": true
    }
  }
}
```

**Pros:**

- ✅ **TypeScript/Python** - Full programming language
- ✅ **Pulumi Hub** - Component library
- ✅ **State management** - Cloud backend

**Cons:**

- ❌ Less mature than Terraform
- ❌ Smaller ecosystem
- ❌ More complex for simple tasks

**Best For:**

- TypeScript/Python teams
- Teams wanting full programming power
- Complex infrastructure logic

### 2.3 Crossplane

**Provider:** `crossplane/crossplane`

**Configuration:**

```json
{
  "iac": {
    "provider": "crossplane",
    "version": "1.14.0",
    "kubernetes": {
      "context": "${KUBE_CONTEXT}"
    },
    "enforcement": {
      "mode": "strict",
      "allowDirectInfra": false,
      "rapidIterationAllowed": true
    }
  }
}
```

**Pros:**

- ✅ **Kubernetes-native** - CRD-based
- ✅ **GitOps-friendly** - Declarative
- ✅ **Multi-cloud** - Unified API

**Cons:**

- ❌ **Kubernetes-only** - Limited scope
- ❌ Steep learning curve
- ❌ Complex setup

**Best For:**

- Kubernetes-only environments
- GitOps workflows
- Multi-cloud K8s deployments

---

## 3. CI/CD Providers

### 3.1 GitHub Actions (Default - Recommended)

**Provider:** `github/actions`

**Configuration:**

```json
{
  "cicd": {
    "provider": "github",
    "repository": "${GITHUB_REPO}",
    "workflows": [
      ".github/workflows/terraform-plan.yaml",
      ".github/workflows/terraform-apply.yaml",
      ".github/workflows/backport-iac.yaml"
    ],
    "enforcement": {
      "mode": "strict",
      "requiredChecks": ["terraform-fmt", "terraform-validate", "terraform-plan", "security-scan"],
      "rapidIterationBranch": "rapid-iteration/",
      "backportBranch": "backport-iac/",
      "autoBackport": {
        "enabled": true,
        "triggers": ["rapid-iteration/* -> backport-iac/*", "direct kubectl changes detected"],
        "steps": [
          "Detect changes in .factory/rapid-iteration/",
          "Generate IaC from changes",
          "Create PR to backport",
          "Run CI checks",
          "Merge on approval"
        ]
      }
    }
  }
}
```

**GitHub Actions Workflows:**

```yaml
# .github/workflows/terraform-plan.yaml
name: Terraform Plan
on:
  pull_request:
    paths:
      - 'terraform/**'
      - '**.tf'

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - run: terraform init
      - run: terraform fmt -check -recursive
      - run: terraform validate
      - run: terraform plan -out=plan.out
```

```yaml
# .github/workflows/backport-iac.yaml
name: Backport IaC
on:
  workflow_dispatch:
  push:
    branches:
      - 'rapid-iteration/*'

jobs:
  backport:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Detect Direct Changes
        run: |
          git diff --name-only HEAD~1 HEAD | grep -E 'kubectl|helm'
      - name: Generate IaC
        run: |
          python .factory/scripts/extract-iac-from-changes.py
      - name: Create PR
        run: |
          gh pr create --title "Backport IaC: ${{ github.ref_name }}" \
            --body "Auto-generated IaC from rapid iteration" \
            --head backport-iac:${{ github.ref_name }}
```

**Pros:**

- ✅ **Native GitHub integration** - Best integration
- ✅ **Free tier** - 2,000 minutes/month free
- ✅ **Actions marketplace** - Vast library
- ✅ **Auto-backport** - Rapid iteration support

**Cons:**

- ❌ GitHub-only (no self-hosted alternatives)
- ❌ Rate limits on free tier

**Best For:**

- GitHub repositories (default)
- Most teams
- Rapid iteration workflows

### 3.2 GitLab CI

**Provider:** `gitlab/ci`

**Configuration:**

```json
{
  "cicd": {
    "provider": "gitlab",
    "repository": "${GITLAB_REPO}",
    "enforcement": {
      "mode": "strict",
      "requiredJobs": ["plan", "validate", "scan"],
      "rapidIterationAllowed": true
    }
  }
}
```

**Pros:**

- ✅ **GitLab integration** - Native for GitLab users
- ✅ **Built-in CI/CD** - No separate service
- ✅ **Free tier** - Generous limits

**Cons:**

- ❌ GitLab ecosystem lock-in
- ❌ Smaller marketplace than GitHub

**Best For:**

- GitLab users
- Teams already using GitLab

### 3.3 CircleCI

**Provider:** `circleci/circleci`

**Configuration:**

```json
{
  "cicd": {
    "provider": "circleci",
    "enforcement": {
      "mode": "strict",
      "rapidIterationAllowed": true
    }
  }
}
```

**Pros:**

- ✅ **Fast execution** - Optimized runners
- ✅ **Docker-native** - Great for containerized workflows

**Cons:**

- ❌ More expensive
- ❌ Complex setup
- ❌ Not recommended for most users

**Best For:**

- High-performance needs
- Docker-heavy workflows

---

## 4. Enforcement Workflows

### 4.1 IaC-Only Mode

**Purpose:** Ensure all infrastructure changes go through IaC

**Workflow:**

```
1. Developer makes direct change (kubectl/helm)
2. Hook detects change
3. If in .factory/rapid-iteration/: Allow + auto-backport
4. If NOT in rapid-iteration: BLOCK with message
5. Developer uses rapid iteration path
6. Auto-backport creates IaC PR
7. PR reviewed and merged
8. terraform apply applied via CI/CD
```

**Pre-Commit Hook:**

```bash
#!/bin/bash
# Block direct infra changes except rapid iteration

CHANGED_FILES=$(git diff --cached --name-only)

if echo "$CHANGED_FILES" | grep -qE '^kubernetes/|^manifests/|^/etc/|^/var/' && \
   ! echo "$CHANGED_FILES" | grep -q '.factory/rapid-iteration/'; then
  echo "❌ Direct infrastructure changes blocked"
  echo "✅ Use IaC: terraform apply"
  echo "✅ Or rapid iteration: .factory/rapid-iteration/"
  exit 1
fi
```

### 4.2 CICD-Only Mode

**Purpose:** Ensure all deployments go through CI/CD pipeline

**Workflow:**

```
1. Developer merges PR to main
2. CI/CD triggers on push
3. Terraform plan runs
4. Security scan runs
5. If all checks pass: terraform apply
6. Deployment complete
```

**Exceptions:**

- `kubectl --dry-run` - Testing only
- `.factory/rapid-iteration/` - Backport workflow

### 4.3 Rapid Iteration Workflow

**Purpose:** Enable fast local testing with automatic IaC generation

**Workflow:**

```
1. Create branch: rapid-iteration/<feature>
2. Make direct changes (kubectl/helm)
3. Test locally
4. Commit to rapid-iteration branch
5. Post-commit hook triggers
6. IaC generated from changes
7. Backport branch created
8. PR created for review
9. CI/CD validates IaC
10. Merge to main
```

**Post-Commit Hook:**

```bash
#!/bin/bash
# Auto-backport rapid iteration changes

if git diff --cached --name-only | grep -q '.factory/rapid-iteration/'; then
  echo "🔄 Rapid iteration detected - triggering backport..."

  # Generate IaC
  python .factory/scripts/extract-iac-from-changes.py

  # Create backport branch
  BACKPORT_BRANCH="backport-iac/$(date +%Y%m%d-%H%M%S)"
  git checkout -b "$BACKPORT_BRANCH"

  # Commit and PR
  git add terraform/
  git commit -m "Backport IaC: $(git log -1 --format=%s)"
  git push origin "$BACKPORT_BRANCH"
  gh pr create --title "Backport IaC: $(git log -1 --format=%s)" \
    --body "Auto-generated IaC from rapid iteration" \
    --head "$BACKPORT_BRANCH"
fi
```

---

## 5. Deployment Checklist

### 5.1 Pre-Deployment

- [ ] Select model provider (Local Qwen3.5 recommended)
- [ ] Configure hardware (16GB/24GB VRAM)
- [ ] Select IaC provider (Terraform recommended)
- [ ] Select CI/CD provider (GitHub Actions recommended)
- [ ] Set up state backend (S3 for Terraform)
- [ ] Configure GitHub repository
- [ ] Install Git hooks
- [ ] Set up Qdrant for semantic memory

### 5.2 Post-Deployment

- [ ] Run `uap task ready`
- [ ] Run `python agents/scripts/index_patterns_to_qdrant.py`
- [ ] Verify SessionStart hook enforcement
- [ ] Test worktree creation
- [ ] Test memory storage
- [ ] Test IaC enforcement (try direct change - should block)
- [ ] Test rapid iteration (should auto-backport)
- [ ] Verify CI/CD workflows

---

## 6. Provider Comparison Matrix

### 6.1 Model Providers

| Feature         | Local Qwen3.5 | Sonnet 4.6 API | OpenRouter         |
| --------------- | ------------- | -------------- | ------------------ |
| Cost            | Free          | $3/1M input    | $0.2-2/1M          |
| VRAM            | 16GB required | N/A            | N/A                |
| Context         | 256K          | 200K           | 32K-128K           |
| Tool Calls      | Simulated     | Native         | Simulated          |
| Latency         | ~50ms         | ~100ms         | ~200ms             |
| Reliability     | 100% (local)  | 99.9%          | 99.5%              |
| **Recommended** | ✅ Production | ⚠️ Testing     | ❌ Not recommended |

### 6.2 IaC Providers

| Feature         | Terraform   | Pulumi            | Crossplane  |
| --------------- | ----------- | ----------------- | ----------- |
| Language        | HCL         | TypeScript/Python | YAML        |
| State           | Remote (S3) | Remote (Pulumi)   | CRD-based   |
| Learning Curve  | Medium      | Low               | High        |
| **Recommended** | ✅ Default  | ⚠️ TS teams       | ❌ K8s-only |

### 6.3 CI/CD Providers

| Feature         | GitHub Actions | GitLab CI | CircleCI           |
| --------------- | -------------- | --------- | ------------------ |
| Integration     | Native         | Native    | Plugin             |
| Cost            | Free (public)  | Free      | Free tier          |
| Speed           | Fast           | Fast      | Fastest            |
| **Recommended** | ✅ Default     | ⚠️ GitLab | ❌ Not recommended |

---

## 7. Quick Start Examples

### 7.1 Local Qwen3.5 + Terraform + GitHub Actions

```bash
# 1. Install dependencies
npm install -g universal-agent-protocol

# 2. Initialize UAP
uap init

# 3. Configure for local Qwen3.5
cat > opencode.json << 'EOF'
{
  "provider": {
    "llama.cpp": {
      "name": "Local Qwen3.5 35B",
      "options": {
        "baseURL": "http://localhost:8080/v1",
        "apiKey": "sk-local"
      },
      "models": {
        "qwen35-a3b-iq4xs": {
          "name": "Qwen3.5 35B A3B",
          "limit": {
            "context": 262144,
            "output": 16384
          }
        }
      }
    }
  },
  "model": "llama.cpp/qwen35-a3b-iq4xs"
}
EOF

# 4. Configure Terraform
cat > .factory/iac-config.json << 'EOF'
{
  "iac": {
    "provider": "terraform",
    "enforcement": {
      "mode": "strict",
      "allowDirectInfra": false,
      "rapidIterationAllowed": true
    }
  }
}
EOF

# 5. Install hooks
uap hooks install all

# 6. Start Qdrant
uap memory start

# 7. Verify setup
uap compliance check
```

### 7.2 Sonnet 4.6 + Pulumi + GitLab CI

```bash
# 1. Install dependencies
npm install -g universal-agent-protocol

# 2. Initialize UAP
uap init

# 3. Configure for Sonnet 4.6
cat > opencode.json << 'EOF'
{
  "provider": {
    "anthropic": {
      "name": "Claude 3.5 Sonnet",
      "options": {
        "apiKey": "${ANTHROPIC_API_KEY}"
      },
      "models": {
        "claude-3-5-sonnet-20241022": {
          "name": "Claude 3.5 Sonnet",
          "limit": {
            "context": 200000,
            "output": 8192
          }
        }
      }
    }
  },
  "model": "anthropic/claude-3-5-sonnet-20241022"
}
EOF

# 4. Configure Pulumi
cat > .factory/iac-config.json << 'EOF'
{
  "iac": {
    "provider": "pulumi",
    "language": "typescript",
    "enforcement": {
      "mode": "strict",
      "allowDirectInfra": false
    }
  }
}
EOF

# 5. Install hooks
uap hooks install all
```

---

## 8. Troubleshooting

### 8.1 Common Issues

**Issue:** "Database not found"  
**Solution:** Run `uap init` to create memory database

**Issue:** "Qdrant connection failed"  
**Solution:** Run `uap memory start` to start Qdrant

**Issue:** "Direct infra changes blocked"  
**Solution:** Use `.factory/rapid-iteration/` or `terraform apply`

**Issue:** "Worktree creation failed"  
**Solution:** Check Git configuration and permissions

### 8.2 Getting Help

- Documentation: `docs/` directory
- Issues: GitHub repository issues
- Community: Join UAP Discord

---

**Last Updated:** 2026-03-13  
**Version:** 1.0.0  
**Status:** ✅ Production Ready
