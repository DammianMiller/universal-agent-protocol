# pay2u-quick-reference

**Category**: custom
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: pay2u, reference, clusters, example-pack

## Rule

### Cluster Cheat Sheet

```text
MAIN (do-syd1-pay2u)
  Purpose: Applications (API, Web, CMS)
  URL: https://app.pay2u.com.au
  Nodes: 3x s-4vcpu-8gb-amd
  TLS: HTTP-01 challenges OK

OPENOBSERVE (do-syd1-pay2u-openobserve)
  Purpose: ALL Observability (logs, metrics, traces)
  URL: https://observe.pay2u.com.au
  Nodes: 3x s-2vcpu-8gb-amd
  TLS: DNS-01 challenges ONLY (Istio, no nginx)

ZITADEL (do-syd1-zitadel)
  Purpose: ALL Authentication (Zitadel IAM)
  URL: https://auth.pay2u.com.au
  Nodes: 3x s-2vcpu-4gb-amd
  TLS: DNS-01 challenges ONLY (Istio, no nginx)
```

### Cluster Recreation

See: `docs/architecture/CLUSTER_RECREATION_GUIDE.md`

**3-Phase Deployment** (for Istio clusters):

1. Phase 1: Create cluster (`enable_*_cluster=true`, other flags `false`)
2. Phase 2: Deploy Istio + cert-manager (`enable_*=true`, gateway `false`)
3. Phase 3: Enable Gateway/VirtualService (`enable_*_istio_gateway=true`)

**NEVER use nginx ingress** - Istio handles all ingress via Gateway resources.

### Key Workflows

```text
cd-frontend-multicloud.yml  # Frontend
cd-products-api.yml         # Backend API
iac-terraform-cicd.yml      # Infrastructure
security-unified.yml        # Security scans
```

### Database Stack

```text
PostgreSQL: CNPG with pgEdge + Spock 5.0.4
Pooler: PgDog v0.1.32 (replaced PgCat Dec 2025)
HA: 2 instances per cluster (n+1)
```

### IaC Exceptions (Intentionally NOT in Terraform)

```text
OPERATOR-MANAGED (auto-generated, do not import):
  - CNPG secrets: *-app, *-ca, *-replication, *-server, *-superuser
  - CNPG services: *-r, *-ro, *-rw (managed by CNPG operator)
  - Redis ConfigMaps: redis-configuration, redis-health, redis-scripts
  - CNPG monitoring: cnpg-default-monitoring ConfigMap

EPHEMERAL (created by CI jobs, cleaned up automatically):
  - k6 network policies: allow-k6-*-egress, allow-k6-*-to-api
  - ACME solver: cm-acme-http-solver-* pods/services

SYSTEM (Kubernetes-managed, never import):
  - kube-node-lease, kube-public namespaces
  - default ServiceAccount tokens
```

---

**See CLAUDE.md for detailed architecture, configuration, and troubleshooting.**

</coding_guidelines>

# AGENTS.md - UAP Integration for Codex CLI

## Why

Extracted from AGENTS.md during `uap setup` — a project-specific rule promoted to a reviewable UAP policy.
