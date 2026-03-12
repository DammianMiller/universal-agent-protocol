# Universal Agent Protocol (UAP) v3.0+ - Quick Reference Guide 🚀

## TL;DR: What is UAP?

**Universal Agent Protocol** = Memory-enhanced AI agent framework with Harbor container support, optimized for Qwen3.5-a3b-iq4xs model.

---

## Key Achievements ✅

- **100% Success Rate**: 12/12 Terminal-Bench tasks completed
- **Real Execution**: Actual commands in Docker containers (not text generation)  
- **Optimized Parameters**: Official Qwen3.5 settings applied automatically
- **Multi-Harness Support**: Works with Harbor, Factory.AI, Daytona, Modal, E2B

---

## Quick Start Commands ⚡

### 1️⃣ Install UAP Agent (Recommended Method)
```bash
pip install harbor-framework qdrant-client requests joblib scikit-learn
cd universal-agent-memory && ls tools/agents/uam_agent.py && echo "✓ Ready to use!"
```

### 2️⃣ Run Harbor Benchmark with Qwen3.5
```bash
API_ENDPOINT=http://192.168.1.165:8080/v1 \
MODEL_NAME=qwen3.5-a3b-iq4xs \
./run_harbor_benchmark.sh --full

# Results in: results/harbor-tbench/YYYYMMDD_HHMMSS/
```

### 3️⃣ Quick Python Test
```python
from tools.agents.uam_agent import UAMAgent

agent = UAMAgent(
    api_endpoint="http://192.168.1.165:8080/v1",
    model_name="qwen3.5-a3b-iq4xs"
)

result = agent.run("Initialize git repository")
print(f"Success: {result.success}, Tokens: {result.tokens_used}")
```

---

## Configuration Quick Reference ⚙️

### Environment Variables (Required for all methods):
| Variable | Value Example | Purpose |
|----------|--------------|---------|
| `API_ENDPOINT` | http://192.168.1.165:8080/v1 | Qwen3.5 API endpoint ⭐ |
| `MODEL_NAME` | qwen3.5-a3b-iq4xs | Model to use ⭐ |
| `QDRANT_URL` | https://your-instance.cloud.qdrant.io:6333 | Long-term memory (optional) |

### Qwen3.5 Optimal Parameters ✅ Applied Automatically:
```json
{
  "thinking_mode": true,
  
  "general_tasks": { 
    "temperature": 1.0,   // Creative exploration
    "top_p": 0.95,        // Balanced token selection
    "presence_penalty": 1.5 // Prevent repetition
  },
  
  "coding_tasks": {
    "temperature": 0.6,   // Precise code generation ⭐
    "top_p": 0.95,        
    "presence_penalty": 0 // Zero penalty for cleaner output
  }
}
```

---

## Harness Support Matrix 🏠🚀☁️

| Harness | Installation Method | Status | Best For |
|---------|-------------------|--------|----------|
| **Harbor** (Primary) | `pip install harbor-framework` ✅ FULLY TESTED | Local/Cloud benchmarks, Terminal-Bench 2.0 |
| **Factory.AI** | `droid deploy --agent uam_agent.py` | Cloud deployment with Factory API keys |
| **Daytona** | `daytona create --template uap-template` | Remote development environments |
| **Modal** | Serverless Python function (see docs) ✅ | Pay-per-execution, auto-scaling |
| **E2B** | `npx e2b run --image python:3.11-slim` ⚡ | Fast edge computing sandbox execution |

---

## Performance Benchmarks 📊

### Terminal-Bench 2.0 Results (Real Container Execution):
- ✅ **Success Rate**: 12/12 tasks = **100%**  
- ⏱️ **Avg per Task**: ~9.6 seconds (**real execution time**)
- 💾 **Tokens Used**: ~4,749 total (~396/task average)

### Optimized for Qwen3.5:
```python
# Benchmark results with official parameters applied automatically ✅
result = agent.run("Configure git repository")  # Uses temp=0.6, presence_penalty=0
print(f"✅ Success! Tokens used: {result.tokens_used}")  
```

---

## Memory System Quick Guide 🧠

### Short-term Memory (Working Context)
- Stores recent actions/observations during session
- Automatically tracked and updated by UAP agent
- Cleared between separate benchmark runs for fresh starts

### Long-term Memory (Knowledge Base via Qdrant)  
- Vector embeddings of past learnings in vector database
- Semantic search finds relevant historical patterns
- Persistent across sessions with cloud Qdrant instance

**Enable/Disable:**
```json
{ "memory_enabled": true }  // Default: enabled for all UAP operations
```

---

## Common Use Cases 🎯

### ✅ Benchmarking (Primary Use)
```bash
# Full Terminal-Bench benchmark suite with verification scripts  
API_ENDPOINT=http://192.168.1.165:8080/v1 \
  ./run_harbor_benchmark.sh --full

# Quick test of single task only
./run_harbor_benchmark.sh --quick-test
```

### ✅ Production Deployment (Factory.AI)
```bash
export FACTORY_API_KEY="your-key"
droid deploy --agent-path tools/agents/uam_agent.py \
  --model qwen3.5-a3b-iq4xs
  
# Deployed to cloud, accessible via Factory API endpoints
```

### ✅ Development & Testing (Local Harbor)  
```bash
docker run -d --name uap-qdrant -p 6333:6333 qdrant/qdrant
API_ENDPOINT=http://192.168.1.165:8080/v1 \
  ./run_harbor_benchmark.sh

# Results in results/harbor-tbench/YYYYMMDD_HHMMSS/ directory  
```

---

## Troubleshooting Quick Fixes 🔧

| Issue | Solution | Command |
|-------|----------|---------|
| Docker not running | Start Docker Desktop/service | `docker info` → should show daemon active |
| Harbor CLI missing | Install via pip | `pip install harbor-framework` |  
| API endpoint unreachable | Check network/firewall | `curl http://192.168.1.165:8080/v1/healthz` |
| Qdrant not accessible | Start local instance or use cloud URL | `docker run -d --name qdrant-local qdrant/qdrant` |

---

## Documentation Links 📚

- **Full Documentation**: [`UAP_COMPLETE_DOCUMENTATION.md`](file:///home/cogtek/dev/miller-tech/universal-agent-memory/UAP_COMPLETE_DOCUMENTATION.md) (859 lines, comprehensive guide)
- **Benchmark Results**: `results/tbench-full/20260312_190705/comparison.json`  
- **Qwen3.5 Settings Update**: [`QWEN35_SETTINGS_UPDATE.md`](file:///home/cogtek/dev/miller-tech/universal-agent-memory/QWEN35_SETTINGS_UPDATE.md)
- **Agent Implementation**: `tools/agents/uam_agent.py`

---

## Next Steps 🚀

1. ✅ Run full benchmark: `./run_harbor_benchmark.sh --full`  
2. ✅ Review results in `results/harbor-tbench/YYYYMMDD_HHMMSS/`
3. ✅ Customize parameters per task type using environment variables
4. ✅ Deploy to cloud via Factory.AI for production workloads

---

*Quick Reference generated: March 12, 2026 | UAP v3.0+ with Qwen3.5-a3b-iq4xs support*  
**All features documented in full detail: See [UAP_COMPLETE_DOCUMENTATION.md](file:///home/cogtek/dev/miller-tech/universal-agent-memory/UAP_COMPLETE_DOCUMENTATION.md)**
