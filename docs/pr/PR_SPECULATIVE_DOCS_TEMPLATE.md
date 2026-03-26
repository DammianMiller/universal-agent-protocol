## Title

docs: add speculative decoding production playbook and agentic compatibility guidance

## Context

`docs/speculative.md` explains speculative mechanisms and flags, but production operators also need:

- workload-driven profile selection,
- reproducible benchmarking protocol,
- signature-based regression triage,
- guidance for stream+tools agentic environments.

This PR adds operational documentation to reduce drift between benchmark wins and real-session behavior.

## Changes

### Add new guide

- New: `docs/speculative-production.md`
  - implementation matrix:
    - `draft`
    - `ngram-cache`
    - `ngram-simple`
    - `ngram-map-k`
    - `ngram-map-k4v`
    - `ngram-mod`
  - decision tree by workload (coding, repetitive transform, mixed)
  - benchmark protocol (run counts, warmup, prompt classes, metrics)
  - troubleshooting by signature:
    - `find_slot: non-consecutive token position`
    - low acceptance + high rollback
    - throughput collapse after commit switch
  - rollout rules (canary, promotion threshold, rollback triggers)

### Update existing speculative docs

- Update `docs/speculative.md`:
  - add link to production guide
  - add "how to interpret statistics in practice"
  - add "workload sensitivity and reproducibility notes"

### Add compatibility appendix

- New appendix (or linked page): stream+tools compatibility for proxy-mediated agentic flows
  - fallback policy guidance (`off` default for production)
  - malformed stream/tool guardrail behavior
  - max token floor and prune target recommendations

## Why

Speculative decoding quality in agentic coding depends on end-to-end behavior, including transport and stream tool-loop handling. This documentation closes that gap and provides a repeatable operator path.

## Validation Plan

- Verify all CLI flags/options in examples against current `llama-server`.
- Verify all linked scripts/docs paths resolve.
- Include one benchmark table with:
  - decode/prefill throughput
  - acceptance indicators
  - latency percentiles
  - workload class labels

## Risks

- Overfitting recommendations to one model/hardware class.
- Treating proxy behavior as universally required.

## Mitigations

- Mark all profile recommendations as workload/hardware sensitive.
- Separate "safe baseline" from "aggressive benchmark-only" profiles.
- Require local A/B validation before rollout.

## Out of Scope

- Runtime code changes
- Kernel-level speculative optimization changes
- Proxy implementation changes (docs-only PR)

## Follow-ups

1. Add nightly speculative regression harness.
2. Publish benchmark JSON schema for machine comparison.
3. Add commit-lineage tracking for performance regressions.

---

## Ready-to-Submit GitHub PR Body

### Summary

This docs PR adds a production-oriented speculative decoding playbook for llama.cpp users running real multi-turn workloads (especially agentic/tool-call scenarios). It complements existing mechanism-level docs with actionable tuning, troubleshooting, and rollout guidance.

### What Changed

- Added `docs/speculative-production.md` (new operational guide)
  - implementation selection matrix
  - workload-based decision tree
  - benchmark protocol + required metrics
  - troubleshooting by real log signatures
  - canary/rollback rollout guidance
- Updated `docs/speculative.md`
  - links to production guide
  - practical stats interpretation notes
  - workload sensitivity notes
- Added/linked "agentic stream+tools compatibility" appendix
  - fallback policy defaults
  - malformed stream/tool guardrails
  - token-floor/prune guidance

### Why

Current docs describe speculative decoding internals clearly, but production operators need a reproducible way to:

- choose stable profiles by workload,
- detect/triage regressions quickly,
- avoid benchmark-only wins that fail in long sessions.

### Reviewer Guide

Please focus review on:

1. Accuracy of CLI flags and option names.
2. Correctness of troubleshooting signatures and interpretations.
3. Clarity of benchmark protocol (can another team reproduce it?).
4. Whether safe-vs-aggressive profile separation is clear enough.

### Validation

- [ ] Command examples verified against current `llama-server --help`
- [ ] Linked docs/scripts paths validated
- [ ] Benchmark table includes workload class labels
- [ ] Metrics include decode/prefill throughput + latency percentile view
- [ ] No runtime behavior claims without explicit caveats

### Risks / Caveats

- Recommendations are model/hardware/workload dependent.
- Guidance is operational, not a substitute for local A/B testing.

### Follow-ups

- [ ] Add nightly regression harness for speculative profiles
- [ ] Publish machine-readable benchmark schema
- [ ] Add commit lineage references in benchmark artifacts
