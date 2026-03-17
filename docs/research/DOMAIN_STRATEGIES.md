# Domain Strategy Guides for Terminal-Bench Tasks

**Purpose:** Provide domain-specific knowledge for competitive and specialized tasks where generic problem-solving isn't sufficient.

---

## 1. CoreWars Strategy Guide

### The Rock-Paper-Scissors of CoreWars

| Warrior Type           | Beats    | Loses To  |
| ---------------------- | -------- | --------- |
| **Paper** (replicator) | Stone    | Scanner   |
| **Stone** (bomber)     | Scanner  | Paper     |
| **Scanner** (hunter)   | Paper    | Stone     |
| **Imp** (survivor)     | Ties all | Wins none |

### Stone Bombers (like Terminal-Bench opponents)

**How Stone Works:**

- Drops DAT bombs at regular intervals
- Moves through memory at fixed step size
- If bomb lands on opponent's code, opponent process dies

**How to Beat Stone:**

1. **Paper Strategy** - Self-replicate faster than bombing
2. **Imp Strategy** - Move through memory avoiding bombs (ties)
3. **Vampire Strategy** - Place JMP traps to capture Stone's processes

### Winning Paper Warrior Template

```redcode
;redcode-94
;name PaperWins
;author UAP
;strategy Self-replicate to outpace stone bomber

        org start

start   spl 0           ; Create multiple processes
        mov -1, @0      ; Copy itself forward
        add #100, -1    ; Increment destination
        jmz -2, @-2     ; Loop if target empty

        end start
```

### Hybrid Paper-Imp (Best of Both)

```redcode
;redcode-94
;name HybridWinner
;author UAP
;strategy Paper with imp backup

        org start

; Paper section - replicates
start   spl paper
        jmp imp

paper   spl 0
        mov -1, @0
        add #100, -1
        jmz -2, @-2

; Imp section - survives even if paper dies
imp     mov 0, 2667     ; Imp step (8000/3)

        end start
```

### Testing Strategy

```bash
# Test against stone
pmars -b -r 100 my_warrior.red warriors/stone.red

# Results format: wins-ties-losses
# Need 75%+ wins (75+ in first number)
```

---

## 2. Chess Strategy Guide

### Using Stockfish Correctly

**DO NOT** try to calculate chess moves through reasoning. Always use Stockfish.

```bash
# Install
apt-get install -y stockfish

# Basic best move
echo -e "position fen $FEN\ngo depth 20" | stockfish | grep bestmove

# Multiple best moves (for finding ALL winning moves)
echo -e "position fen $FEN\ngo movetime 5000 multipv 5" | stockfish
```

### FEN Notation

```
rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
```

- Rows separated by `/`
- Lowercase = black, uppercase = white
- Numbers = empty squares
- `w` = white to move, `b` = black
- `KQkq` = castling rights
- `-` = en passant square (or none)
- `0 1` = halfmove clock, fullmove number

### Image to FEN (CRITICAL)

**NEVER trust visual reasoning for FEN extraction.** Use tools:

```python
# Option 1: board_to_fen library
pip install board_to_fen
from board_to_fen import predict
fen = predict('chess_board.png')

# Option 2: Manual entry if image simple
# Read squares left-to-right, top-to-bottom
```

### Finding ALL Checkmates

For tasks asking for "best move" or "checkmate", there may be MULTIPLE correct answers:

```bash
# Get top 5 candidate moves
echo -e "position fen $FEN\ngo movetime 10000 multipv 5" | stockfish

# For each candidate, verify if it's checkmate
for move in $CANDIDATES; do
    echo -e "position fen $FEN moves $move\ngo mate 1" | stockfish
done
```

---

## 3. Compression Strategy Guide

### Understanding Provided Decoders

**CRITICAL**: Before writing a compressor, analyze the decoder:

```bash
# Find input parsing
grep -n "fread\|getchar\|fgetc" decomp.c

# Find data structures
grep -n "struct\|typedef" decomp.c

# Find decompression algorithm
grep -n "while\|for" decomp.c | head -20
```

### Round-Trip Testing

**ALWAYS verify round-trip before optimizing:**

```bash
# Test with simple data first
echo "test" > /tmp/original.txt
./compress /tmp/original.txt /tmp/test.comp
./decomp < /tmp/test.comp > /tmp/recovered.txt
diff /tmp/original.txt /tmp/recovered.txt
```

### Common Compression Formats

| Algorithm         | Characteristics                          |
| ----------------- | ---------------------------------------- |
| Arithmetic coding | Fractional bits, state machine           |
| Huffman           | Integer bits, prefix codes               |
| LZ77              | Sliding window, offset+length pairs      |
| LZSS              | LZ77 with flags for literal vs reference |

### Size Constraints

For tasks like "compress to <2500 bytes":

1. Meet constraint FIRST
2. Verify round-trip SECOND
3. Optimize compression ratio LAST

---

## 4. Git Recovery Strategy Guide

### Forensic Approach

**ALWAYS backup before ANY git operation:**

```bash
cp -r .git .git.bak
```

### Recovery Tools

```bash
# Check integrity
git fsck --full --no-dangling

# Find lost commits
git reflog --all

# Find objects
find .git/objects -type f

# Recover from reflog
git checkout HEAD@{n}
```

### Common Issues

| Symptom           | Solution                           |
| ----------------- | ---------------------------------- |
| Corrupted objects | `git fsck`, find good copy in pack |
| Lost commits      | `git reflog`, `git cherry-pick`    |
| Detached HEAD     | `git checkout -b recovery-branch`  |
| Missing tree      | Recreate from working directory    |

---

## 5. XSS Filter Strategy Guide

### Whitelist Approach (CORRECT)

```python
import bleach

ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'a']
ALLOWED_ATTRS = {'a': ['href']}

clean = bleach.clean(
    user_input,
    tags=ALLOWED_TAGS,
    attributes=ALLOWED_ATTRS,
    strip=True
)
```

### Blacklist Approach (WRONG - DON'T DO THIS)

```python
# DON'T: Attackers can bypass with:
# <ScRiPt>, <script/>, <scr\0ipt>, etc.
result = re.sub(r'<script.*?>.*?</script>', '', input)
```

### Defense in Depth

1. Whitelist allowed tags
2. Whitelist allowed attributes
3. Sanitize URLs (no javascript:, data:)
4. Encode output for context

---

## 6. Polyglot Code Strategy Guide

### Feasible Language Pairs

| Pair         | Technique               | Difficulty    |
| ------------ | ----------------------- | ------------- |
| C/Python     | `#if 0` + triple quotes | Easy          |
| Python/Perl  | Comment overlap         | Medium        |
| Shell/Python | Shebang tricks          | Medium        |
| Rust/C++     | Comment manipulation    | **Very Hard** |

### C/Python Polyglot Template

```c
#if 0
"""
#endif
#include <stdio.h>
int main() { printf("C\n"); return 0; }
#if 0
"""
print("Python")
#endif
```

### Rust/C++ (Near-Impossible)

Due to incompatible syntax (`fn main()` vs `int main()`), true Rust/C++ polyglots are extremely difficult. Time-box attempts to 20% of total time budget.

---

## Usage in CLAUDE.md

These guides can be referenced via Pattern 36 (Competition Domain Research):

```markdown
### Pattern 36: Competition Domain Research (CDR)

**Detection**: Keywords "win rate", "beat", "competition", "versus"
**Action**:

1. Check /docs/DOMAIN_STRATEGY_GUIDES.md for domain-specific tactics
2. Research winning strategies BEFORE implementing
3. Time-box optimization iterations
```

---

**Generated:** 2026-01-18
