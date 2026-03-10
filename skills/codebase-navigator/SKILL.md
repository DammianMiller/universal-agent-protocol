| name | description |
| --- | --- |
| codebase-navigator | Use roam-code for instant codebase comprehension. One graph query replaces 5-10 grep/read cycles. Install: `pipx install roam-code && roam init` |

# Codebase Navigator

## Commands
```bash
roam understand              # Full codebase briefing
roam context <symbol>        # Callers, callees, files-to-read with line ranges
roam preflight <symbol>      # Blast radius + tests + complexity
roam health                  # Composite score (0-100)
roam diff                    # Blast radius of uncommitted changes
roam search <pattern>        # Find symbols by PageRank
```

## When to Use
- Before editing unfamiliar code: `roam context`
- Before multi-file changes: `roam preflight`
- At session start: `roam health`
- Before committing: `roam diff`
