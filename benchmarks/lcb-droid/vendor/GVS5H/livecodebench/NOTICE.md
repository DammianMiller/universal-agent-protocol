# Notice

This directory is a modified copy of **LiveCodeBench**
(<https://github.com/LiveCodeBench/LiveCodeBench>), taken at upstream commit
[`28fef95e`](https://github.com/LiveCodeBench/LiveCodeBench/commit/28fef95e) (2025-07-16).

LiveCodeBench is licensed under the MIT License, Copyright (c) 2024 LiveCodeBench.
The upstream license is kept unchanged in [`LICENSE`](LICENSE).

## Modifications

Copyright (c) 2026 Persis Capital Inc. Modifications are released under the same
MIT License as upstream (see [`LICENSE`](LICENSE)).

Added:

- `lcb_runner/runner/claude_code_runner.py`: runs a headless `claude -p` session as a
  single LCB model, in single-shot or agentic mode.

Changed:

- `lcb_runner/evaluation/testing_util.py`: `MockBuffer` keeps a read position, so
  `readline`, `readlines` and iteration on binary stdin return successive lines
  (upstream's `readline` returned the first line every time).
- `lcb_runner/lm_styles.py`: adds the `ClaudeCode` style and four harness model entries.
- `lcb_runner/prompts/code_generation.py`: formats `ClaudeCode` prompts as chat messages.
- `lcb_runner/runner/runner_utils.py`: routes `ClaudeCode` models to the new runner.
- `lcb_runner/runner/main.py`: in `--debug` mode, adds `LCB_DEBUG_LIMIT`,
  `LCB_PROBLEM_IDS_FILE` and `LCB_STRATIFY` to pick the problem set.
- `lcb_runner/runner/oai_runner.py`: falls back to `reasoning_content` when `content`
  is empty.
- `lcb_runner/runner/parser.py`: `torch` is optional.
- `lcb_runner/utils/extraction_utils.py`: empty model output extracts to `""`.

## Third-party code inside LiveCodeBench

Upstream LiveCodeBench includes code derived from the projects below. Their notices
are kept in the source files, and their license texts are in [`LICENSES/`](LICENSES/).

| File | Derived from | License |
|---|---|---|
| `lcb_runner/evaluation/utils_execute.py` | HuggingFace Datasets / Evaluate `code_eval`, Copyright 2020 The HuggingFace Datasets Authors; itself from [openai/human-eval](https://github.com/openai/human-eval), Copyright (c) OpenAI | Apache-2.0 ([text](LICENSES/Apache-2.0.txt)); MIT ([text](LICENSES/MIT-human-eval.txt)) |
| `lcb_runner/evaluation/compute_code_generation_metrics.py` | [bigcode-evaluation-harness](https://github.com/bigcode-project/bigcode-evaluation-harness) `apps_custom_metrics/utils.py`, via [Naman-ntc/codescratch](https://github.com/Naman-ntc/codescratch) | Apache-2.0 ([text](LICENSES/Apache-2.0.txt)) |
| `lcb_runner/evaluation/testing_util.py` | [hendrycks/apps](https://github.com/hendrycks/apps) `eval/testing_util.py`, Copyright (c) 2021 Dan Hendrycks | MIT ([text](LICENSES/MIT-apps.txt)) |

The Apache-2.0 files above are unmodified from upstream LiveCodeBench.

## Dataset

The benchmark problems are not part of this code. They are downloaded at run time from
<https://huggingface.co/livecodebench> and are subject to the terms on that dataset page
and of the original contest platforms (LeetCode, AtCoder, Codeforces).
