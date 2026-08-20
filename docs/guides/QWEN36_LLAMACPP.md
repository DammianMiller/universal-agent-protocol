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

## Speculative decoding: DFlash2 is the default

`config/llama-profiles/qwen38-27b-dflash2.env` is the default profile as of
2026-08-20. `qwen38-27b-mtp.env` is kept as the fallback — same model, same
context, same slot count; only the speculative-decoding config differs.

Measured on this card (RTX 3090, sm_86, temp 0, 4 prompts, 1032 tokens per arm,
**same binary across arms** so the spec config is the only variable):

| arm | aggregate tok/s | accept rate | tokens/verify step | |
|---|---|---|---|---|
| no speculation, `-np 1` | 41.3 | — | 1.00 | baseline |
| `draft-mtp` n-max 2, `-np 1` | 59.3 | 93.6% | 2.68 | |
| **DFlash2 n-max 4, `-np 1`** | **68.7** | 67.4% | 3.68 | **1.16×** |
| `draft-mtp` n-max 2, `-np 2` | 66.0 | 92.5% | 2.67 | |
| **DFlash2 n-max 4, `-np 2`** | **89.8** | 66.5% | 3.66 | **1.36×** |

The `-np 2` rows are two *genuinely concurrent* requests — the production shape.
Re-verified end-to-end through `run-llama-server-continuity.sh` with the shipped
profile: **92.6 tok/s**, tool calls parsing, peak 23459 MiB.

**Read `1.36×` as a blend, not a constant.** That run pushed 4 prompts through a
2-slot pool, so the last prompt always finishes alone and the wall covers two
different regimes. Decomposing it from the server's own `launch_slot_`/`release`
timeline:

| regime | `draft-mtp` | DFlash2 n-max 4 | ratio |
|---|---|---|---|
| both slots decoding | 76.4 tok/s | 130.3 tok/s | **1.71×** |
| one request in flight on the 2-slot server | 57.9 tok/s | 60.4 tok/s | **1.04×** |
| the measured 4-prompt burst (what `1.36×` reports) | 66.0 | 89.8 | 1.36× |

So the gain is real but duty-cycle dependent: it is ~1.7× while both slots are
busy and close to nothing when only one request is in flight. Add prompts to the
burst and the headline drifts up toward 1.71×; remove them and it drifts down.
The `-np 1` row above is a `--parallel 1` server, which this service never runs —
for the single-request case on the real 2-slot server use the 1.04–1.2× range,
not 1.16×.

Two caveats on the numbers, both unclosed:

* **Every measurement was taken at `temperature 0.0`**, while this profile serves
  at `LLAMA_TEMP=0.7 / TOP_P=0.8 / TOP_K=20`. Greedy is the most favourable
  setting for speculative decoding, and it flatters a 4-token block more than a
  2-token one, so `1.36×` is an upper bound for the sampling that actually runs.
* **Acceptance is strongly prompt-dependent for DFlash2 and flat for MTP.**
  Across the six prompts ever run, DFlash2 ranged 0.40–0.95 and `draft-mtp` sat
  in a 0.91–0.97 band. The two lowest-acceptance prompts (prose explanation) were
  never run against `draft-mtp`, so the regime where DFlash2 could lose is
  untested. `n-max 7 < n-max 4` is direct evidence that drafting cost dominates
  once acceptance falls.

Two results here are worth keeping, because both contradict what the upstream
material predicts:

* **DFlash2 does not degrade under concurrency on this card — it improves.** The
  PR thread reports throughput collapsing at `-np >= 2`; here the advantage grows
  from 1.16× to 1.36× going from one slot to two. Do not carry that assumption to
  other hardware in either direction; measure it.
* **`n-max 4` beats `n-max 7`** (76.7 vs 69.8 tok/s), even though n-max 7 accepts
  a longer block (4.86 vs 3.87 tokens/step). Acceptance falls from 72% to 55% as
  the block lengthens, so the extra drafting outruns what it buys. The drafter
  card's published acceptance length of 5.39 is real but is not the throughput
  optimum.

### The cost, and when to roll back

Peak VRAM in the production shape is **23459 / 24576 MiB — about 1.1 GiB free**.
There is **no paired measurement of `draft-mtp` taken the same way**, so treat the
drafter's marginal cost as un-measured rather than as the ~0.8 GiB the weights
imply: the table above reports ~0.95 GiB free for `draft-mtp` at this same tier,
which cannot both be true and leave DFlash2 roomier. Re-measure both profiles
with one harness before relying on either figure. Note also that 23459 was
sampled with `nvidia-smi` on a 1 s loop over a ~10 s run whose longest prefill
was 540 tokens — it never exercised a long-context prefill on two slots, which is
the real peak event at 131072/slot. The drafter's weights (Q4_K_M,
1.1 GB) are essentially the whole difference: its KV cache stays around 80 MiB
because it carries its own 2048-token sliding window rather than scaling with the
target's 131072/slot. That is what lets this fit without cutting context or slots
— and it is why `LLAMA_DRAFT_CTX_SIZE` must stay unset.

This card has a history of *global* kernel OOM events selecting this service for
its RSS. The GPU side is now thinner too. **If the server starts failing to load
or dying, switch `~/.config/uap/llama-server.env` back to `qwen38-27b-mtp.env`
before changing anything else** — that is what the fallback profile is for.

### The engine is an unmerged PR

[llama.cpp#27342](https://github.com/ggml-org/llama.cpp/pull/27342) is **open**.
The build is a cherry-pick of `5ecbe1ac1` onto `f466cfa38` (zero conflicts),
vendored as `config/llama-patches/dflash2-pr27342.patch` so it is reproducible if
the build worktree is lost. The merged `draft-dflash` **v1** engine cannot
substitute: a v2 checkpoint declares the same `general.architecture = "dflash"`,
so auto-detect selects `draft-dflash` and then fails on the 23 conv/selector
tensors and `dflash.conv_*` / `dflash.selector_*` metadata keys v1 has no loader
for. Return to plain upstream master once the PR lands.

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
