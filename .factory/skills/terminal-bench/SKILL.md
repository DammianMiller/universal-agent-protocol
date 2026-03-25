| name | description |
| --- | --- |
| terminal-bench | Strategies for Terminal-Bench 2.0 benchmark tasks. Covers task classification, pre-execution hooks, and domain-specific guidance for 89 terminal environment tasks. |

# Terminal-Bench Strategies

## Task Classification
Classify each task by keywords to route domain-specific guidance:
- **git**: recovery, fsck, reflog, leak, sanitize
- **compression**: codegolf, encoder/decoder, compress
- **chess**: FEN, PGN, best move, stockfish
- **polyglot**: multi-language, compile in both
- **service**: server, nginx, grpc, daemon
- **database**: sqlite, WAL, truncate
- **statistics**: mcmc, sampling, bayesian
- **competitive**: corewars, win rate, opponent

## Universal Principles
1. Read the full task + tests/verifiers BEFORE writing code
2. Create expected output files early, even as stubs
3. Prefer existing libraries over custom implementations
4. Run all tests after implementation; iterate on failures
5. Use binary mode ('rb'/'wb') for non-text file I/O
6. Reserve time for debugging -- do not give up after first failure

## Pre-Execution Hooks
Back up critical state before modifying:
```bash
cp -r .git .git.bak          # Before git operations
cp db.sqlite db.sqlite.bak   # Before database operations
```
