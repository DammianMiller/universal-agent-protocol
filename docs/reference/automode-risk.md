# AutoMode Pre-Execution Risk Classification

Uplift 1.3. Every outbound `tool_use` block is risk-classified **before the
client dispatches it**, ahead of — and never instead of — the deterministic
verb/regex enforcers in `src/policies/enforcers/`.

## Design

The scorer is `tools/agents/scripts/tool_risk.py`:

```python
classify_tool_call(tool_name: str, tool_input: dict) -> RiskAssessment
```

`RiskAssessment` is a frozen dataclass: `risk_class`, `risk_score` (1–5),
`signals` (every rule that fired, formatted `name:class+weight` — every
point of score is attributable to a named signal), `latency_ms`. The
function is **pure**: no I/O, no globals, same input → same output.

This is the Python-side calibrated heuristic floor for AutoMode. Its
vocabulary is *inspired by* the unmerged TypeScript SYS1 baseline
(`src/classify/baseline.ts` on `feature/301-sys1-classifier`) — not ported:
the TS baseline scores prose state descriptions, this scorer parses shell
structure, so the domains and machinery genuinely differ and "cross-stack
parity" would overclaim. The promotion path is a **Python-resident head (or
sidecar) behind the same `classify_tool_call` contract**, gated by the
calibration harness at held-out destructive recall 1.0 — when it lands, the
wiring, harness, and doctrine below do not change.

### Classes

| class | meaning | examples |
|---|---|---|
| `destructive` | irreversible / wide blast radius | `rm -rf`, `DROP TABLE`, `TRUNCATE`, `git push --force`, `git reset --hard`, `dd of=/dev/…`, `mkfs`, `chmod -R 777`, `terraform destroy`, secrets rotation |
| `write` | file/state mutation, recoverable | Edit/Write tools, redirects, `sed -i`, `cp`/`mv`, `git add/commit` |
| `execute` | runs code or tests | `pytest`, `npm run build`, `python3 script.py`, `docker run` |
| `read` | read-only inspection | Read/Grep/Glob/LS tools, `cat`, `ls`, `git status`, `find` without mutating flags |
| `network` | crosses the wire | WebFetch/WebSearch, `curl`/`wget`, `git push/fetch/clone`, `scp`/`ssh`, `npm publish` |

Scoring: deterministic verb/regex signal extraction → per-class weighted
sum → class = highest total (ties break toward the more severe class) →
score = class base (1/2/3/3/4) + 1 when the evidence is hard (total weight
≥ 5), capped at 5.

### Evasion handling

The scorer mirrors `enforcement_self_protect.py` rather than reinventing it:

- **Launcher prefixes** (`nohup`, `timeout`, `sudo`, `env`, `nice`, …) are
  stepped over so the real verb is judged: `sudo rm -rf /` classifies
  destructive.
- **Chained commands** (`&&`, `||`, `;`, `|`, background `&`) are split per
  segment — with separators inside quotes ignored, so the `;` inside
  `python3 -c "import shutil; shutil.rmtree(x)"` cannot hide the rmtree.
- **`sh -c` / `bash -c` / `eval`** payloads are unwrapped and classified
  recursively (depth-bounded).
- **Conditional verbs** follow the enforcer semantics: `sed` mutates only
  with `-i`; `find` only with `-delete`/`-exec`-family. Without the flag
  they classify read, exactly like the enforcer's `CONDITIONAL_VERBS`.
- **Path variants**: trailing slashes and `./` prefixes are normalized;
  `.uap` / `.git` self-targets fire a `protected-target` bump to score 5.
- **Scratch carve-out**: `rm -rf` whose targets are ALL regenerable trees
  (`node_modules`, `dist`, `build`, `/tmp/…`, …) classifies write, not
  destructive. One non-scratch target keeps destructive.

Known residuals (accepted — advisory-only cost, and the same limits the
enforcers document):

- a path held in a shell variable is invisible to any text scan;
- `sudo -u root rm …` leaves `root` as the apparent verb;
- an **escaped quote** inside a double-quoted string defeats the quote
  blanking (`python3 -c "a=\";\"; shutil.rmtree('/x')"` splits at the
  escaped quote, because the blanking regex does not model backslash
  escapes) — same accepted-residual class as shell variables: text scans
  cannot see shell state.

## Advisory doctrine

**The scorer never blocks and never modifies the stream.** The deterministic
enforcer chain is the blocking floor and is exactly as strict as before —
nothing gets looser. The classification is consumed three ways at the
proxy's outbound `tool_use` interception points
(`tools/agents/scripts/anthropic_proxy.py`):

1. **Debug log** — one line per tool_use:
   `AUTOMODE RISK: <id> <tool> class=… score=… signals=… latency=…ms`.
2. **Telemetry** — score ≥ 4 calls append a `dashboard_events` row
   (`category=automode`, `type=risk.classified`, severity `warning` for
   destructive) via `project_telemetry.record_risk_event`, so the
   dashboard's Live Events panel shows high-risk calls. Routine reads do
   not flood the feed.
3. **Nothing else.** On any classifier exception the proxy logs a warning
   and passes the tool call through unchanged — the advisory path fails
   OPEN precisely because the enforcer floor fails CLOSED; a dead
   classifier degrades to today's behaviour plus one warning line.

## Calibration

`tools/agents/scripts/tool_risk_calibrate.py` loads the labeled corpus
(`tools/agents/tests/fixtures/tool_risk_cases.json`, 109 cases across the
five classes including evasion variants and benign lookalikes), makes a
deterministic seeded stratified split, and reports per-class
precision/recall on the held-out set. The committed numbers, split seed,
and confusion notes live in
[**docs/performance/automode-risk-calibration.md**](../performance/automode-risk-calibration.md).

**Held-out destructive recall is gated at 1.0** (`--check` exits non-zero
otherwise): a missed destructive call is the unacceptable error. False
positives are advisory-only cost.

## Latency

The scorer is pure regex/dict work, measured in microseconds; a bench test
(`tools/agents/tests/test_tool_risk.py`) asserts **p95 < 5 ms over 10k
calls**. The 50 ms AutoMode budget is reserved for the future model call;
the heuristic floor sits far under it.

## Escape hatch

`PROXY_AUTOMODE_RISK=off` disables classification in the proxy (default
`on`). This is an operator hatch in the trusted launch env, same posture as
the other proxy switches.

## Files

| path | role |
|---|---|
| `tools/agents/scripts/tool_risk.py` | the scorer (pure) |
| `tools/agents/scripts/tool_risk_calibrate.py` | calibration harness / gate |
| `tools/agents/tests/fixtures/tool_risk_cases.json` | labeled corpus |
| `tools/agents/tests/test_tool_risk.py` | 36 tests (registered in `test:enforcers`) |
| `tools/agents/scripts/anthropic_proxy.py` | advisory wiring (3 interception points) |
| `tools/agents/scripts/project_telemetry.py` | `record_risk_event` dashboard sink |
| `docs/performance/automode-risk-calibration.md` | committed calibration report |
