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
