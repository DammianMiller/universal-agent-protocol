# Qwen3.6 35B-A3B on llama.cpp, by VRAM tier — with UAP

This is the recommended local stack for UAP: **Qwen3.6 35B-A3B** (a Mixture-of-
Experts model with only **~3B active parameters** per token) served by
**llama.cpp**, driven by **UAP's automatic features** — above all `uap deliver`,
which iterates the model against your real build/test gates until the change is
*verified*. That convergence loop is what lets a small, cheap, local model
**punch well above its weight**: one-shot it would flail; driven to green it
delivers.

Because the active footprint is ~3B, this model runs usefully even on modest
GPUs by **offloading the (sparse, mostly-idle) expert tensors to system RAM**
while keeping attention on the GPU. The knob for that is `--n-cpu-moe`.

## Get the model

A 4-bit quant is the sweet spot for coding (quality vs. size). The full weights
are ~18–19 GB at IQ4_XS:

```
Qwen3.6-35B-A3B-UD-IQ4_XS.gguf        # ~18–19 GB on disk
# (a *-MTP.gguf build adds multi-token prediction for faster decode — use it if you have it)
```

## The base llama-server command

UAP speaks the OpenAI-compatible endpoint, so serve on `:8080/v1`. The flags
below are the ones that matter; the per-tier table just changes `--n-cpu-moe`,
`--ctx-size`, and the KV-cache type.

```bash
llama-server \
  --model Qwen3.6-35B-A3B-UD-IQ4_XS.gguf \
  --host 0.0.0.0 --port 8080 \
  --gpu-layers 99 \              # put all layers on GPU; experts get pulled back by --n-cpu-moe
  --n-cpu-moe   <PER TIER> \     # how many layers keep their MoE experts in CPU RAM
  --ctx-size    <PER TIER> \
  --cache-type-k <q4_0|q8_0> --cache-type-v <q4_0|q8_0> \   # quantize KV cache to save VRAM
  --flash-attn on \             # faster + less VRAM
  --jinja \                     # use the model's chat template (REQUIRED for tool calls)
  --parallel 1
```

> **`--jinja` / the chat template is non-negotiable for agent use.** Qwen3.6
> emits *native* OpenAI tool calls, but only when its chat template is active.
> If tools silently never fire, that's the cause — run `uap tool-calls setup`
> to install/repair the template, and `uap tool-calls status` to check.

## VRAM tiers

Values are **starting points** — exact `--n-cpu-moe` depends on your build and
layer count. Rule of thumb: **raise `--n-cpu-moe` if you OOM, lower it for more
speed.** "System RAM" is what the offloaded experts need *in addition* to the
GPU.

| VRAM | `--n-cpu-moe` | `--ctx-size` | KV cache | System RAM | What to expect |
|---|---|---|---|---|---|
| **8 GB** | `99` (all experts → CPU) | `8192` | `q4_0` | ≥ 32 GB | Attention on GPU, all experts on CPU. Decode is CPU-bandwidth-bound (a few tok/s) — slow but *real*. `uap deliver` makes it productive by driving to verified completion instead of needing a strong one-shot. |
| **12 GB** | `~36` | `16384` | `q4_0` | ≥ 32 GB | Keep ~the top experts on GPU, rest on CPU. Noticeably faster than 8 GB. |
| **16 GB** | `~24` | `24576` | `q4_0` | ≥ 24 GB | Roughly half the experts on GPU. Comfortable for most coding tasks. |
| **24 GB** | *omit* (full model on GPU) | `32768`–`65536` | `q8_0` | 16 GB | **Sweet spot** (RTX 3090/4090). Weights + KV fit on-GPU; use `q8_0` KV for quality, `q4_0` if you want more context. Add `--flash-attn on`. |
| **32 GB** | *omit* | `131072` | `q8_0`/`f16` | 16 GB | Full model + large context. Add `--parallel 2–4` for concurrent sessions, bump `--batch-size`/`--ubatch-size`. |

Speed extras (any tier): `--flash-attn on` (always), and if your build supports
it, **self-speculation / MTP** (the `*-MTP.gguf` model, or `--draft-*` flags with
a tiny draft model) for materially faster decode.

## Point UAP at it

```bash
# 1) Tell UAP where the model lives (OpenAI-compatible endpoint)
export UAP_INFERENCE_ENDPOINT="http://localhost:8080/v1"
#    (or set the endpoint on the model preset in .uap.json / src/models/types.ts)

# 2) Make sure tool calls work
uap tool-calls setup        # install the chat template + helpers
uap tool-calls status       # verify

# 3) That's it — code as normal. Everything is automatic from here.
```

Once installed, **you don't run `uap deliver` by hand** — delivery enforcement
is on by default, so when your agent goes to implement something it's routed
through the convergence loop automatically (see
[What UAP Does For You, Automatically](AUTOMATIC.md)). If you *want* to drive a
task explicitly:

```bash
uap deliver "implement a token-bucket rate limiter with tests"
```

## Why this punches above its weight

A 3B-active model rarely nails a non-trivial change in one shot. UAP changes the
game without changing the model:

- **`uap deliver`** loops execute → run-the-gates → fix → re-run until build,
  type-check, and tests all pass — turning "plausible" into "verified".
- **Pattern RAG + expert routing** (automatic) put the right approach and the
  right specialist persona in front of the model before it starts.
- **Memory** stops it re-making the same mistakes across turns and sessions.
- **Worktree + completion gates** keep every attempt isolated and only let
  "done" mean *actually done*.

Net effect: a local, zero-per-token, 4-bit MoE model produces verified results
that a naive one-shot of a much larger model often won't — and it runs on a GPU
you already own.

See also: [Local Models](LOCAL_MODELS.md) · [`uap deliver`](DELIVER.md) ·
[Automatic features](AUTOMATIC.md).
