# Qwen3.6 35B-A3B on llama.cpp, by VRAM tier — with UAP

> **🏭 Where this fits:** BUILD — this is the station where a one-shot local
> model breaks: it flails on a non-trivial change, emits plausible-but-wrong
> code, or stalls. **What it delivers:** a copy-paste local stack (8–32 GB GPU)
> where `uap deliver` drives the model against your real gates until the change
> is *verified* — a cheap, on-your-own-hardware model that punches above its
> weight.

This is the recommended local stack for UAP: **Qwen3.6 35B-A3B** (a Mixture-of-
Experts model with only **~3B active parameters** per token) served by
**llama.cpp**, driven by **UAP's automatic features** — above all `uap deliver`,
which iterates the model against your real build/test gates until the change is
*verified*. That convergence loop is the station that keeps a small, cheap,
local model on the rails and lets it **punch well above its weight**: one-shot
it would flail; driven to green it delivers. (This is the BUILD stage of your
[delivery pipeline](./DELIVERY_PIPELINE.md) — the point where naive agentic
workflows ship stubs.)

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
  --jinja \                     # enable chat-template-driven tool calls (REQUIRED)
  --chat-template-file tools/agents/config/qwen-sharp.jinja \
  --parallel 1
```

> **`--jinja` plus an explicit `--chat-template-file` is non-negotiable for agent
> use.** Qwen emits tool calls only when a chat template is active, and `--jinja`
> alone uses the model's *embedded* template — which still hard-raises
> `'System message must be at the beginning.'`, breaking any request where UAP's
> memory or context-injection layers add a system message mid-conversation. Always
> pass `--chat-template-file` (see
> [Chat template: `qwen-sharp.jinja`](#chat-template-qwen-sharpjinja-all-qwen-models)).
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

## Measured: Qwen3.8-27B (dense) + native `draft-mtp`, RTX 3090 24 GB

Production switched 2026-08-20 to a **dense** qwen35-arch model
(`Qwen3.8-27B-UD-IQ4_XS.gguf`, ~13.3 GiB on disk) with a **native MTP head
baked into the checkpoint** (`blk.64.nextn.*` tensors) — no separate
`*-MTP.gguf` or `-md` draft file needed; `--spec-type draft-mtp` reads the
head straight from `--model`. Built at llama.cpp master (`f466cfa38`,
2026-08-20). See `config/llama-profiles/qwen38-27b-mtp.env` for the full
resolved profile.

Measured VRAM on this card (`q4_0`/`q4_0` KV, `-ngl 99`, `--parallel 2`,
`--flash-attn on`, no vision projector):

| Per-slot ctx (`--ctx-size` total) | VRAM used | VRAM free | Notes |
|---|---|---|---|
| 65536 (`131072` total) | ~19.8 GiB | ~4.3 GiB | Comfortable headroom. |
| 131072 (`262144` total) | ~23.15 GiB | ~0.95 GiB | Verified stable under 2 concurrent long-generation requests (60-91% draft acceptance, no OOM), but headroom is thin on a 24 GiB card with a history of kernel OOM-kills reaping this service under unrelated host memory pressure. If instability appears under real concurrent load, drop back to 65536/slot first. |

Doubling `--ctx-size` roughly doubles KV cache size, not the model footprint
(weights stay fixed at ~13.3 GiB) — so the free-VRAM gap shrinks fast once
weights + KV together approach the card's total. Always re-check
`nvidia-smi`/`/props` after raising ctx on this card rather than assuming the
previous tier's headroom scales.

## Chat template: `qwen-sharp.jinja` (all Qwen models)

Every Qwen launch path here runs
[`tools/agents/config/qwen-sharp.jinja`](../../tools/agents/config/qwen-sharp.jinja),
vendored verbatim from
[peculiar-ragdoll/Qwen-Sharp-Chat-Templates](https://huggingface.co/peculiar-ragdoll/Qwen-Sharp-Chat-Templates)
(`template_version` `qwen3.8-froggeric-v22.1`, upstream revision
`3dc34df52c63dd22ada21f96435e069deaa8d7da`). It targets Qwen 3.5 / 3.6 / 3.8 and
replaced `qwen3.5-enhanced.jinja` on 2026-08-20. The file's sha256 is asserted in
`test/chat-template-system-message.test.ts`, so a silent re-vendor from a changed
upstream fails CI rather than quietly changing the prompt contract.

### What it fixes

`qwen3.5-enhanced.jinja` hard-raised `'No user query found in messages.'` — a
server-side failure for the entire request — whenever its backwards scan found no
user turn that wasn't a `<tool_response>`. Two shapes that occur in ordinary agent
loops trigger it: a continuation whose only user turns are tool results, and a
`system`+`assistant` transcript with no user turn at all. `qwen-sharp` renders both.

This is *not* the mid-conversation-system-message case — both templates always
handled that. Earlier notes in this repo attributed the raise to the wrong cause.

### What stays compatible

Verified by rendering both templates over a fixture table and diffing the output,
not by reading the source:

* the tool-call contract the model is instructed to **emit** is unchanged —
  `<tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>`,
  which `anthropic_proxy.py`'s `_HERMES_FUNCTION_RE` / `_TOOL_CALL_XML_RE` parse
  unchanged;
* the generation prompt matches the old template in **both** `enable_thinking`
  states, so `--reasoning auto --reasoning-format deepseek` is unaffected;
* a mid-conversation system message renders inline in both.

The template ships **both** a JSON and an XML tool-call emitter and picks one at
render time via `_tool_format`. That is why the tests assert on rendered output: a
grep for the XML emitter's source passes even if the default flips to JSON and
every tool call on the box silently changes wire format.

### What actually differs — known and accepted

* **History whitespace.** Replaying a *prior* tool call with string-form
  `arguments` (the proxy's path — it `json.dumps` them) emitted `}\n</function>`
  before and `}</function>` now; the separator between two tool calls in one
  assistant turn went `\n` → `\n\n`. Neither changes what the parsers accept.
* **The injected tool-calling instruction block was rewritten upstream.** It now
  requires a `<think>` block before each tool call and forbids prose before the
  call. Behavioural and deliberate, but it is more than a formatting change.
* **A system message containing an image now raises.** Unreachable through the
  proxy, which flattens `system` to a text string before dispatch; direct-to-`:8080`
  OpenAI clients can hit it.
* **Unknown message roles no longer raise** — they render as `[role]: content`.
  A malformed request now proceeds quietly where it used to fail loudly.
* **Prior `<think>` blocks are retained across turns.** Upstream sells this as a
  prompt-cache win. On the proxy path it is a **no-op**: the proxy already strips
  `<think>` from prior assistant turns on purpose ("Stripping breaks the copy
  cycle"). On the direct path it re-introduces exactly that cycle — pass
  `chat_template_kwargs.preserve_thinking=false` there if it shows up.

`chat_template_kwargs.reasoning_effort` accepts
`none|minimal|low|medium|high|xhigh|max`; note `none` forces thinking off,
overriding `enable_thinking=true`.

Do **not** switch a Qwen profile to `embedded` — the model's own baked-in template
still carries the `'System message must be at the beginning.'` raise.

## Speculative decoding: what is running, and DFlash2

Running today: `--spec-type draft-mtp`, reading the MTP head baked into `--model`
(no drafter file). At `--spec-draft-n-max 2` a verification step accepts at most 3
tokens; measured draft acceptance is 60-91%.

**DFlash2 exists, fits this card at the current context tier, and is not
installed.** Measured 2026-08-20 on the RTX 3090, holding `--parallel 2` and
131072 ctx/slot fixed:

| | |
|---|---|
| Engine | [llama.cpp#27342](https://github.com/ggml-org/llama.cpp/pull/27342), **open, not merged**. One commit (`5ecbe1ac1`, ~676 LOC). Cherry-picks onto our build commit `f466cfa38` with **zero conflicts** — our tree is 29 commits ahead of the PR base — and builds clean for `sm_86`. |
| Drafter | [z-lab/Qwen3.8-27B-DFlash2-GGUF](https://huggingface.co/z-lab/Qwen3.8-27B-DFlash2-GGUF), built for this exact target. Q4_K_M 1.1 GB / Q8_0 2.0 GB. Published acceptance length 5.39 / 5.13. |
| Why v1 can't be used instead | The merged `draft-dflash` v1 engine cannot load a v2 checkpoint. Both declare `general.architecture = "dflash"`, so auto-detect selects `draft-dflash` and then fails: the v2 GGUF carries 23 conv/selector tensors and `dflash.conv_*` / `dflash.selector_*` metadata keys v1 has no loader for. A rebuild is mandatory; there is no config-only path. |

VRAM, the constraint that decides it. The drafter is 5 layers with its **own 2048
sliding window**, so its KV cache is ~80 MiB at f16 regardless of the target's
131072 — the cost is essentially just weights:

| | measured / computed |
|---|---|
| Free VRAM at 131072/slot, `--parallel 2` | ~1.9 GiB (`nvidia-smi`: 22607 / 24576 MiB) |
| Q4_K_M drafter (weights + KV + buffers) | ~1.25 GiB → **fits**, ~0.7 GiB margin |
| Q8_0 drafter | ~2.1 GiB → does not fit at this tier |

So it does not require dropping context or slot count. The open question is
throughput, not memory: the PR's own reviewers report degradation at `-np >= 2`
— the setting this box runs — and the headline 5.x acceptance figures are
single-stream on Blackwell / Apple M5, not `sm_86`. The honest test is a paired
A/B at fixed `-np 2` and 131072/slot against `draft-mtp` as configured today.
Until that measurement exists, `draft-mtp` stays.

> Note: the VRAM table under *Measured: Qwen3.8-27B* below was recorded from
> llama.cpp's own buffer accounting (~0.95 GiB free); the ~1.9 GiB here is
> `nvidia-smi` free memory on the whole card. They measure different things —
> use the smaller one for headroom decisions.

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
