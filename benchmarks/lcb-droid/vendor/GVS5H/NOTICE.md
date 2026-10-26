# Licensing

Copyright (c) 2026 Persis Capital Inc.

This repository uses two licenses, split by path:

| Path | What it is | License |
|---|---|---|
| `codebase/v2-current/`, `codebase/v1-be9dfa2/`, `paper_plot_script/` | Code | MIT ([`LICENSE`](LICENSE)) |
| `paper/`, `assets/`, `runs/` | Paper, figures, run results and agent workspaces | CC BY 4.0 ([`LICENSE-CC-BY-4.0`](LICENSE-CC-BY-4.0)) |

The exceptions below keep their own licenses and are not covered by either of ours.

## Third-party material

**LiveCodeBench fork.** `codebase/livecodebench/` is a modified copy of
[LiveCodeBench](https://github.com/LiveCodeBench/LiveCodeBench) under the MIT License,
and includes code under Apache-2.0 and MIT from other projects. See
[`codebase/livecodebench/NOTICE.md`](codebase/livecodebench/NOTICE.md).

**Benchmark problem statements.** Each `runs/**/ws/**/task.md` holds the text of a
LiveCodeBench problem, taken from AtCoder, LeetCode or Codeforces. That text belongs
to its original publishers and is not licensed under CC BY 4.0. The model-written
files next to it (`plan.md`, `notes.md`, `tasks.json`, `solution.py`, `answer.md`)
are covered by CC BY 4.0.

**LaTeX template files.** These files in `paper/` are the conference template and its
dependencies, redistributed under their own terms. Their contents are unmodified; the first
two have been renamed, as noted:

| File | Source | License |
|---|---|---|
| `paper_conference.sty` (renamed from `iclr2027_conference.sty`) | ICLR 2027 author kit, adapted by Hugo Larochelle from the NeurIPS style file | No license stated; distributed by ICLR for author use |
| `paper_conference.bst` (renamed from `iclr2027_conference.bst`) | ICLR author kit, from `icml2010.bst` (Copyright 2010 Hal Daumé III) and `plainnat.bst` (Copyright 1993-2007 Patrick W Daly) | [LPPL](https://www.latex-project.org/lppl/) 1 or later |
| `natbib.sty` | [natbib](https://ctan.org/pkg/natbib), Copyright 1993-2009 Patrick W Daly | [LPPL](https://www.latex-project.org/lppl/) 1 or later |
| `fancyhdr.sty` | [fancyhdr](https://ctan.org/pkg/fancyhdr) 3.2, Piet van Oostrum | [LPPL](https://www.latex-project.org/lppl/) 1 or later |

## Attribution

To reuse the paper, figures or data, credit the paper:

> Victor Gao, Vida Khosrowshahi, Ali Khosrowshahi, Xihao Sun, Juhyun Lee and
> Simon (Sang Won) Lee. *Zero-Shot Self-Orchestration with Ledger-Based Control
> Improves Coding in Language Models*. 2026. <https://github.com/slee-persis/GVS5H>
