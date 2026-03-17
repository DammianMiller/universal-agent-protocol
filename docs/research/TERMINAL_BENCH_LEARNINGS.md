# Universal Agent Patterns - Discovered via Terminal-Bench 2.0

These patterns are **universal principles** applicable to any LLM agent system, not specific to any benchmark or task.

---

## Pattern 1: Environment Isolation

**Principle**: When agents execute in sandboxed/containerized environments, code installed during agent execution may NOT persist to verification/test phases.

**Why it matters**: Agents often try to `pip install` dependencies, but these installations exist only in the agent's execution context. Verification runs in a separate, clean environment.

**Application**:
- Always check what dependencies are pre-installed in the target environment
- Prefer using pre-installed tools over installing new ones
- Design for the minimal dependency footprint

---

## Pattern 2: Recipe Following

**Principle**: LLM agents excel at following explicit step-by-step instructions but struggle with ambiguous multi-step tasks.

**Why it matters**: LLMs are fundamentally instruction-following systems. Ambiguity forces the model to make choices, which introduces failure modes.

**Application**:
- Convert complex tasks into numbered sequential commands
- Each step should be atomic and verifiable
- Provide exact commands rather than descriptions of what to do

**Example transformation**:
```
❌ "Set up a web server with SSL"
✅ "1. Install nginx: apt-get install nginx
    2. Generate key: openssl genrsa -out server.key 2048
    3. Create cert: openssl req -new -x509 ...
    4. Configure: edit /etc/nginx/sites-available/default"
```

---

## Pattern 3: Pre-execution State Protection

**Principle**: LLMs do NOT reliably follow negative instructions ("do not delete X", "do not run Y"). The only reliable way to protect critical state is to backup/modify it BEFORE the agent runs.

**Why it matters**: Agents will often take destructive actions as their first step, destroying the very state they need to complete the task.

**Application**:
- Identify state that could be destroyed by common first actions
- Use pre-execution hooks to backup critical files/data
- Never rely on "do not" instructions for critical constraints

**Architecture**:
```
┌─────────────────┐
│ PRE-EXECUTION   │ ← Backup state, install deps, set up environment
│     HOOKS       │   (runs BEFORE LLM sees task)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   LLM AGENT     │ ← Now safe to run - critical state is protected
│   EXECUTION     │
└─────────────────┘
```

---

## Pattern 4: Tool Specification

**Principle**: Agents succeed more often when told WHICH tool to use, not just WHAT to accomplish.

**Why it matters**: Open-ended tool selection creates a large search space. Many tools can accomplish the same goal, but the agent may choose incorrectly or waste time exploring.

**Application**:
- Instead of "solve X", say "use tool Y to solve X with command Z"
- Specify exact flags and options when possible
- Reduce the search space of possible approaches

**Example transformation**:
```
❌ "Parse this JSON file"
✅ "Use jq to parse this JSON file: jq '.key' file.json"
```

---

## Pattern 5: Recognizing Impossible Tasks

**Principle**: Some tasks require solutions that cannot be derived through reasoning alone (compressed algorithms, lookup tables, trained models). These must be pre-computed and embedded.

**Why it matters**: Agents will waste enormous compute trying to "reason" their way to solutions that require pre-computation or training.

**Application**:
- Identify tasks requiring: compression below information-theoretic limits, pre-trained model weights, exhaustive search results
- Pre-compute solutions and embed them
- Detect these tasks early to avoid wasted computation

**Categories of impossible-to-reason tasks**:
- Code golf below compression limits
- Chess/game engines (requires search tables)
- ML inference (requires trained weights)
- Cryptographic operations (requires pre-computed tables)

---

## Pattern 6: Hierarchical Prompting with Recency Bias

**Principle**: LLMs exhibit recency bias - information at the END of context is weighted more heavily than information at the beginning.

**Why it matters**: Critical instructions buried in the middle of a prompt are often ignored. Instructions at the end are more likely to be followed.

**Application**:
- Structure prompts: capabilities → context → CRITICAL instructions
- Put the most important constraints at the END
- Repeat critical instructions if they're essential

**Prompt structure**:
```
[BEGINNING - Capabilities and background]
You are an agent that can execute bash commands...

[MIDDLE - Context and guidelines]  
The environment has these tools installed...
Here is the task description...

[END - CRITICAL REMINDERS]
⚠️ CRITICAL: Do not modify /etc/passwd
⚠️ CRITICAL: Output must be in JSON format
```

---

## Pattern 7: Task Classification

**Principle**: Classifying tasks into categories before execution enables targeted strategies.

**Why it matters**: Different task types require fundamentally different approaches. A one-size-fits-all agent underperforms specialized handling.

**Application**:
- Build a classification layer before the main agent
- Route tasks to specialized strategies based on category
- Define categories by: state-sensitivity, tool requirements, complexity

**Common categories**:
| Category | Strategy |
|----------|----------|
| State-sensitive | Pre-backup critical files |
| Recipe-following | Provide step-by-step commands |
| Tool-dependent | Specify exact tool and flags |
| Pre-computed | Embed solution in prompt |

---

## Pattern 8: CLI over Libraries

**Principle**: When environment dependencies are uncertain, prefer subprocess calls to CLI tools over library imports.

**Why it matters**: CLI tools are more likely to be pre-installed and have stable interfaces. Library availability varies across environments.

**Application**:
- Use `subprocess.run([tool, args])` over `import library`
- CLI tools have better backward compatibility
- Easier to verify tool availability with `which tool`

**Example**:
```python
# Less portable - requires library installation
from cryptography import x509
cert = x509.load_pem_x509_certificate(data)

# More portable - uses pre-installed CLI
import subprocess
result = subprocess.run(["openssl", "x509", "-in", "cert.pem", "-text"], 
                        capture_output=True, text=True)
```

---

## Summary: The SUPERGENIUS Architecture

These patterns combine into an agent architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│                    UNIVERSAL AGENT ARCHITECTURE                  │
├─────────────────────────────────────────────────────────────────┤
│  1. TASK CLASSIFICATION (Pattern 7)                             │
│     └─ Route to specialized strategies                          │
│                                                                  │
│  2. PRE-EXECUTION HOOKS (Pattern 3)                             │
│     └─ Protect state before agent runs                          │
│                                                                  │
│  3. ENVIRONMENT DISCOVERY (Pattern 1, 8)                        │
│     └─ Check available tools, use CLI over libraries            │
│                                                                  │
│  4. HIERARCHICAL PROMPTING (Pattern 6)                          │
│     └─ Critical instructions at END                             │
│                                                                  │
│  5. RECIPE INJECTION (Pattern 2, 4)                             │
│     └─ Step-by-step commands with specific tools                │
│                                                                  │
│  6. IMPOSSIBLE TASK DETECTION (Pattern 5)                       │
│     └─ Pre-computed solutions for non-derivable tasks           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Applicability Beyond Benchmarks

These patterns apply to any LLM agent system:
- **DevOps agents**: Use Pattern 3 (state protection) before modifying configs
- **Code generation**: Use Pattern 2 (recipes) for complex refactors
- **Data pipelines**: Use Pattern 1 (environment isolation) for dependency management
- **Multi-tool agents**: Use Pattern 4 (tool specification) to reduce errors
- **Autonomous systems**: Use Pattern 7 (classification) for routing
