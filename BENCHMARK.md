# UAP 3.0+ Benchmark - Terminal-Bench via Harbor

## Overview
Real benchmarking of UAM v3.0+ with Qwen3.5 using Harbor containers for isolated Terminal-Bench evaluation.

## Prerequisites
```bash
pip install harbor-framework
docker ps > /dev/null 2>&1  # Ensure Docker is running
curl http://192.168.1.165:8080/v1/health  # Verify API endpoint
```

## Usage

### Quick Test (1 task)
```bash
./run_harbor_benchmark.sh --quick-test
```

### Full Suite (4 tasks)
```bash
./run_harbor_benchmark.sh --full
```

## Tasks
- git-recovery-test: Repository integrity via fsck/reflog
- tls-certificate-setup: mTLS certs with proper CA hierarchy
- multi-container-deployment: Docker-compose nginx + Python services  
- ml-model-training: sklearn classifier <1MB size constraint

## Results
Results saved to `results/harbor-benchmark/YYYYMMDD_HHMMSS/`

## Architecture
```
Harbor Orchestrator -> Isolated Container -> UAM Agent -> 
Qwen3.5 API -> Verification Script -> Success/Failure Report
```
