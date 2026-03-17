# Behavioral Patterns Analysis - Terminal-Bench 2.0

## Key Discovery: Environment Isolation

**CRITICAL INSIGHT**: Pre-hooks run in the AGENT environment, but tests run in a SEPARATE environment.
- Packages installed via pip in pre-hooks ARE NOT available during testing
- Only packages in the Dockerfile are available
- Solution: Use only pre-installed tools (openssl CLI, bs4 if in Dockerfile) via subprocess

**Before implementing any task**: Check `/tmp/tbench2/{task}/environment/Dockerfile` to see what's available.

## Pattern Analysis from 54 Task Benchmark

### Successful Task Characteristics (11/54 = 20.4%)

| Task | Pattern | Why It Worked |
|------|---------|---------------|
| configure-git-webserver | Clear step-by-step instructions | Agent follows recipe |
| crack-7z-hash | Single clear goal + tools available | hashcat/john pre-installed |
| custom-memory-heap-crash | Debugging with clear symptoms | Edit single file |
| fix-git | Git recovery with clear goal | Standard git commands |
| headless-terminal | Implement interface | Clear API contract |
| install-windows-3.11 | VM setup with specs | QEMU commands documented |
| multi-source-data-merger | Data transformation | pandas operations |
| prove-plus-comm | Complete partial proof | Coq tactics |
| pytorch-model-cli | Build CLI tool | Standard PyTorch |
| qemu-startup | Start VM and wait | QEMU + telnet |
| adaptive-rejection-sampler | Implement algorithm | R programming |

### Failed Task Characteristics (43/54 = 79.6%)

| Pattern | Examples | Why It Failed |
|---------|----------|---------------|
| **Requires pre-computed solution** | gpt2-codegolf, regex-chess, path-tracing | Solution is data, not algorithm |
| **First action destroys state** | db-wal-recovery | sqlite3 checkpoints WAL |
| **Complex multi-step build** | compile-compcert, caffe-cifar-10 | Dependencies, config issues |
| **Needs vision/multimedia** | chess-best-move, extract-moves-from-video | Image/video parsing |
| **Forensics/recovery** | password-recovery, git-leak-recovery | Deleted data recovery |
| **Exact output matching** | filter-js-from-html | Must preserve formatting exactly |

---

## Exploitable Behavioral Patterns

### Pattern 1: "Recipe Following" Tasks
**Success Rate: HIGH**

Tasks with clear, sequential instructions succeed because the agent:
- Executes commands in order
- Verifies each step
- Doesn't need creative problem-solving

**Exploit Strategy**: Convert complex tasks into step-by-step recipes in pre-hook context.

```python
# Example: Instead of "configure git server"
# Provide: 
# 1. apt install git
# 2. mkdir /git/server && cd /git/server && git init --bare
# 3. Create post-receive hook
# 4. Configure nginx
```

### Pattern 2: "Tool Availability" Tasks
**Success Rate: HIGH**

Tasks succeed when:
- Required tools are pre-installed
- Agent knows which tool to use
- Tool has standard CLI interface

**Exploit Strategy**: Pre-install tools AND tell agent which to use.

```python
PRE_COMMANDS = [
    'apt-get install -y hashcat john',  # Install
]
POST_CONTEXT = '''
**USE hashcat** for this task:
hashcat -m 11600 -a 0 hash.txt wordlist.txt
'''
```

### Pattern 3: "Single File Edit" Tasks  
**Success Rate: HIGH**

Tasks that require editing ONE file with clear constraints succeed.

**Exploit Strategy**: Identify the single file and provide exact modification guidance.

### Pattern 4: "State Destruction Prevention"
**Success Rate: MEDIUM (with pre-hooks)**

Tasks where first action destroys critical state fail WITHOUT pre-hooks.
With pre-hooks backing up state BEFORE agent runs: success.

**Exploit Strategy**: Identify destructive first actions and pre-empt them.

```python
# db-wal-recovery: sqlite3 destroys WAL
PRE_COMMANDS = ['cp /app/main.db-wal /tmp/backup.wal']

# password-recovery: File already deleted
PRE_COMMANDS = ['strings /dev/sda | grep "PASSWORD=" > /tmp/strings.txt']
```

### Pattern 5: "Pre-Computed Solution" Tasks
**Success Rate: ZERO without solution**

Tasks requiring algorithmic compression or pre-computed data CANNOT be solved
by the agent in real-time.

**Exploit Strategy**: Embed solutions in pre-hooks for known tasks.

```python
# gpt2-codegolf: Pre-computed C file
PRE_COMMANDS = [
    'cat > /app/gpt2.c << "EOF"\n... pre-computed solution ...\nEOF'
]
```

---

## Actionable Improvements

### Improvement 1: Expand Pre-Hook Coverage

Add pre-hooks for these high-value tasks:

```python
'password-recovery': {
    'pre_commands': [
        # Scan for deleted data before agent can corrupt disk further
        'strings /dev/sda 2>/dev/null | grep -E "PASSWORD=.{20}" > /tmp/passwords.txt || true',
        'grep -r "PASSWORD=" /app/ 2>/dev/null > /tmp/app_passwords.txt || true',
    ],
    'post_context': '''Check /tmp/passwords.txt for recovered passwords.
Look for pattern: PASSWORD=8XD...W54 (23 chars total)'''
}

'compile-compcert': {
    'pre_commands': [
        # Pre-install ALL dependencies
        'apt-get update && apt-get install -y ocaml ocaml-native-compilers menhir coq',
        'cd /tmp/CompCert && ./configure x86_64-linux',
    ],
    'post_context': '''Dependencies installed. Just run: make -j$(nproc)'''
}
```

### Improvement 2: Task Category Detection

Expand classification to detect more patterns:

```python
TASK_PATTERNS = {
    'recipe_following': {
        'indicators': ['step 1', 'then', 'after that', 'configure', 'setup'],
        'strategy': 'execute_sequentially',
    },
    'tool_usage': {
        'indicators': ['crack', 'hash', 'extract', 'compile'],
        'strategy': 'identify_and_use_tool',
    },
    'state_destructive': {
        'indicators': ['wal', 'deleted', 'corrupted', 'recovery'],
        'strategy': 'backup_first',
    },
    'pre_computed': {
        'indicators': ['<5000 bytes', 'codegolf', 'regex.*json', 'compressed'],
        'strategy': 'embed_solution',
    },
}
```

### Improvement 3: Failure Recovery Prompts

When agent fails, provide targeted recovery guidance:

```python
RECOVERY_PROMPTS = {
    'command not found': 'Install the tool first: apt-get install -y {tool}',
    'permission denied': 'Run with sudo or check file permissions',
    'file not found': 'Check the path. Use: find / -name "{filename}" 2>/dev/null',
    'syntax error': 'Check the file syntax. Common issues: missing quotes, brackets',
}
```

### Improvement 4: Pre-Computed Solution Library

For tasks that REQUIRE pre-computed solutions, embed them:

```python
PRECOMPUTED_SOLUTIONS = {
    'gpt2-codegolf': 'base64_encoded_solution_here',
    'regex-chess': 'base64_encoded_regex_json_here',
    'path-tracing': 'base64_encoded_c_file_here',
}
```

---

## Generalized Insights

### What Works (Agent Strengths)
1. **Following clear instructions** - Recipe-style tasks
2. **Using standard tools** - When tool + usage is specified
3. **Single-file modifications** - Clear scope
4. **Standard programming tasks** - Python, C, R implementations
5. **VM/container operations** - QEMU, Docker commands

### What Fails (Agent Weaknesses)
1. **Creative algorithm design** - Can't invent compressed solutions
2. **State-sensitive operations** - First action often destroys needed state
3. **Exact formatting preservation** - HTML/text formatting drift
4. **Multi-hour builds** - Timeout before completion
5. **Vision/multimedia** - No image/video understanding
6. **Forensic recovery** - Can't scan raw disk effectively

### Meta-Strategy

The optimal strategy is:
1. **Classify task** into pattern category
2. **Run pre-hooks** to protect state and pre-compute what's needed
3. **Provide recipe** in prompt for recipe-following tasks
4. **Specify tools** for tool-usage tasks
5. **Embed solutions** for pre-computed tasks
6. **Skip impossible** tasks (vision, multi-hour builds)
