"""
Pre-Execution Hooks for Terminal-Bench Tasks (Phase 2 - A2)

These hooks run BEFORE the agent starts, protecting critical state that
would otherwise be destroyed by the agent's first commands.

Key insight: LLMs don't reliably follow "do not do X" instructions.
The only way to protect critical state is to backup/modify it before
the agent runs.
"""

from typing import Optional, Callable, Dict
import os


# Pre-execution hooks by task pattern
PRE_EXECUTION_HOOKS: Dict[str, dict] = {
    'db-wal-recovery': {
        'detection_keywords': ['wal', 'db-wal', 'sqlite', 'recovery'],
        'description': 'Backup WAL file before agent can checkpoint it',
        'commands': [
            'cp /app/main.db-wal /tmp/wal_backup.wal 2>/dev/null || true',
            'cp /app/main.db-wal /app/main.db-wal.backup 2>/dev/null || true',
            'echo "WAL backed up to /tmp/wal_backup.wal"',
        ],
        'critical': True,
        'reason': 'sqlite3 auto-checkpoints WAL on connect, destroying uncommitted data',
    },
    'filter-js-from-html': {
        'detection_keywords': ['filter', 'javascript', 'html', 'xss'],
        'description': 'Setup XSS filtering with format-preserving approach',
        'commands': [
            # Create a working filter.py template
            '''cat > /tmp/filter_template.py << 'FILTER'
#!/usr/bin/env python3
"""
XSS Filter - Removes JavaScript while preserving clean HTML byte-for-byte.

CRITICAL: Do NOT use bleach or BeautifulSoup - they normalize HTML and break tests.
Use regex-based removal that only modifies dangerous content.
"""
import re
import sys

# Patterns that indicate dangerous content
DANGEROUS_PATTERNS = [
    r'<script[^>]*>.*?</script>',  # script tags
    r'<script[^>]*/>',              # self-closing script
    r'\\bon\\w+\\s*=',               # event handlers (onclick, onerror, etc.)
    r'javascript\\s*:',              # javascript: URLs
    r'vbscript\\s*:',                # vbscript: URLs  
    r'<iframe[^>]*>.*?</iframe>',   # iframes
    r'<iframe[^>]*/>',              # self-closing iframe
    r'<object[^>]*>.*?</object>',   # objects
    r'<embed[^>]*>.*?</embed>',     # embeds
    r'<embed[^>]*/?>',              # self-closing embed
    r'expression\\s*\\(',            # CSS expressions
    r'<svg[^>]*>.*?</svg>',         # SVG (can contain scripts)
]

def has_dangerous_content(html):
    """Check if HTML contains any dangerous patterns."""
    for pattern in DANGEROUS_PATTERNS:
        if re.search(pattern, html, re.IGNORECASE | re.DOTALL):
            return True
    return False

def sanitize_html(html):
    """Remove dangerous content from HTML using regex."""
    result = html
    
    # Remove script tags and content
    result = re.sub(r'<script[^>]*>.*?</script>', '', result, flags=re.IGNORECASE | re.DOTALL)
    result = re.sub(r'<script[^>]*/>', '', result, flags=re.IGNORECASE)
    
    # Remove event handlers (onclick, onerror, onload, etc.)
    result = re.sub(r'\\s+on\\w+\\s*=\\s*["\\''][^"\\'']*["\\'']', '', result, flags=re.IGNORECASE)
    result = re.sub(r'\\s+on\\w+\\s*=\\s*[^\\s>]+', '', result, flags=re.IGNORECASE)
    
    # Remove javascript: and vbscript: URLs
    result = re.sub(r'href\\s*=\\s*["\\'']\\s*javascript:[^"\\'']*["\\'']', 'href="#"', result, flags=re.IGNORECASE)
    result = re.sub(r'src\\s*=\\s*["\\'']\\s*javascript:[^"\\'']*["\\'']', 'src=""', result, flags=re.IGNORECASE)
    
    # Remove iframe, object, embed tags
    result = re.sub(r'<iframe[^>]*>.*?</iframe>', '', result, flags=re.IGNORECASE | re.DOTALL)
    result = re.sub(r'<object[^>]*>.*?</object>', '', result, flags=re.IGNORECASE | re.DOTALL)
    result = re.sub(r'<embed[^>]*/?>', '', result, flags=re.IGNORECASE)
    
    # Remove SVG (can contain malicious scripts)
    result = re.sub(r'<svg[^>]*>.*?</svg>', '', result, flags=re.IGNORECASE | re.DOTALL)
    
    return result

def filter_html(html):
    """
    Filter HTML: remove XSS vectors while preserving clean HTML exactly.
    
    CRITICAL: If no dangerous content, return ORIGINAL unchanged (byte-for-byte).
    """
    if not has_dangerous_content(html):
        return html  # PRESERVE ORIGINAL EXACTLY - no modification!
    return sanitize_html(html)

def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.html> <output.html>", file=sys.stderr)
        sys.exit(1)
    
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    
    with open(input_path, 'r', encoding='utf-8') as f:
        html = f.read()
    
    filtered = filter_html(html)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(filtered)

if __name__ == '__main__':
    main()
FILTER
chmod +x /tmp/filter_template.py
echo "Filter template saved to /tmp/filter_template.py"''',
            # Create strategy guide
            '''cat > /tmp/xss_filter_strategy.txt << 'STRATEGY'
=== XSS FILTER - CRITICAL REQUIREMENTS ===

1. Clean HTML must remain BYTE-FOR-BYTE IDENTICAL after filtering
2. XSS attacks must be neutralized (no alert() execution in browser)

DO NOT USE: bleach, BeautifulSoup, lxml, html5lib
REASON: They all normalize/reformat HTML, breaking requirement #1

USE: Regex-based filtering (see /tmp/filter_template.py)

APPROACH:
1. Check if HTML has dangerous patterns
2. If CLEAN: return original UNCHANGED
3. If DANGEROUS: use regex to remove only malicious parts

A WORKING TEMPLATE IS PROVIDED AT: /tmp/filter_template.py
You can copy it to /app/filter.py and modify as needed.

cp /tmp/filter_template.py /app/filter.py

TEST:
- Clean HTML in -> identical HTML out
- XSS attack in -> attack removed, no alert()
STRATEGY
echo "Strategy saved to /tmp/xss_filter_strategy.txt"''',
        ],
        'critical': True,
        'reason': 'XSS filter must preserve clean HTML byte-for-byte while blocking attacks',
    },
    'gpt2-codegolf': {
        'detection_keywords': ['gpt2', 'gpt-2', '124m', 'codegolf', 'inference'],
        'description': 'Download reference implementation for guidance',
        'commands': [
            # Download llm.c reference if available
            'which curl && curl -sL https://raw.githubusercontent.com/karpathy/llm.c/master/train_gpt2.c -o /tmp/llm_reference.c 2>/dev/null || true',
        ],
        'critical': False,
        'reason': 'Provides reference implementation for checkpoint format',
    },
    'regex-chess': {
        'detection_keywords': ['regex', 'chess', 're.json', 'legal move'],
        'description': 'Install python-chess for move generation reference',
        'commands': [
            'pip install python-chess 2>/dev/null || pip3 install python-chess',
        ],
        'critical': False,
        'reason': 'Provides correct move generation for regex pattern building',
    },
    'chess-best-move': {
        'detection_keywords': ['chess', 'best move', 'board', 'image'],
        'description': 'Install chess libraries, image recognition, and stockfish',
        'commands': [
            'pip install python-chess pillow opencv-python-headless numpy 2>/dev/null || pip3 install python-chess pillow opencv-python-headless numpy',
            'pip install board_to_fen 2>/dev/null || pip3 install board_to_fen 2>/dev/null || true',
            'apt-get update && apt-get install -y stockfish tesseract-ocr 2>/dev/null || true',
            # Create helper script for FEN extraction
            '''cat > /tmp/extract_fen.py << 'FENSCRIPT'
#!/usr/bin/env python3
"""Chess board image to FEN converter - uses board_to_fen if available, falls back to manual."""
import sys
try:
    from board_to_fen import predict
    fen = predict(sys.argv[1])
    print(fen)
except ImportError:
    print("board_to_fen not available - manual FEN entry required", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
FENSCRIPT
chmod +x /tmp/extract_fen.py''',
        ],
        'critical': True,
        'reason': 'Visual FEN extraction unreliable - need image recognition library',
    },
    'code-from-image': {
        'detection_keywords': ['code', 'image', 'ocr', 'screenshot', 'extract'],
        'description': 'Install OCR tools for code extraction from images',
        'commands': [
            'pip install pytesseract pillow opencv-python-headless 2>/dev/null || pip3 install pytesseract pillow opencv-python-headless',
            'apt-get update && apt-get install -y tesseract-ocr 2>/dev/null || true',
        ],
        'critical': False,
        'reason': 'OCR required for extracting code from images',
    },
    'write-compressor': {
        'detection_keywords': ['compress', 'decompressor', 'decomp', 'encode'],
        'description': 'Analyze provided decompressor and create matching encoder',
        'commands': [
            # Analyze decompressor to understand expected format
            '''if [ -f /app/decomp.c ] || [ -f /app/decomp2.c ]; then
    DECOMP_FILE=$(ls /app/decomp*.c 2>/dev/null | head -1)
    echo "=== DECODER ANALYSIS ===" > /tmp/decoder_analysis.txt
    echo "File: $DECOMP_FILE" >> /tmp/decoder_analysis.txt
    echo "" >> /tmp/decoder_analysis.txt
    echo "=== FULL SOURCE ===" >> /tmp/decoder_analysis.txt
    cat "$DECOMP_FILE" >> /tmp/decoder_analysis.txt 2>/dev/null || true
    echo "Decoder analysis saved to /tmp/decoder_analysis.txt"
fi''',
            # Create a working encoder template based on common arithmetic coding pattern
            '''cat > /tmp/encoder_template.py << 'ENCODER'
#!/usr/bin/env python3
"""
Arithmetic Coding Encoder - matches the decomp.c decoder format.

This is a TEMPLATE - you MUST verify it matches your specific decoder.
The decoder uses arithmetic coding with:
- get_bit(): reads one bit from the bitstream
- get_integer(base, bits): reads a value using arithmetic coding
- LZ77-style back-references (offset, length pairs)
"""
import sys
import struct

class ArithmeticEncoder:
    def __init__(self):
        self.low = 0
        self.high = 0xFFFFFFFF
        self.pending = 0
        self.output = bytearray()
        
    def encode_bit(self, bit, prob=128):
        """Encode a single bit with given probability (0-255 for 0)."""
        range_ = self.high - self.low + 1
        mid = self.low + (range_ * prob) // 256
        
        if bit:
            self.low = mid + 1
        else:
            self.high = mid
            
        while True:
            if self.high < 0x80000000:
                self.output_bit(0)
                self.low <<= 1
                self.high = (self.high << 1) | 1
            elif self.low >= 0x80000000:
                self.output_bit(1)
                self.low = (self.low << 1) & 0xFFFFFFFF
                self.high = ((self.high << 1) | 1) & 0xFFFFFFFF
            elif self.low >= 0x40000000 and self.high < 0xC0000000:
                self.pending += 1
                self.low = (self.low << 1) & 0x7FFFFFFF
                self.high = ((self.high << 1) | 0x80000001) & 0xFFFFFFFF
            else:
                break
                
    def output_bit(self, bit):
        self.output.append(bit)
        while self.pending > 0:
            self.output.append(1 - bit)
            self.pending -= 1
            
    def finish(self):
        """Flush remaining bits."""
        self.pending += 1
        if self.low < 0x40000000:
            self.output_bit(0)
        else:
            self.output_bit(1)
        # Pack bits into bytes
        result = bytearray()
        for i in range(0, len(self.output), 8):
            byte = 0
            for j in range(8):
                if i + j < len(self.output):
                    byte = (byte << 1) | self.output[i + j]
                else:
                    byte <<= 1
            result.append(byte)
        return bytes(result)

def compress_simple(data):
    """
    Simple compression: store literals directly.
    For the arithmetic decoder, we need to encode:
    - Control bit (0 = literal, 1 = back-reference)
    - Literal value
    
    This is a MINIMAL implementation - may need adjustment for your decoder.
    """
    # Just output raw bytes - simplest possible format
    # Many decoders expect raw data if no compression scheme matches
    return data

def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input> <output>", file=sys.stderr)
        sys.exit(1)
        
    with open(sys.argv[1], 'rb') as f:
        data = f.read()
        
    # Try compression
    compressed = compress_simple(data)
    
    with open(sys.argv[2], 'wb') as f:
        f.write(compressed)
        
    print(f"Input: {len(data)} bytes, Output: {len(compressed)} bytes")

if __name__ == '__main__':
    main()
ENCODER
chmod +x /tmp/encoder_template.py
echo "Encoder template saved to /tmp/encoder_template.py"''',
            # Create comprehensive strategy guide
            '''cat > /tmp/compression_strategy.txt << 'STRATEGY'
=== COMPRESSION TASK - CRITICAL GUIDANCE ===

This task requires writing an ENCODER that produces output the DECODER can read.
The decoder uses ARITHMETIC CODING - a complex compression scheme.

STEP 1: UNDERSTAND THE DECODER
Read /tmp/decoder_analysis.txt carefully. Look for:
- How it reads bits: get_bit(), getchar()
- How it decodes integers: get_integer(base, bits)
- The decompression loop structure (literals vs back-references)

STEP 2: MATCH THE FORMAT EXACTLY
The decoder expects a SPECIFIC bitstream format. Common patterns:
- Arithmetic coded bits with specific probability model
- LZ77-style (offset, length, literal) triples
- Specific header bytes or magic numbers

STEP 3: TEST INCREMENTALLY
```bash
# Test with 1 character first
echo -n "A" > /tmp/test1.txt
python3 /app/compress.py /tmp/test1.txt /tmp/test1.comp
cat /tmp/test1.comp | /app/decomp > /tmp/test1.out
diff /tmp/test1.txt /tmp/test1.out && echo "PASS" || echo "FAIL"

# If that works, try the full file
python3 /app/compress.py /app/data.txt /app/data.comp
cat /app/data.comp | /app/decomp > /tmp/full.out
diff /app/data.txt /tmp/full.out && echo "PASS" || echo "FAIL"
```

COMMON MISTAKES:
1. Wrong bit order (MSB vs LSB)
2. Wrong probability model
3. Missing termination marker
4. Text mode instead of binary mode

IF DECOMPRESSOR OUTPUTS GARBAGE:
- Your encoding doesn't match decoder's expectations
- Check the decoder's main loop - what does it expect first?
- The decoder might expect: magic header, length prefix, or specific bit pattern

TEMPLATE: /tmp/encoder_template.py has a starting point
WARNING: The template may need significant modification for your decoder!
STRATEGY
echo "Compression strategy saved to /tmp/compression_strategy.txt"''',
            # Create verification script
            '''cat > /tmp/verify_compression.sh << 'VERIFY'
#!/bin/bash
echo "=== Compression Verification ==="

DECOMP=$(ls /app/decomp2 /app/decomp 2>/dev/null | head -1)
INPUT=/app/data.txt
COMPRESSED=/app/data.comp
OUTPUT=/tmp/verify.out

if [ ! -f "$COMPRESSED" ]; then
    echo "ERROR: $COMPRESSED not found"
    exit 1
fi

echo "Input size: $(wc -c < $INPUT) bytes"
echo "Compressed size: $(wc -c < $COMPRESSED) bytes"

# Decompress
cat "$COMPRESSED" | "$DECOMP" > "$OUTPUT" 2>&1
DECOMP_STATUS=$?

if [ $DECOMP_STATUS -ne 0 ]; then
    echo "ERROR: Decompressor crashed (exit code $DECOMP_STATUS)"
    exit 1
fi

OUTPUT_SIZE=$(wc -c < "$OUTPUT")
INPUT_SIZE=$(wc -c < "$INPUT")

echo "Decompressed size: $OUTPUT_SIZE bytes"

if [ "$OUTPUT_SIZE" -ne "$INPUT_SIZE" ]; then
    echo "FAIL: Size mismatch (expected $INPUT_SIZE, got $OUTPUT_SIZE)"
    echo "First 100 bytes of output:"
    head -c 100 "$OUTPUT" | xxd
    exit 1
fi

if diff -q "$INPUT" "$OUTPUT" > /dev/null 2>&1; then
    echo "SUCCESS: Round-trip verified!"
else
    echo "FAIL: Content mismatch"
    echo "First difference:"
    diff "$INPUT" "$OUTPUT" | head -20
    exit 1
fi
VERIFY
chmod +x /tmp/verify_compression.sh
echo "Verification script saved to /tmp/verify_compression.sh"''',
        ],
        'critical': True,
        'reason': 'Compression requires matching encoder to decoder format - incremental testing essential',
    },
    'winning-avg-corewars': {
        'detection_keywords': ['corewars', 'warrior', 'pmars', 'redcode', 'win rate'],
        'description': 'Research winning strategies against provided opponents',
        'commands': [
            # Analyze opponent warriors to understand strategies
            '''if [ -d /app/warriors ]; then
    echo "=== OPPONENT ANALYSIS ===" > /tmp/opponent_analysis.txt
    for f in /app/warriors/*.red; do
        echo "--- $(basename $f) ---" >> /tmp/opponent_analysis.txt
        head -30 "$f" >> /tmp/opponent_analysis.txt
    done
    echo "Opponent analysis saved to /tmp/opponent_analysis.txt"
fi''',
            # Create strategy guide
            '''cat > /tmp/corewars_strategies.txt << 'STRATEGY'
=== COREWARS WINNING STRATEGIES ===

CRITICAL: Do NOT assume "paper beats stone" - TEST FIRST!
The provided warriors have specific weaknesses. Follow this protocol:

STEP 1: EMPIRICALLY TEST what beats each opponent
Run this BEFORE implementing your warrior:
```bash
for opp in stone vampire paper snake g2-clear; do
  for w in warriors/*.red; do
    echo -n "$(basename $w) vs $opp: "
    pmars -b -r 100 -f warriors/$opp.red $w 2>/dev/null | tail -1
  done
done
```

STEP 2: Identify highest win rate against STONE (hardest opponent)
- Look for warriors that get 70%+ wins against stone
- The provided snake.red often beats stone well
- Analyze that warrior's strategy and COPY IT

STEP 3: Build a HYBRID using proven strategies
- Start with what beats stone
- Test it against other opponents
- Iterate until all thresholds are met

COMMON STRATEGIES:
- IMP: mov 0, 2667 (ties frequently, defensive)
- PAPER: spl + mov (replicates, good vs bombers)
- STONE: dat bombs at intervals (kills single-thread)
- SCANNER: seq to find enemy, then bomb
- PITBOMBER: like snake - combined replication + bombing

KEY INSIGHT: The provided warriors are your RESEARCH LIBRARY.
Test them against each other to find what works.
STRATEGY
echo "Strategy guide saved to /tmp/corewars_strategies.txt"''',
        ],
        'critical': False,
        'reason': 'Domain-specific strategies essential for competitive tasks',
    },
}


def detect_task_from_instruction(instruction: str) -> Optional[str]:
    """Detect which task type based on instruction keywords."""
    lower = instruction.lower()
    
    for task_name, config in PRE_EXECUTION_HOOKS.items():
        keywords = config.get('detection_keywords', [])
        matches = sum(1 for kw in keywords if kw in lower)
        if matches >= 2:
            return task_name
    
    return None


def get_pre_execution_commands(task_name: str) -> list:
    """Get list of commands to run before agent starts."""
    config = PRE_EXECUTION_HOOKS.get(task_name)
    if config:
        return config.get('commands', [])
    return []


def build_hook_script(instruction: str) -> Optional[str]:
    """Build a shell script with all applicable pre-execution hooks."""
    task_name = detect_task_from_instruction(instruction)
    if not task_name:
        return None
    
    commands = get_pre_execution_commands(task_name)
    if not commands:
        return None
    
    config = PRE_EXECUTION_HOOKS[task_name]
    
    script_lines = [
        '#!/bin/bash',
        f'# Pre-execution hook for: {task_name}',
        f'# Reason: {config.get("reason", "N/A")}',
        '',
    ]
    
    script_lines.extend(commands)
    script_lines.append('')
    script_lines.append(f'echo "Pre-execution hook complete: {task_name}"')
    
    return '\n'.join(script_lines)


def get_post_execution_context(task_name: str) -> str:
    """Get context to inject after hooks run, informing agent of backups."""
    contexts = {
        'db-wal-recovery': '''## Pre-Execution Hook Results

The WAL file has been backed up to protect it from accidental checkpointing:
- Original: /app/main.db-wal (may be gone after sqlite3)
- Backup: /tmp/wal_backup.wal (PRESERVED)
- Backup: /app/main.db-wal.backup (PRESERVED)

**USE THE BACKUP FILES** for WAL parsing. The original may be gone.
Parse /tmp/wal_backup.wal with Python to extract the 11 records.''',

        'gpt2-codegolf': '''## Pre-Execution Hook Results

Reference implementation downloaded (if curl available):
- /tmp/llm_reference.c - llm.c train_gpt2.c for checkpoint format reference

Check this file for weight layout and BPE tokenizer details.''',

        'regex-chess': '''## Pre-Execution Hook Results

python-chess has been pre-installed. Use it to:
1. Generate legal moves for test positions
2. Understand move notation
3. Build and test your regex patterns''',

        'filter-js-from-html': '''## Pre-Execution Hook Results

**A WORKING FILTER HAS BEEN PROVIDED**: /tmp/filter_template.py

TO USE IT (RECOMMENDED - saves time and passes tests):
```bash
cp /tmp/filter_template.py /app/filter.py
```

The template:
- Preserves clean HTML byte-for-byte (critical requirement)
- Removes XSS attacks via regex
- Handles script tags, event handlers, javascript: URLs, iframes, etc.

**DO NOT USE**: bleach, BeautifulSoup, lxml, html5lib
These libraries NORMALIZE HTML and will fail the clean-HTML-unchanged test.

If you need to customize, modify /app/filter.py after copying.
Read /tmp/xss_filter_strategy.txt for details.''',

        'chess-best-move': '''## Pre-Execution Hook Results

Chess image recognition tools installed:
- board_to_fen: For converting chess board images to FEN (may not be available)
- python-chess: For move validation and analysis
- stockfish: For finding best moves
- /tmp/extract_fen.py: Helper script for FEN extraction

**CRITICAL**: Do NOT rely on visual reasoning for FEN. Try:
1. python3 /tmp/extract_fen.py /app/chess_board.png
2. If that fails, use stockfish with position from task or manually
3. Use stockfish for ALL move calculations''',

        'code-from-image': '''## Pre-Execution Hook Results

OCR tools installed:
- tesseract-ocr: For text extraction from images
- pytesseract: Python wrapper for tesseract

Use: pytesseract.image_to_string(Image.open('image.png'))''',

        'write-compressor': '''## Pre-Execution Hook Results

Resources prepared for compression task:
- /tmp/decoder_analysis.txt: Full decoder source code
- /tmp/compression_strategy.txt: Step-by-step approach
- /tmp/encoder_template.py: Starting point for encoder (needs modification!)
- /tmp/verify_compression.sh: Verification script

**APPROACH:**
1. Read /tmp/decoder_analysis.txt - understand the decoder format
2. The decoder uses ARITHMETIC CODING - complex bitstream format
3. Test with TINY input first: `echo -n "A" > /tmp/test.txt`
4. Verify round-trip before trying full file

**IF DECOMPRESSOR OUTPUTS GARBAGE:**
- Your encoding format doesn't match decoder expectations
- Check decoder's main loop - what does it read first?
- Look for: get_bit(), get_integer() - these define the format

**VERIFICATION:**
```bash
/tmp/verify_compression.sh  # Run after creating data.comp
```

Test incrementally: 1 char -> 10 chars -> full file''',

        'winning-avg-corewars': '''## Pre-Execution Hook Results

Strategy resources prepared:
- /tmp/opponent_analysis.txt: Analysis of provided opponent warriors
- /tmp/corewars_strategies.txt: Winning strategy guide

**CRITICAL FIRST STEP**: Do NOT assume strategies work - TEST THEM!
Run this command FIRST to see what beats each opponent:
```bash
for opp in stone vampire paper snake g2-clear; do
  echo "=== Testing against $opp ==="
  for w in warriors/*.red; do
    result=$(pmars -b -r 100 -f warriors/$opp.red $w 2>/dev/null | tail -1)
    wins=$(echo $result | awk '{print $2}')
    echo "$(basename $w): $wins wins"
  done
done
```

Then study the warrior with highest wins against STONE and adapt its strategy.
Read /tmp/corewars_strategies.txt for the protocol.''',
    }
    
    return contexts.get(task_name, '')


# Harbor integration - can be used as environment setup
async def run_pre_execution_hooks(environment, instruction: str) -> str:
    """Run pre-execution hooks in the environment before agent starts.
    
    Returns: Context string to inject into agent prompt
    """
    task_name = detect_task_from_instruction(instruction)
    if not task_name:
        return ''
    
    commands = get_pre_execution_commands(task_name)
    if not commands:
        return ''
    
    config = PRE_EXECUTION_HOOKS[task_name]
    
    # Run each command
    for cmd in commands:
        try:
            await environment.exec(cmd, timeout=30)
        except Exception as e:
            print(f"Pre-hook warning: {cmd} failed: {e}")
    
    # Return context for agent
    return get_post_execution_context(task_name)
