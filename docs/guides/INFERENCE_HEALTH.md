# Inference Health (`uap inference health`)

`uap doctor` answers *"is the service up and inside its declared budget?"*
This answers a different question: **is it still doing useful work?**

The distinction is not academic. On 2026-09-21 a local llama.cpp server
reported `active (running)` and GREEN from `uap doctor` for eighteen hours
while its prefill throughput fell roughly eight-fold and five client requests
blew a 1800-second deadline overnight. Nothing was down. Liveness checks had
nothing to report, and the only visible symptom — slow turns — looked like the
model being the model.

```bash
uap inference health                # the running process
uap inference health --json         # for monitors and dashboards
uap inference health --strict       # exit 1 on WARN or RED
```

## What it looks at

| Check | Code | Why it exists |
| --- | --- | --- |
| Prefill throughput decay | `prefill-decay` | A long-lived process can get slower without failing. Only visible when samples are bucketed by prompt size. |
| Checkpoint starvation | `checkpoint-starved` | `--ctx-checkpoints` is **per slot**. Too few, and the checkpoint cannot track a growing conversation, so the same prefix is re-prefilled every turn. |
| KV pinned at the VBR floor | `kv-at-floor` | The pool is saturated and the cache has silently dropped to its lowest quality tier. |
| Client-visible timeouts | `generation-timeouts` | The symptom users actually feel, counted from the proxy journal. |
| Window spans a restart | `spans-restart` | A trend across a restart compares two process lifetimes, not decay within one. |
| Rail/pool geometry | `shared-pool` | Informational (never a fault). Under `--kv-unified` the pool is *shared*, so N rails each believing they own it is an overcommit waiting to happen. |

Health is `GREEN` / `WARN` / `RED`, or **`UNKNOWN` when there is no evidence**.
A fabricated GREEN is precisely what let the original incident run all day, so
every probe fails open and any that could not run is listed explicitly as
`unverified (probe unavailable)`.

`UNKNOWN` requires *all three* sampled signals to be missing — no usable
throughput trend, no checkpoint samples, and no KV reading. Losing one of them
does not suppress the rest. An **actionable finding always wins**: timeouts are
counted from the proxy journal and can fire with none of the sampled signals
present, and a RED finding must never be masked by an `UNKNOWN` rollup — which
would let it pass `--strict` with exit 0.

## Why prompt-size bucketing matters

Prefill throughput depends strongly on prompt length, and agent conversations
grow over a session. So an hourly average moves for reasons that have nothing
to do with the server, and a naive before/after comparison manufactures
trends that are not there.

The trend is therefore computed **within a size bucket** (`<5k`, `5-15k`,
`15-30k`, `>30k`), for every bucket with enough samples in both halves of the
window. If none qualifies, it reports that it cannot compare like with like
rather than guessing.

Each bucket is split at **its own** median time, not the global one. That
matters because agent conversations grow, so large prompts arrive late: on a
live 6h journal the `15-30k` bucket had 2 samples before the global midpoint
and 21 after, so the minimum-samples guard dropped it — while it had gone
616 → 73 tok/s. An 8× collapse, invisible, with the report showing a benign
`<5k` at 0.78 and emitting no finding at all. A bucket's own chronology is what
"did this get slower" means for that prompt size.

Findings are based on the **worst** bucket, and the others are named alongside
it. Ranking by sample count instead would hide the problem: on the real
incident window the `>30k` bucket had the most samples and sat at 0.52 (WARN),
while `5-15k` had collapsed to 0.29 (RED). Reporting the fattest bucket
understated the severity and flipped the remedy from *restart the server* to
*watch it* — and a thin bucket collapsing tenfold produced no finding at all.

## Replaying a past incident

`--until` bounds the journal window, which turns the command into a
post-incident tool:

```bash
uap inference health --since "2026-09-20 15:26:52" --until "2026-09-21 09:50:00"
```

```
REPLAY  journal window 2026-09-20 15:26:52 .. 2026-09-21 09:50:00 — live readings below are omitted
RED     findings for that window
  prefill     628 → 205 tok/s ↓ in the 5-15k bucket (n=14/29)
  reuse       20% of the reusable prefix restored (~17,373 tok/turn re-prefilled)

RED     prefill in the 5-15k bucket fell 67% over this process's life (628 -> 205 tok/s); also down in <5k (54%), 15-30k (54%), >30k (49%)
        → restart the inference server; if it returns within days, investigate the prompt cache and idle-slot caching
WARN    checkpoints recover only 20% of the reusable prefix (~17,373 tokens re-prefilled per turn)
RED     5 generation timeout(s) in the window — clients lost work
```

Pass **both** bounds. With `--until` alone the start would otherwise default to
the *currently running* process — which for any past incident is later than the
window's end, so `journalctl` returns nothing and the report is a clean
`UNKNOWN` with no hint that the window was backwards. The default is a relative
`-24h` in that case, but an explicit `--since` is what you want.

In this mode the live readings — uptime, `kv_bpv`, the unit's current flags —
are **dropped, not shown**. They describe the process running *now*, not the
one in the window. An early version did attribute the current
`--ctx-checkpoints 4` to a window in which it had been `1`, and recommended
the wrong remedy as a result.

## Reading the output

```
inference health: uap-gsq-rco-server.service
GREEN   active, up 6m, 2 rail(s)
  pool        229,376 cells shared (114,688/rail if split)
  checkpoints 4 per slot
  kv          8.125 bpv (floor 4.125)
  prefill     682 → 766 tok/s ↑ in the 15-30k bucket (n=12/14)
  reuse       94% of the reusable prefix restored (~2,600 tok/turn re-prefilled)
  concurrency 1.058 busy slots/decode (>1 means the extra rail is actually being used)

  · 2 rails share one 229,376-cell pool (114,688 each if evenly divided)
  no problems detected
```

`pool ... shared` is deliberate wording. With a unified KV cache — which this
fork **forces** whenever VBR runs above one rail, rather than it being a flag
you set — `-c` is one shared pool and **`-np` does not divide it**. `/slots`
reports the full `n_ctx` for every slot and any rail may address all of it. Two rails each
believing they own the pool is an overcommit waiting to happen; the per-rail
figure is what it *would* be if split evenly, not an allowance the server
enforces.

`concurrency` is the honest test of whether an extra rail is earning anything.
A reading of `1.000` means requests never actually overlapped, so the second
rail bought nothing — which is a workload fact, not a server fault.

## Options

| Flag | Meaning |
| --- | --- |
| `--server-unit <unit>` | systemd user unit for the inference server |
| `--proxy-unit <unit>` | systemd user unit for the proxy (timeout counting) |
| `--url <url>` | server base URL (default `http://127.0.0.1:8080`) |
| `--since <expr>` | `journalctl --since` window (default: the server process start) |
| `--until <expr>` | `journalctl --until` bound — replay a past incident |
| `--json` | machine-readable, with a pinned `reportVersion` |
| `--strict` | exit 1 on WARN or RED, for CI and monitor loops |

The default window is **the server process's own start**, because throughput
decay is a property of one process — spanning a restart would manufacture a
cliff at the boundary. When `systemctl` is unavailable and that start time
cannot be read, it falls back to `-24h`. If the window does end up spanning
more than one server process, the report says so (`spans-restart`) rather than
presenting the boundary as decay.

In a replay (`--until`), the live readings are dropped from the analysis too,
not merely hidden — including the unit's current `-np`/`-c`, which describe the
process running now rather than the one in the window. The `shared-pool` line
therefore does not appear in a replay.

## Tuning checkpoints when KV sits at the floor

`kv-at-floor` usually means the pool is saturated — and on this stack a common
cause is the checkpoint allowance, because checkpoints are charged to the SAME
`--vbr-vram` budget as live context, at ~190 MiB each **per slot**:

| `--ctx-checkpoints` | cost across 2 rails | share of a 5120 MiB budget |
| --- | --- | --- |
| 4 | 1520 MiB | 30% |
| 3 | 1140 MiB | 22% |
| 2 | 760 MiB | 15% |

`scripts/set-ctx-checkpoints.sh N` retunes it, backing up the unit and leaving
the comment history intact:

```bash
bash scripts/set-ctx-checkpoints.sh 3        # stage only
bash scripts/set-ctx-checkpoints.sh 3 --now  # stage and restart
```

There is no free direction. Raising it bought checkpoint recovery from 20% to
69% of the reusable prefix on 2026-09-21 — roughly 32k tokens of prefill saved
per turn — and cost KV quality, which settled at the 4.125 floor within six
hours. `uap inference health` reports both sides: `reuse NN%` is the checkpoint
value, `kv N.NNN bpv (floor …)` is the headroom it consumed.

## Related

- [Capacity Policy](CAPACITY_POLICY.md) (`uap doctor`) — liveness and declared
  budgets, including the `budget.execStartMustContain` flag-drift check.
- [Local Models](LOCAL_MODELS.md) — the serving stack itself.
