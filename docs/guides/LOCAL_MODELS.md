# Running UAP Against Local Models

> UAP v1.163

> **🏭 Where this fits:** BUILD — this is the station where a cheap local model
> flails: plausible-but-wrong code, empty output, or a loop that never lands a
> real change. **What it delivers:** the proxy and the convergence loop keep a
> small, zero-per-token model on the rails so it produces *verified* code
> instead of stubs — real results on a GPU you already own.

Here's the pain: you *want* to run your agent on a local model — inference on
your own hardware, zero per-token cost — but on its own a small quantized model
rarely nails a non-trivial change. It one-shots something that looks right and
doesn't compile.

Here's the fix: UAP drives its coding/convergence loop against **local models**
served by [llama.cpp](https://github.com/ggml-org/llama.cpp) instead of a hosted
API. The loop iterates the model against your real gates until the change is
verified — that's what turns a modest open-weight model such as Qwen 3.x into a
productive station on your [delivery pipeline](./DELIVERY_PIPELINE.md).

> **Just want the recommended local setup?** See
> [Qwen3.6 35B-A3B on llama.cpp, by VRAM tier](QWEN36_LLAMACPP.md) for
> copy-paste launch commands for 8 / 12 / 16 / 24 / 32 GB GPUs, and how
> `uap deliver` uplifts a small local model to *verified* results.

There are two endpoint shapes involved, and it matters which client speaks
which protocol:

- **`uap deliver`** talks the **OpenAI-compatible** Chat Completions API
  (`POST /v1/chat/completions`). It points directly at llama.cpp's OpenAI
  endpoint (commonly `:8080/v1`) — no translation proxy is needed for UAP's own
  loop. See
  [`src/models/openai-compat-client.ts`](../../src/models/openai-compat-client.ts).
- **Anthropic-protocol clients** (e.g. Claude Code) speak the **Anthropic
  Messages API**. When llama.cpp serves the Anthropic protocol natively, those
  clients can point straight at the local port. Where native Anthropic serving
  is not available, the bundled `uap-anthropic-proxy` translates Anthropic
  requests into OpenAI requests for llama.cpp. Prefer the direct, native path
  when you have it.

## The model presets

`uap deliver` selects a model by **preset id**. Presets are defined in
[`src/models/types.ts`](../../src/models/types.ts) (`ModelPresets`). The default
local preset is `qwen35-a3b`:

```jsonc
// qwen35-a3b (excerpt)
{
  "provider": "custom",
  "apiModel": "qwen35-a3b-iq4xs",
  "endpoint": "http://192.168.1.165:8080/v1",  // llama.cpp OpenAI endpoint
  "maxContextTokens": 262144
}
```

The endpoint is the llama.cpp server's OpenAI-compatible base. Adjust it for
your host (for example `http://localhost:8080/v1`) by overriding the endpoint
(see below) or editing the preset.

> The exact host/IP in the shipped preset is environment-specific. Point it at
> wherever your llama.cpp server is listening.

## Serving a local model

Start llama.cpp's `llama-server` listening on an OpenAI-compatible port
(`:8080` by default in the helper scripts). A continuity helper for serving is
included at
[`scripts/run-llama-server-continuity.sh`](../../scripts/run-llama-server-continuity.sh);
it wraps `llama-server` with `--host`, `--port` (default `8080`), `--model`,
and an optional `--chat-template-file`. Models with a custom chat format need
the correct template applied.

UAP ships several helpers around local serving (registered as bins in
`package.json`):

- **`llama-optimize`** — generates optimal `llama.cpp` startup parameters
  (quantization profile, KV-cache quant, flash attention, speculative
  decoding, etc.) for Qwen 3.x-class models on 16GB/24GB VRAM. Source:
  [`src/bin/llama-server-optimize.ts`](../../src/bin/llama-server-optimize.ts).
- **`uap-template-verify`** — model-agnostic chat-template finder/verifier;
  validates Jinja2 syntax, renders test data, and checks tool-call format
  support. Source:
  [`tools/agents/scripts/chat_template_verifier.py`](../../tools/agents/scripts/chat_template_verifier.py).
- **`uap-anthropic-proxy`** — Anthropic→OpenAI translation proxy for clients
  that only speak the Anthropic Messages API. Source:
  [`tools/agents/scripts/anthropic_proxy.py`](../../tools/agents/scripts/anthropic_proxy.py).
  It reads `LLAMA_CPP_BASE` (upstream OpenAI endpoint) and `PROXY_PORT` from the
  environment. Use this only when a client can't reach a native Anthropic
  endpoint.

## Running the convergence loop locally

`uap deliver` iterates a model through execute → apply → verify → feedback until
real completion gates pass. To run it against a local model, pass the preset:

```bash
uap deliver "fix the failing build" --model qwen35-a3b
```

Because `qwen35-a3b` is the default preset, you can also omit `--model` (or set
`UAP_DELIVER_MODEL`):

```bash
export UAP_DELIVER_MODEL=qwen35-a3b
uap deliver "add input validation to the parser"
```

### Pointing at your own server

Override the endpoint without touching the preset:

```bash
uap deliver "refactor the auth module" \
  --model qwen35-a3b \
  --endpoint http://localhost:8080/v1
```

The endpoint must be an OpenAI-compatible `/v1` base. If no endpoint is set on
the preset or the flag, the client falls back to `UAP_INFERENCE_ENDPOINT`, then
to `http://localhost:4000/v1`.

### Useful `uap deliver` options

| Option              | Meaning |
| ------------------- | ------- |
| `-m, --model <preset>` | Model preset id (default `$UAP_DELIVER_MODEL` or `qwen35-a3b`) |
| `--endpoint <url>`  | Override the model endpoint (OpenAI-compatible `/v1`) |
| `--temperature <t>` | Sampling temperature (default: execution-profile value) |
| `--max-turns <n>`   | Maximum execute→verify iterations (default 5) |
| `--gates <ids>`     | Restrict to a subset of gates (`build,typecheck,test,lint`) |
| `--escalate` / `--escalate-model <preset>` | On stagnation, escalate to a stronger model preset (default `$UAP_ESCALATE_MODEL`) |
| `--coordinate`      | Register the run with the coordination layer (announce, heartbeat, overlap detection) |
| `--deploy`          | On success, queue a commit of applied files into the deploy batcher |
| `--dry-run`         | Show detected gates and plan without calling the model |

A common local pattern is a cheap local executor that escalates to a **stronger,
distinct** model only when it stalls. This distinction matters: a same-model
judge (a local model grading its own output) was measured to add no lift —
escalation only pays off when the model you escalate *to* is genuinely more
capable than the one that stalled.

```bash
uap deliver "implement the retry logic" \
  --model qwen35-a3b \
  --escalate --escalate-model sonnet-4.6
```

## Connecting Claude Code (or other Anthropic clients)

If your llama.cpp server exposes the Anthropic Messages API natively, point the
Anthropic client at that local port directly — this is the preferred path.

Otherwise, run the translation proxy in front of llama.cpp:

```bash
LLAMA_CPP_BASE=http://localhost:8080/v1 PROXY_PORT=4000 uap-anthropic-proxy
```

The client then talks the Anthropic protocol to the proxy, which forwards
OpenAI requests to llama.cpp. The proxy supports streaming and tool-call
translation.

For the full picture — the `uap proxy` lifecycle, the reliability guardrails
that keep a small model from wedging, security, and serving recipes — see the
**[Inference Proxy guide](PROXY.md)**.

## Related

- [Deploy Batching](./DEPLOY_BATCHING.md) — what `uap deliver --deploy` queues.
- [Coordination](./COORDINATION.md) — what `uap deliver --coordinate` registers.
