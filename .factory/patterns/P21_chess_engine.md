# P21: Chess Engine Integration

**Category**: Domain-Specific
**Abbreviation**: Chess-Engine

## Pattern

For chess analysis tasks, integrate with a chess engine (Stockfish) for best moves. Do not calculate manually.

## Rule

```
Chess moves → Use engine (Stockfish). Never guess.
```

## Implementation

1. Recognize chess-related keywords
2. Extract FEN position if provided
3. Query chess engine for best move
4. Return engine analysis, not manual calculation

## Trigger Keywords

- chess, FEN, best move
- checkmate, checkmate in N
- position evaluation

## Using Stockfish

```python
import chess
import chess.engine

engine = chess.engine.SimpleEngine.popen_uci("stockfish")
board = chess.Board(fen_string)
result = engine.play(board, chess.engine.Limit(time=2.0))
print(result.move)
```

## Without Engine Available

State clearly: "Chess engine not available. Manual analysis may be incorrect."

## Anti-Pattern

❌ Guessing chess moves without engine
❌ Providing "intuitive" chess analysis
❌ Claiming checkmate without verification
