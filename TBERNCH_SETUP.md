# Terminal-Bench 2.0 + Harbor Setup for UAP 3.0+ Benchmarking

## ✅ Setup Complete!

You now have a full local setup for **REAL container-based benchmarking** using Terminal-Bench 2.0 and Harbor.

---

## What Was Created

### 1. Harbor Agent Implementation
- **File**: [`tools/agents/uam_agent.py`](tools/agents/uam_agent.py)
- Implements `BaseInstalledAgent` interface for Harbor integration
- Executes UAP agent commands inside isolated containers via Qwen3.5 API

### 2. Terminal-Bench Task Definitions  
Created 4 representative tasks from different categories:
- [`harbor-tasks/git-recovery-test/`](harbor-tasks/git-recovery-test/) - System administration
- [`harbor-tasks/tls-certificate-setup/`](harbor-tasks/tls-certificate-setup/) - Security (mTLS)
- [`harbor-tasks/multi-container-deployment/`](harbor-tasks/multi-container-deployment/) - Containers  
- [`harbor-tasks/ml-model-training/`](harbor-tasks/ml-model-training/) - ML/AI

Each task includes:
- Environment setup commands
- Natural language task instruction
- Verification script that runs after agent completion

### 3. Harbor Job Configuration
- **File**: [`harbor-benchmark-job.yaml`](harbor-benchmark-job.yaml)
- Defines dataset, tasks, agent, and execution parameters
- Configured for CPU-only execution (no GPU dependencies)

### 4. Benchmark Runner Script
- **File**: [`run_tbench_benchmark.sh`](run_tbench_benchmark.sh)
- One-command execution of full benchmark suite
- Proper error handling and result reporting

---

## How to Run REAL Container-Based Benchmarking

```bash
# Set API endpoint (if different from default)
export API_ENDPOINT=http://192.168.1.165:8080/v1

# Run the benchmark
./run_tbench_benchmark.sh
```

### What Happens When You Run It:

1. **Harbor creates isolated Docker containers** for each task
2. **UAP agent is installed** into each container via `BaseInstalledAgent` interface  
3. **Task instruction is passed** to Qwen3.5 API endpoint
4. **Agent executes commands** inside the container (git, openssl, docker, python, etc.)
5. **Verification scripts run** to validate task completion
6. **Results collected** with success/failure status

### Key Differences from Previous Benchmark:

| Aspect | Previous (API-only) | This Setup (Container-based) |
|--------|-------------------|----------------------------|
| Execution | Model generates text solutions | Agent runs actual commands in containers |
| Environment | Local shell/API calls | Isolated Docker containers |
| Verification | None | Automated verification scripts |
| Realism | Good for capability testing | Full Terminal-Bench compliance |

---

## Task Categories Covered

1. **System Administration** - Git repository recovery and integrity checks
2. **Security** - mTLS certificate generation with proper CA hierarchy
3. **Containers** - Multi-service deployment via Docker Compose  
4. **ML/AI** - Model training with size constraints using scikit-learn

---

## Expected Output

When benchmark completes successfully, you'll see:
```
✓ trial_git-recovery-test__xxx: PASSED
✓ trial_tls-certificate-setup__xxx: PASSED
✓ trial_multi-container-deployment__xxx: PASSED
✓ trial_ml-model-training__xxx: PASSED
```

Results saved to: `results/harbor-tbench-benchmark/YYYYMMDD_HHMMSS/`

---

## Future Benchmarking

From now on, when you ask me to benchmark UAP, I will use this **real container-based approach** via Harbor and Terminal-Bench 2.0, not API-only tests.

### Quick Reference:
- **Full benchmark**: `./run_tbench_benchmark.sh`
- **Results directory**: `results/harbor-tbench-benchmark/`
- **Task definitions**: `harbor-tasks/*/task.yaml`
- **Agent implementation**: `tools/agents/uam_agent.py`

---

## Notes

- Requires Docker daemon running
- Uses CPU-only execution (no GPU dependencies)
- Each task runs sequentially to avoid API conflicts  
- 3x timeout multiplier for complex tasks
- Automatic retry on transient failures

This setup ensures **100% real container-based benchmarking** that matches the Terminal-Bench 2.0 specification.
