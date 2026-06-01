# Expert Droids Reference

UAP ships with a 30-droid expert stack covering the full SDLC — ideation,
strategy, design, build, review, release, and operations. Droids are markdown
files under `.factory/droids/` discoverable by the capability router, the MCP
router's `expert-consultation` category (virtual `experts.<name>` tools), and
the `ExpertOrchestrator`. The forward-design / HALO / ideation extensions are
documented in [docs/architecture/EXPERT_STACK.md](../architecture/EXPERT_STACK.md).

## Quick Look

```bash
uap droids list                         # see what's installed
uap droids validate                     # CI-grade integrity check
uap expert-route "<task description>"   # ask for the recommended chain
```

---

## Base Roster (25 droids)

> The 5 forward-design / HALO / ideation droids that bring the total to 30 are
> listed under [Forward-Design, HALO & Ideation Extensions](#forward-design-halo--ideation-extensions) below.

### Strategy (3)

| Droid | Role |
|---|---|
| `product-strategist` | Acceptance criteria, hidden constraints, PRDs |
| `architect-reviewer` | System design validation, ADRs, blast radius |
| `api-designer` | Contract design, versioning, schema diff authority |

### Build (8)

| Droid | Role |
|---|---|
| `typescript-node-expert` | Strict TS, ESM, Node 18+ async patterns |
| `javascript-pro` | Modern ES2023+, browser + Node |
| `python-pro` | Type-safe Python 3.11+, async, packaging |
| `rust-pro` | Ownership, lifetimes, async/await with Tokio |
| `go-pro` | Idiomatic concurrency, errgroup, context |
| `cli-design-expert` | Verb/noun discipline, exit codes, stdout/stderr split |
| `debug-expert` | Root cause analysis, dependency conflicts |
| `refactoring-specialist` | Behavior-preserving transformations |

### Quality (4)

| Droid | Role |
|---|---|
| `code-quality-guardian` | Full-file structural review, smells, metrics |
| `code-quality-reviewer` | Per-diff quality with citations |
| `security-auditor` | Full OWASP audit, secret detection, sec-context |
| `security-code-reviewer` | Per-diff security regressions, CWE-cited |

### Performance & Cost (3)

| Droid | Role |
|---|---|
| `performance-optimizer` | Full perf analysis, bottleneck identification |
| `performance-reviewer` | Per-diff regressions, N+1, allocation hotspots |
| `cost-engineer` | Cloud spend modeling, FinOps, observability cost |

### Testing & QA (4)

| Droid | Role |
|---|---|
| `test-strategist` | Pyramid design, coverage targets, technique selection |
| `test-plan-writer` | Authors test plans + scaffolds from acceptance criteria |
| `test-coverage-reviewer` | Verifies new behavior is exercised |
| `qa-expert` | Flaky test triage, regression bisect, release sign-off |

### Documentation (2)

| Droid | Role |
|---|---|
| `documentation-expert` | Authors comprehensive docs, READMEs, API docs |
| `documentation-accuracy-reviewer` | Per-diff doc drift, broken examples |

### Operations (5)

| Droid | Role |
|---|---|
| `release-manager` | Semver decisions, CHANGELOG, deploy batch priority |
| `compliance-officer` | Policy authoring, regulatory mapping, waivers |
| `incident-responder` | War-room coordination, postmortems, runbooks |
| `observability-engineer` | Logs/metrics/traces, SLOs, cardinality |
| `dependency-auditor` | Supply chain, slopsquatting, CVE workflow |

### Specialty (3)

| Droid | Role |
|---|---|
| `ml-training-expert` | Model training, dataset processing, MTEB |
| `sysadmin-expert` | Linux kernel, QEMU, networking, systemd |
| `terminal-bench-optimizer` | Meta-orchestrator for benchmark tasks |
| `accessibility-tester` | WCAG 2.2 AA, keyboard nav, screen readers |

---

## Routing

The `ExpertOrchestrator` composes droid chains across five phases:

```
plan → design → implement → review → release
```

Each phase pulls from a roster but only includes droids relevant to the
matched capabilities. Review-phase droids run in parallel.

```bash
# CLI surface
uap expert-route "Add rate limiting to /api/login" --files src/auth/login.ts

# JSON output (machine-readable, scriptable)
uap expert-route "..." --json
```

Programmatic surface:

```typescript
import { ExpertOrchestrator } from '@miller-tech/uap/coordination/expert-orchestrator';

const orch = new ExpertOrchestrator({
  successRateFor: (droid) => adaptivePatterns.successRate(droid),
});

const plan = orch.plan(task, affectedFiles);
for (const step of plan.steps) {
  console.log(`${step.phase}: ${step.droid} (${step.parallel ? 'parallel' : 'sequential'})`);
}
```

---

## MCP Router Surface

Every droid is exposed as a virtual MCP tool under the `experts` server,
discoverable via the standard `discover_tools` interface. This preserves
the 98% token-savings shape (just 2 meta tools exposed to the LLM).

```typescript
import { loadExpertTools } from '@miller-tech/uap/mcp-router';

const tools = loadExpertTools(process.cwd());
// tools[].serverName === 'experts'
// tools[].name === '<droid-name>'

// In the MCP router's tool index:
index.addTools(tools);
const matches = index.search('security review for auth code');
// → [{ path: 'experts.security-auditor', ... }]
```

---

## Authoring a New Droid

1. Create `.factory/droids/<name>.md` with frontmatter:
   ```yaml
   ---
   name: <droid-name>
   description: <one-line summary, ≥5 chars>
   model: inherit
   coordination:
     channels: ["review"]
     claims: ["shared"]
     batches_deploy: true
   ---
   ```
2. Body sections: Mission, MANDATORY Pre-Checks, PROACTIVE ACTIVATION,
   protocol/checklist, output shape, coordination notes.
3. If routable: add entry to `DEFAULT_CAPABILITY_MAPPINGS` in
   `src/coordination/capability-router.ts`.
4. Run `uap droids validate` to confirm integrity.
5. CI gate (`droids validate` step) will block merge if anything is off.

See [`.factory/droids/code-quality-guardian.md`](../../.factory/droids/code-quality-guardian.md)
for a canonical example.

---

## Forward-Design, HALO & Ideation Extensions

Added on top of the base roster (see
[docs/architecture/EXPERT_STACK.md](../architecture/EXPERT_STACK.md)):

| Droid | Phase | Role |
|---|---|---|
| `strategic-architect` | plan | North-star architecture, technology selection, multi-quarter evolution (forward-design counterpart to `architect-reviewer`) |
| `tactical-architect` | design | Concrete component boundaries, interfaces, data shapes, pattern selection |
| `implementation-planner` | design | Executable work breakdown: steps, file plan, test plan, rollback |
| `ideation-expert` | ideate | open-collider divergent ideation (bisociation) feeding plan/design |
| `harness-optimizer` | review | HALO loop — diagnoses systemic harness failures from execution traces |

## Policy Hooks

| Policy | Level | Droid authority |
|---|---|---|
| `architecture-review` / `architecture-review-required` | REQUIRED | `architect-reviewer` |
| `expert-review-required` | REQUIRED | parallel-expert-review reviewers |
| `acceptance-criteria-defined` | RECOMMENDED | `product-strategist` |
| `observability-required` | RECOMMENDED | `observability-engineer` |

Architecture-review policy is enforced by
`src/policies/enforcers/<uuid>_architecture_review.py` — blocks PR-ready
operations on qualifying diffs unless an ADR or active waiver is present (backed
by `architecture-review.md`). The `expert-review-required` policy
(`expert_review_required.py`) blocks ship actions until a parallel review
artifact `.uap/reviews/<branch>.json` covers HEAD.

---

## Related

- [PARALLEL REVIEW PROTOCOL skill](../../.factory/skills/parallel-expert-review/SKILL.md)
- [Capability Router](../../src/coordination/capability-router.ts)
- [Expert Orchestrator](../../src/coordination/expert-orchestrator.ts)
- [MCP Router expert registry](../../src/mcp-router/experts/registry.ts)
