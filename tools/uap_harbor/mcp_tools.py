"""
MCP Tools for SUPERGENIUS Agent - Phase 2

Provides specialized tools that the agent can use:
1. Web Search - Research implementation details
2. Code Reference - Look up known algorithms/patterns

These tools help with tasks like gpt2-codegolf where the agent
needs to research checkpoint formats and tokenizer details.
"""

import os
import httpx
from typing import Optional, List, Dict, Any


class WebSearchTool:
    """Web search tool using DuckDuckGo Instant Answer API (no API key needed)."""
    
    def __init__(self):
        self.base_url = "https://api.duckduckgo.com/"
    
    async def search(self, query: str, max_results: int = 5) -> str:
        """Search the web for information.
        
        Args:
            query: Search query
            max_results: Maximum number of results to return
            
        Returns:
            Formatted search results as string
        """
        async with httpx.AsyncClient() as client:
            try:
                # DuckDuckGo Instant Answer API
                response = await client.get(
                    self.base_url,
                    params={
                        "q": query,
                        "format": "json",
                        "no_html": 1,
                        "skip_disambig": 1,
                    },
                    timeout=10.0
                )
                response.raise_for_status()
                data = response.json()
                
                results = []
                
                # Abstract (main answer)
                if data.get("Abstract"):
                    results.append(f"**Summary**: {data['Abstract']}")
                    if data.get("AbstractURL"):
                        results.append(f"Source: {data['AbstractURL']}")
                
                # Related topics
                for topic in data.get("RelatedTopics", [])[:max_results]:
                    if isinstance(topic, dict) and topic.get("Text"):
                        results.append(f"- {topic['Text']}")
                
                # Definition
                if data.get("Definition"):
                    results.append(f"**Definition**: {data['Definition']}")
                
                if results:
                    return "\n".join(results)
                else:
                    return f"No results found for: {query}"
                    
            except Exception as e:
                return f"Search error: {str(e)}"


class CodeReferenceTool:
    """Provides reference implementations for common patterns.
    
    Pre-built knowledge for known difficult Terminal-Bench tasks.
    """
    
    # Reference implementations for known tasks
    REFERENCES = {
        'gpt2-checkpoint': '''## GPT-2 124M Checkpoint Format (llm.c)

The checkpoint file contains raw float32 weights concatenated in order:

1. Token embeddings: wte [50257, 768] = 38,597,376 floats
2. Position embeddings: wpe [1024, 768] = 786,432 floats
3. 12 Transformer blocks, each containing:
   - ln1.weight [768], ln1.bias [768]
   - c_attn.weight [768, 2304], c_attn.bias [2304]  # Q,K,V combined
   - c_proj.weight [768, 768], c_proj.bias [768]
   - ln2.weight [768], ln2.bias [768]
   - mlp.c_fc.weight [768, 3072], mlp.c_fc.bias [3072]
   - mlp.c_proj.weight [3072, 768], mlp.c_proj.bias [768]
4. Final layer norm: ln_f.weight [768], ln_f.bias [768]

Total parameters: ~124M

**Reading in Python**:
```python
import struct
import numpy as np

with open('model.bin', 'rb') as f:
    data = np.frombuffer(f.read(), dtype=np.float32)
    
# Token embeddings
wte = data[:50257*768].reshape(50257, 768)
offset = 50257*768

# Position embeddings
wpe = data[offset:offset+1024*768].reshape(1024, 768)
```
''',
        'bpe-tokenizer': '''## GPT-2 BPE Tokenizer

**Key insight**: Space is encoded as "Ġ" (bytes 0xC4 0xA0)

**vocab.bpe format**:
- First line: version
- Subsequent lines: merge rules "token1 token2"

**encoder.json**: Maps tokens to IDs

**Minimal tokenization**:
```python
def tokenize(text, encoder, bpe_ranks):
    # Add space prefix for BPE
    text = ' ' + text
    text = text.replace(' ', 'Ġ')
    
    # Encode characters
    tokens = list(text.encode('utf-8'))
    
    # Apply BPE merges
    while len(tokens) > 1:
        pairs = [(tokens[i], tokens[i+1]) for i in range(len(tokens)-1)]
        min_pair = min(pairs, key=lambda p: bpe_ranks.get(p, float('inf')))
        if min_pair not in bpe_ranks:
            break
        # Merge pair
        new_tokens = []
        i = 0
        while i < len(tokens):
            if i < len(tokens)-1 and (tokens[i], tokens[i+1]) == min_pair:
                new_tokens.append(tokens[i] + tokens[i+1])
                i += 2
            else:
                new_tokens.append(tokens[i])
                i += 1
        tokens = new_tokens
    
    return [encoder[t] for t in tokens]
```
''',
        'sqlite-wal': '''## SQLite WAL File Format

**CRITICAL**: Running sqlite3 will checkpoint the WAL, destroying uncommitted data!

**WAL Header (32 bytes)**:
- Bytes 0-3: Magic number 0x377F0682 (little-endian) or 0x377F0683 (big-endian)
- Bytes 4-7: File format version (currently 3007000)
- Bytes 8-11: Page size
- Bytes 12-15: Checkpoint sequence number
- Bytes 16-19: Salt-1
- Bytes 20-23: Salt-2
- Bytes 24-31: Checksum of first 24 bytes

**WAL Frame Header (24 bytes)**:
- Bytes 0-3: Page number
- Bytes 4-7: For commit records, size of database in pages
- Bytes 8-11: Salt-1
- Bytes 12-15: Salt-2
- Bytes 16-23: Checksum

**Each frame contains**: 24-byte header + page_size bytes of data

**Python parsing**:
```python
import struct

def parse_wal(path):
    with open(path, 'rb') as f:
        # Read header
        magic = struct.unpack('<I', f.read(4))[0]
        version = struct.unpack('<I', f.read(4))[0]
        page_size = struct.unpack('<I', f.read(4))[0]
        f.read(20)  # Skip rest of header
        
        frames = []
        while True:
            frame_header = f.read(24)
            if len(frame_header) < 24:
                break
            page_num = struct.unpack('<I', frame_header[:4])[0]
            page_data = f.read(page_size)
            if len(page_data) < page_size:
                break
            frames.append((page_num, page_data))
        
        return frames
```
''',
        'xss-filter': '''## XSS Filter Patterns (OWASP)

**Must block ALL of these vectors**:

1. Script tags (case-insensitive):
   - `<script>`, `<SCRIPT>`, `<ScRiPt>`
   - `<script/xss>`, `<script >`
   
2. Event handlers:
   - `onclick`, `onerror`, `onload`, `onmouseover`
   - `onfocus`, `onblur`, `onsubmit`, `onchange`
   
3. JavaScript URLs:
   - `href="javascript:..."`, `src="javascript:..."`
   - `action="javascript:..."`, `formaction="javascript:..."`
   
4. Data URLs with JS:
   - `data:text/html,<script>...</script>`
   - `data:text/html;base64,...`
   
5. CSS expressions:
   - `style="background:url(javascript:...)"`
   - `expression()`, `-moz-binding`
   
6. SVG vectors:
   - `<svg onload=...>`, `<svg><script>...</script></svg>`
   
7. Encoded entities:
   - `&#x6A;avascript:` = javascript:
   - `&#106;avascript:` = javascript:

**Safe approach with bleach**:
```python
import bleach

def sanitize(html):
    return bleach.clean(
        html,
        tags=['p', 'a', 'div', 'span', 'br', 'ul', 'ol', 'li'],
        attributes={'a': ['href']},
        protocols=['http', 'https'],
        strip=True
    )
```
''',
        'regex-chess': '''## Chess Move Regex Patterns

**Legal moves for each piece**:

1. **Pawn**:
   - Forward: e2-e4, d7-d5 (2 squares from start)
   - Forward: e3-e4 (1 square otherwise)
   - Capture: exd5 (diagonal)
   - En passant: exd6 (after opponent's 2-square pawn move)
   - Promotion: e8=Q

2. **Knight**: L-shape moves
   - Pattern: From any square, +/- (1,2) or (2,1)
   - Na3, Nf3, Nc6, etc.

3. **Bishop**: Diagonal rays
   - Slides until blocked
   - Bb5, Bc4, Bg2

4. **Rook**: Horizontal/vertical rays
   - Ra1, Rf1, Rd8

5. **Queen**: Combined bishop + rook
   - Qd1, Qh5

6. **King**: One square any direction
   - Castling: O-O (kingside), O-O-O (queenside)

**Use python-chess to generate legal moves**:
```python
import chess

board = chess.Board()
for move in board.legal_moves:
    print(move.uci())  # e.g., "e2e4"
```
'''
    }
    
    def get_reference(self, topic: str) -> str:
        """Get reference implementation for a topic.
        
        Args:
            topic: Topic to look up (e.g., 'gpt2-checkpoint', 'sqlite-wal')
            
        Returns:
            Reference information or error message
        """
        # Fuzzy match
        topic_lower = topic.lower()
        for key, value in self.REFERENCES.items():
            if key in topic_lower or topic_lower in key:
                return value
        
        # Check for partial matches
        for key, value in self.REFERENCES.items():
            keywords = key.split('-')
            if any(kw in topic_lower for kw in keywords):
                return value
        
        available = ', '.join(self.REFERENCES.keys())
        return f"No reference found for '{topic}'. Available: {available}"


# Tool instances for use in agent
web_search = WebSearchTool()
code_reference = CodeReferenceTool()


async def search_web(query: str) -> str:
    """Search the web for information."""
    return await web_search.search(query)


def get_code_reference(topic: str) -> str:
    """Get reference implementation for a topic."""
    return code_reference.get_reference(topic)
