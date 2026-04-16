# cluster-routing

**Category**: infrastructure
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: kubernetes, istio, multi-cluster, iac

## Rule

`kubectl apply|patch|create|edit|delete` and `helm install|upgrade|uninstall` MUST target the cluster context matching the component's domain:

- **Observability** (Grafana, Prometheus, OpenObserve, Fluent Bit, ServiceMonitor, alerts, dashboards) → `do-syd1-pay2u-openobserve`
- **Authentication / Identity** (Zitadel, OIDC, IAM CRDs) → `do-syd1-zitadel`
- **Everything else** (apps, APIs, CMS, web, ML services, PgDog, Redis, Postgres/CNPG) → `do-syd1-pay2u`

## Why

AGENTS.md codifies the 3-cluster split. Cross-cluster mistakes cost 10–30 min per rollback plus reconciliation. Cross-cluster traffic MUST use public HTTPS URLs, never cluster-internal DNS.

## Enforcement

Python enforcer `cluster_routing.py` checks `kubectl config current-context` against the manifest's domain before allowing the command.

```rules
- title: "kubectl context must match component domain"
  keywords: [kubectl, helm, apply, patch, install, upgrade]
  antiPatterns: [wrong-context, cross-cluster-dns]
- title: "Cross-cluster calls must use public HTTPS"
  keywords: [cross-cluster, service-mesh]
  antiPatterns: [svc.cluster.local, internal-dns]
```
