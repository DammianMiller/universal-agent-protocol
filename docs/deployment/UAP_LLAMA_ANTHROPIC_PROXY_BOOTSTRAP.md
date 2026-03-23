# UAP + llama.cpp + Anthropic Proxy Bootstrap

This guide captures the local continuity stack as a repeatable bootstrap:

- `uap-llama-server.service` (llama.cpp)
- `uap-anthropic-proxy.service` (Anthropic API compatibility)
- A/B benchmark workflow for speculative decoding with `ngram-cache`

It also documents the UAP-side support changes needed to keep llama.cpp speculative decoding stable in agentic workflows.

## 1) Bootstrap services

Run:

```bash
bash scripts/bootstrap/bootstrap-uap-llama-proxy-stack.sh
```

This writes:

- `~/.config/uap/llama-server.env`
- `~/.config/uap/anthropic-proxy.env`
- `~/.config/systemd/user/uap-llama-server.service`
- `~/.config/systemd/user/uap-anthropic-proxy.service`

Then it enables and starts both user services.

## 2) Key llama env knobs

Edit `~/.config/uap/llama-server.env` and restart service:

```bash
systemctl --user restart uap-llama-server.service
```

Important variables:

- `LLAMA_SPEC_TYPE` (`none`, `ngram-cache`, etc.)
- `LLAMA_DRAFT_MAX`
- `LLAMA_DRAFT_MIN`
- `LLAMA_DRAFT_P_MIN`
- `LLAMA_EXTRA_ARGS` (optional additional startup flags)

## 3) Key proxy env knobs

Edit `~/.config/uap/anthropic-proxy.env` and restart proxy:

```bash
systemctl --user restart uap-anthropic-proxy.service
```

Important variables:

- `PROXY_PORT`
- `LLAMA_CPP_BASE`
- `PROXY_CONTEXT_WINDOW` (set to `262144` to match llama context)
- Loop/guardrail options (`PROXY_LOOP_BREAKER`, `PROXY_FORCED_THRESHOLD`, etc.)

## 4) Run ngram-cache signal benchmark

Use the service-oriented A/B script:

```bash
bash scripts/benchmarks/run-spec-ngram-service-ab.sh
```

What it does:

1. Stops managed `uap-llama-server.service` temporarily
2. Runs transient systemd service benchmarks for:
   - `spec-type=none`
   - `spec-type=ngram-cache` (default draft params)
   - `spec-type=ngram-cache` (tuned: `21/6/0.72`)
3. Restores managed `uap-llama-server.service`
4. Writes report artifacts under `benchmark-results/spec-ngram-ab-<timestamp>/`

Outputs:

- `report.json` machine-readable deltas
- `report.md` human-readable summary

## 5) Run automatic draft-parameter sweep (Option 2)

Use this to search for the best local `ngram-cache` settings:

```bash
bash scripts/benchmarks/run-spec-ngram-sweep.sh
```

Useful overrides:

```bash
RUNS=5 MAX_TOKENS=256 \
DRAFT_MAXS="16 18 20 22" \
DRAFT_MINS="3 4 5 6" \
DRAFT_P_MINS="0.70 0.72 0.75 0.78" \
bash scripts/benchmarks/run-spec-ngram-sweep.sh
```

Outputs are written under `benchmark-results/spec-ngram-sweep-<timestamp>/`:

- `results.jsonl` one entry per candidate
- `summary.json` best candidate + stats
- `summary.md` top 5 table

## 6) Profiles for agentic coding vs max speed

Use two explicit profiles depending on your goal.

### A) Agentic coding continuity profile (recommended daily use)

This profile prioritizes long, coherent coding sessions and minimizes `find_slot` warnings.

`~/.config/uap/llama-server.env`:

```env
LLAMA_CTX_SIZE=262144
LLAMA_SPEC_TYPE=ngram-cache
LLAMA_DRAFT_MAX=12
LLAMA_DRAFT_MIN=2
LLAMA_DRAFT_P_MIN=0.80
LLAMA_HYBRID_ROLLBACK_MODE=strict
```

Apply it:

```bash
systemctl --user restart uap-llama-server.service
```

`~/.config/uap/anthropic-proxy.env`:

```env
PROXY_CONTEXT_WINDOW=262144
PROXY_LOOP_BREAKER=on
PROXY_LOOP_WINDOW=6
PROXY_LOOP_REPEAT_THRESHOLD=10
PROXY_FORCED_THRESHOLD=18
PROXY_NO_PROGRESS_THRESHOLD=5
PROXY_CONTEXT_RELEASE_THRESHOLD=0.95
PROXY_GUARDRAIL_RETRY=on
```

Apply it:

```bash
systemctl --user restart uap-anthropic-proxy.service
```

### B) Max-throughput benchmark profile (where 220+ tok/s was observed)

The 220+ decode throughput observed in this session was achieved with:

- CUDA build: `/home/cogtek/llama.cpp/.worktrees/001-llama-spec-rollback-fix/build-cuda/bin/llama-server`
- GPU flags: `--device CUDA0 --n-gpu-layers all --flash-attn on`
- Speculative mode: `--spec-type ngram-cache`
- Rollback mode: `LLAMA_HYBRID_ROLLBACK_MODE=hybrid`
- Workload: repetitive pattern prompt, `n_predict=512`

Run command used for that profile:

```bash
LLAMA_HYBRID_ROLLBACK_MODE=hybrid \
/home/cogtek/llama.cpp/.worktrees/001-llama-spec-rollback-fix/build-cuda/bin/llama-server \
  -m "/home/cogtek/Downloads/Qwen3.5-35B-A3B-UD-IQ4_XS.gguf" \
  --host 127.0.0.1 --port 18121 \
  --ctx-size 16384 --parallel 1 --no-warmup \
  --device CUDA0 --n-gpu-layers all --flash-attn on \
  --spec-type ngram-cache
```

Important: this max-speed profile is workload-sensitive and was measured on a pattern-heavy prompt. For real agentic coding, use Profile A.

## 7) Validated A/B findings (2026-03-23)

Direct old-vs-new A/B was run against:

- old fast commit: `029edcafc` (first pushed fast state around 21:35)
- newer commit: `1f8225f8f`
- model: `Qwen3.5-35B-A3B-UD-IQ4_XS.gguf`
- speculative: `ngram-cache`, `draft-max=16`, `draft-min=3`, `draft-p-min=0.72`

Notes:

- Standalone launches at `ctx-size=262144` can fail GPU allocation on some runs for the old commit (`failed to allocate compute pp buffers`).
- For controlled apples-to-apples throughput comparison, A/B was run at `ctx-size=16384`.

Observed results (`/tmp/ab_matrix_ctx16_v2.json`):

| Path            | Old `029edcafc` | New `1f8225f8f` | Delta (new vs old) |
| --------------- | --------------- | --------------- | ------------------- |
| Raw coding      | 107.97 tok/s    | 99.23 tok/s     | -8.1%               |
| Raw pattern     | 158.71 tok/s    | 105.75 tok/s    | -33.4%              |
| Proxy plain     | 113.74 tok/s    | 109.39 tok/s    | -3.8%               |
| Agentic tool 2nd turn | `tool_use` (stable) | `tool_use` (stable) | parity on control flow |

Behavioral observations:

- Newer commit emitted many `find_slot: non-consecutive token position` warnings in raw/proxy runs under the same speculative settings.
- Old commit produced materially cleaner logs and higher throughput in the same benchmark profile.
- Proxy continuity fixes improved agentic tool-loop stability and no longer force premature stop in the tested loop.

Decision for throughput-sensitive testing:

- Prefer old fast commit `029edcafc` profile for max-throughput benchmarking.
- Keep a separate continuity profile for long-context agentic coding if warning volume grows.

Additional 27B impact snapshot (`Qwen3.5-27B-IQ4_XS`, `ctx=262144`, q4 KV cache):

- no speculative: ~43 tok/s coding, ~41 tok/s pattern
- aggressive speculative (`16/3/0.72`): ~44 tok/s coding, ~102 tok/s pattern
- balanced speculative (`12/2/0.80`): ~43 tok/s coding, ~102 tok/s pattern

Interpretation:

- balanced profile is functionally safer for agentic sessions,
- aggressive profile can edge higher on some coding runs,
- both speculative profiles massively outperform no-spec on repetition-heavy drafts.

## 8) Throughput interpretation and loop prevention

When reading llama logs, treat these as different metrics:

- `prompt eval time ... tokens per second` = prefill throughput
- `eval time ... tokens per second` = decode/completion throughput

In local continuity runs with large context, prompt throughput may exceed 2k tok/s while decode remains near 80-125 tok/s.

For default stability, use the guardrails from Profile A. If you hit active loop incidents, temporarily tighten to:

```env
PROXY_LOOP_WINDOW=6
PROXY_LOOP_REPEAT_THRESHOLD=8
PROXY_FORCED_THRESHOLD=14
PROXY_NO_PROGRESS_THRESHOLD=4
PROXY_CONTEXT_RELEASE_THRESHOLD=0.90
```

Then restart proxy:

```bash
systemctl --user restart uap-anthropic-proxy.service
```

## 9) UAP support changes required for reliable operation

The following UAP-side changes are part of the working stack and should be present:

1. Session-scoped loop protection in Anthropic proxy (no cross-session contamination).
2. Guardrail retry for unexpected text-only end-turn in active tool loops.
3. Optional systemd scaffolding from CLI:
   - `uap init --systemd-services`
   - `uap setup --systemd-services`
4. Dedicated launch scripts:
   - `scripts/run-llama-server-continuity.sh`
   - `scripts/run-anthropic-proxy-continuity.sh`

These changes ensure llama speculative behavior is evaluated in a stable proxy/control-plane environment.

## 10) Check service health

```bash
systemctl --user status uap-llama-server.service --no-pager
systemctl --user status uap-anthropic-proxy.service --no-pager
curl -sf http://127.0.0.1:8080/v1/models
curl -sf http://127.0.0.1:4000/health
```

## 11) References and credits

This implementation and tuning flow builds on prior llama.cpp and proxy work:

- llama.cpp speculative docs: `docs/speculative.md`
- llama.cpp hybrid rollout notes: `docs/development/speculative-hybrid-rollout.md`
- llama.cpp speculative lineage: #5479, #6828, #6848, #19164
- checkpoint/SWA context note:
  - https://github.com/ggml-org/llama.cpp/pull/13194#issuecomment-2868343055

Thanks to ggml-org/llama.cpp maintainers and contributors for speculative, cache, and memory-path groundwork.
