# Qwen3.8-27B on exllamav3 (EXL3) — the production serving stack

> UAP v1.224.7 — added 2026-09-04, the day the box switched over.

Since 2026-09-04 the production local model is served by **exllamav3**
(MiaAI-Lab fork 1.4.2), not llama.cpp: **Qwen3.8-27B EXL3 3.5bpw** (14.2 GB,
workload-calibrated) with a **DFlash2 EXL3 5.0bpw** draft model (1.4 GB) for
speculative decoding. The recipe comes from yume_arasaki's RTX 4090 write-up
and the Mia-AiLab quant cards, adapted for this box's RTX 3090.

The llama.cpp stack (binary, `config/llama-profiles/`, `uap-llama-server`
unit) is untouched and remains the **rollback path** — see the bottom of this
doc.

## Why switch

| | llama.cpp (UD-IQ4_XS GGUF) | exllamav3 (EXL3 3.5bpw) |
|---|---|---|
| decode, short ctx, warm | ~55 tok/s (measured essay probe) | **~82 tok/s** (same probe) |
| decode, deep into a long ctx | similar falloff | ~41–51 tok/s (KV grows) |
| context | 131072 per slot, `--parallel 1` | 131072 per request, batch-1 + queue |
| VRAM | ~21.9 GB resident | 20964 MiB resident |
| tool calling | jinja template + grammar | native OpenAI-style, verified |
| model id handling | `--alias` list, std::set-ordered | accepts any client-sent id |

## The 3090 adaptation (read before copying the 4090 recipe)

The article's `CACHE_QUANT=nvfp4` (and `fp8`) **does not compile on this
box**: those Triton kernels need compute capability ≥ 8.9 (Ada/Hopper). The
RTX 3090 is Ampere, **sm_86 — compute capability is fixed in hardware**, no
driver or toolkit update changes it. The equivalent-density fallback is
`CACHE_QUANT=4` (Hadamard int4, same ~4.5 bits/element), which is what runs.

Second 3090 gotcha: the kit's default torch index (cu130) cannot compile the
engine's CUDA kernels against this box's nvcc 12.4 — `TORCH_INDEX_URL` is
pinned to `cu124` in the kit `.env`.

## Layout

Everything lives outside the repo at `/home/cogtek/Qwen3.8-EXL3-kit/`:

```
Qwen3.8-EXL3-kit/
├── .env                  # the config (PORT, CONTEXT_SIZE, CACHE_QUANT, …)
├── start.sh / stop.sh    # launcher (bootstraps venv on first run)
├── models/
│   ├── Qwen3.8-27B-EXL3-3.5bpw/          # target, 15 GB
│   └── Qwen3.8-27B-DFlash2-EXL3-5.0bpw/  # draft, 1.4 GB
├── .venv/                # torch 2.6.0+cu124, exllamav3 fork 1.4.2, triton 3.3.1
└── tools/
    ├── serve_openai.py   # OpenAI-compatible server (+ local shim, below)
    ├── healthcheck.py    # start.sh's venv gate (local addition)
    └── tokps.sh          # live tok/s monitor: tools/tokps.sh [interval] [port]
```

A reference copy of the `.env` is versioned at
[`config/exl3-profiles/qwen38-27b-exl3.env`](../../config/exl3-profiles/qwen38-27b-exl3.env).

## Local patches in the kit (reapply if the kit is re-cloned)

1. **`triton_paged.py` parenthesization** — the fork's jit kernel used chained
   boolean operators (`A and not B and not C`) that current Triton rejects;
   lines ~1698/1719 parenthesized to `A and (not B and not C)`.
2. **`torch.compile` → identity shim** in `tools/serve_openai.py` — the fork's
   Hadamard-4 KV path needs triton ≥ 3.3 (`ASTSource(constexprs=…)`), but
   torch 2.6's inductor imports `AttrsDescriptor`, which triton 3.3 removed,
   so fla's import-time `@torch.compile` decorators exploded the import chain.
   Nothing on the serving hot path uses inductor (the speed comes from
   hand-written Triton kernels), so the shim falls back to the undecorated
   function. torch 2.7 was not an option: no cu124 wheels.
3. **`tools/healthcheck.py`** — start.sh gates its bootstrap on a bare
   `import torch, exllamav3, aiohttp, huggingface_hub`, which fails for the
   reason in (2) and re-entered setup, downgrading triton back to 3.2 (torch's
   pin) and breaking the engine again. The health check now applies the same
   shim, so bootstrap runs only when the venv is genuinely incomplete.

Do **not** "fix" the triton version to match torch's pin: torch 2.6.0 asks
for triton 3.2.0, but the engine fork requires ≥ 3.3. The pair
(torch 2.6.0+cu124, triton 3.3.1, shim) is the working combination; pip will
keep printing a dependency-conflict warning about it — that warning is the
price of admission, not a problem.

## Service management

```bash
systemctl --user status uap-exl3-server    # enabled, Restart=always
journalctl --user -u uap-exl3-server -f    # live log
/home/cogtek/Qwen3.8-EXL3-kit/tools/tokps.sh   # live tok/s
```

Unit: `~/.config/systemd/user/uap-exl3-server.service` → kit `start.sh`.
The server binds `0.0.0.0:8080` (the port every client config already points
at) and reports `max_model_len=131072` at `/v1/models`.

**Proxy rails unchanged and still correct:** `PROXY_CONTEXT_WINDOW=131072`
(exllamav3's `--cache_size` is per-request, matching llama.cpp's per-slot
131072 at `--parallel 1`) and `PROXY_CONCURRENCY_LIMIT=1` (the EXL3 server is
batch-1 and serializes concurrent callers internally — same shape as the
1-slot llama.cpp config these rails were last tuned for). The server's
`/v1/models` id is `qwen3.8-27b-exl3-3.5bpw-wm`, but it accepts any
client-sent model id, so presets (`qwen3.8-27b`, etc.) flow through
unmodified.

## Rollback

```bash
systemctl --user stop uap-exl3-server
systemctl --user enable --now uap-llama-server   # unit + env + binary untouched
```

The llama.cpp env (`~/.config/uap/llama-server.env` →
`config/llama-profiles/qwen38-27b-dflash2.env`) and the ik/DFlash2 binary are
exactly as they were; the service was only `disable`d so it stops competing
for VRAM and port 8080 on boot.

## What's next: Qwen3.8-Flash-Next as the 27B replacement (2026-09-09)

Status: **evaluation in progress** — downloads and the llama.cpp-path bench
are done; the EXL3-path bench and quality gates are pending. This section is
the running analysis and updates as measurements land.

### The model

Qwen3.8-Flash-Next ("A Preview of the Qwen4 Architecture" per the GGUF
metadata) is a hybrid linear-attention MoE, a generation ahead of the dense
27B:

- 48 layers; **gated-delta SSM layers with a full-attention layer every
  4th** (`full_attention_interval = 4`), so only 12 layers hold KV
- **512 experts per layer, 10 active + shared**; hidden 2560; card size
  label `512x56B` (125B-A6B class)
- **MTP head + PLE trigram table built in** — the ngram embedding table
  alone is 26.2 GB bf16 in the EXL3 checkpoints
- **Vision-capable** (the 27B is text-only)
- Native context **262144**

### What changed on 2026-09-08 (joaosump's quant comparison)

[@joaosump's bench thread](https://x.com/joaosump/status/2097225621621338408)
(turboderp EXL3 quants, single RTX 3090):

- **4bpw KLD is excellent**, and both 4bpw and 5bpw are usable on a single
  3090 — so the 2bpw class is a speed experiment, not the serving quant.
- Thread corroboration: the **2bpw already sustains 2-hour agentic runs at
  67–68 t/s with working tool calling**; the earlier "2bpw breaks tool
  calling" report traced to exllamav3 template parsing, not the quant —
  consistent with what we saw wiring `qwen-sharp.jinja`.
- Caveat worth respecting (AIQuanting in-thread): KLD averages over every
  token and most tokens are easy. The number that matters for code is
  **top-token flips where the unquantized model was confident** — so the
  4bpw decision still needs our own quality bench, not just KLD.

### Local state (verified 2026-09-09)

| Artifact | Path | Size | Status |
|---|---|---|---|
| GGUF UD-IQ3_XXS (~3bpw) + MTP sidecars | `~/models/flash-next/` | 82 GB + MTP | benched (below) |
| EXL3 2.05bpw_h4_ng4 (turboderp) | `~/models/flash-next-exl3/2.05bpw/` | 62.5 GB (26.2 GB is the PLE table) | load-tested only |
| EXL3 4.05bpw_h6_ng6 (turboderp) | `~/models/flash-next-exl3/4.05bpw/` | ~95 GB expected | downloading |
| Bench harness (`bench.py`, `bench_exl3.py`) | `~/dev/flash-next-bench/` | — | working |
| Serving kit (EXL3 copy) | `~/Qwen3.8-FlashNext-EXL3-kit/` | — | staged, not yet configured |

### Measured: GGUF path (buun-llama-cpp 40262a4, VBR KV, MTP drafting)

Same probe style as the 27B numbers above (unique random prefix per run,
temperature 0, 128-token decode):

| prompt depth | prefill t/s | decode t/s |
|---|---|---|
| ~2k (cold MoE cache) | 178 | 21.6 → 46.7 |
| ~2k (warm) | 253–279 | 51.5–64.2 |
| ~32k | 231 | 54.1 |
| ~92k | 195–203 | 34.9 |

MTP draft acceptance 0.851 (mean len 2.70). Memory at 92k ctx: 7.4 GB VRAM
resident + 16.5 GB MoE expert cache on the card, 77.5 GB host RAM — this is
a **CPU-offload model on a 24 GB card**; the 5950X's 124 GB RAM is the
second tier. MoE cache hit rate 80%.

### The honest comparison vs the 27B EXL3 stack

- **Decode: comparable.** 51–64 t/s warm at short ctx (27B: ~82), 54 t/s at
  32k (27B: ~41–51 deep), 35 t/s at 92k. For agent loops Flash Next is
  roughly at parity, with a much newer, much larger model behind it — plus
  vision.
- **Prefill: the gap.** ~180–280 t/s against the dense, fully GPU-resident
  27B. A 64k-token session turn is **4–7 minutes of prefill**, which is
  exactly why the proxy grew thinking deltas (#785) and the guarded/prefill
  heartbeats (#787, #788) — those rails are load-bearing for this model,
  not optional.
- **Memory economics flip.** The 27B is ~21 GB VRAM and negligible RAM;
  Flash Next is ~8 GB VRAM + ~78 GB RAM. Combined they exceed the card, so
  this is a **replacement, not a side-by-side** — the 27B EXL3 service stays
  down while Flash Next is under test.

### Plan

1. Finish the 4.05bpw download, then configure the FlashNext-EXL3-kit. The
   3090 adaptations above carry over unchanged (`CACHE_QUANT=4`, cu124 torch
   pin, triton 3.3.1 + `torch.compile` shim); the kit already demonstrated
   CPU split-expert offload (experts 224–512 of 512 per layer on CPU, avx2,
   32 threads) on the 2.05bpw load test.
2. Re-run `bench_exl3.py` at 2k/32k/92k on 4.05bpw; compare against the
   GGUF rows above and the 27B table at the top.
3. Quality gate before any switch: tool-call suite plus a real `uap deliver`
   session — per the KLD caveat, top-token-flip behavior on code is the
   deciding metric, not averages.
4. The 27B EXL3 stack stays production until (2) and (3) pass; rollback
   stays as documented above.
