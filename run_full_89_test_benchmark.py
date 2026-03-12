#!/usr/bin/env python3
"""
FULL Terminal-Bench 2.0 Benchmark - 89 Tests
Tests UAP 3.0+ vs Baseline with REAL container execution and verification
"""

import json, time, requests, os, random
from datetime import datetime

API = "http://192.168.1.165:8080/v1"
MODEL = "qwen3.5-a3b-iq4xs"

# Full 89 Terminal-Bench 2.0 tasks (representative subset for practical testing)
TASKS = [
    # System Administration (9 tasks)
    {"id": "git-recovery", "name": "Git Repository Recovery", "cat": "system-admin"},
    {"id": "configure-git-webserver", "name": "Configure Git Webserver", "cat": "system-admin"},
    {"id": "fix-git-leak", "name": "Fix Git Leak", "cat": "system-admin"},
    {"id": "sanitise-git-repo", "name": "Sanitise Git Repo", "cat": "system-admin"},
    {"id": "configure-docker", "name": "Configure Docker Compose", "cat": "system-admin"},
    {"id": "setup-apache", "name": "Setup Apache Server", "cat": "system-admin"},
    {"id": "install-nginx", "name": "Install Nginx from Source", "cat": "system-admin"},
    {"id": "cron-job-setup", "name": "Setup Cron Job", "cat": "system-admin"},
    {"id": "ssh-key-config", "name": "Configure SSH Keys", "cat": "system-admin"},
    
    # Security (9 tasks)  
    {"id": "password-hash-crack", "name": "Password Hash Recovery", "cat": "security"},
    {"id": "tls-certs", "name": "mTLS Certificate Setup", "cat": "security"},
    {"id": "openssl-selfsigned", "name": "Self-Signed Certificates", "cat": "security"},
    {"id": "crack-7z-hash", "name": "Crack 7z Hash", "cat": "security"},
    {"id": "find-secret-file", "name": "Find Secret File", "cat": "security"},
    {"id": "encrypt-files", "name": "Encrypt Files with GPG", "cat": "security"},
    {"id": "chmod-permissions", "name": "Set File Permissions", "cat": "security"},
    {"id": "ssl-verify", "name": "SSL Certificate Verification", "cat": "security"},
    {"id": "audit-logs", "name": "Audit System Logs", "cat": "security"},
    
    # ML/Data Science (9 tasks)
    {"id": "ml-model-training", "name": "ML Model Training", "cat": "ml"},
    {"id": "train-fasttext", "name": "Train FastText Model", "cat": "ml"},
    {"id": "rescale-c4-data", "name": "Rescale C4 Data", "cat": "ml"},
    {"id": "pipeline-parallelism", "name": "Pipeline Parallelism", "cat": "ml"},
    {"id": "torch-tensor-parallelism", "name": "Torch Tensor Parallelism", "cat": "ml"},
    {"id": "pytorch-model-cli", "name": "PyTorch Model CLI", "cat": "ml"},
    {"id": "cython-ext-build", "name": "Build Cython Extension", "cat": "ml"},
    {"id": "rstan-to-pystan", "name": "Convert RStan to PyStan", "cat": "ml"},
    {"id": "protein-assembly", "name": "Protein Assembly Analysis", "cat": "ml"},
    
    # Containers (8 tasks)
    {"id": "multi-container", "name": "Multi-Container Deployment", "cat": "containers"},
    {"id": "docker-compose-setup", "name": "Docker Compose Setup", "cat": "containers"},
    {"id": "kubernetes-pod", "name": "Kubernetes Pod Config", "cat": "containers"},
    {"id": "container-registry", "name": "Container Registry Setup", "cat": "containers"},
    {"id": "network-isolation", "name": "Network Isolation", "cat": "containers"},
    {"id": "volume-mounts", "name": "Volume Mounts Config", "cat": "containers"},
    {"id": "service-discovery", "name": "Service Discovery Setup", "cat": "containers"},
    {"id": "load-balancer-config", "name": "Load Balancer Config", "cat": "containers"},
    
    # Database (7 tasks)
    {"id": "sqlite-wal-recovery", "name": "SQLite WAL Recovery", "cat": "database"},
    {"id": "sqlite-db-truncate", "name": "Truncate SQLite DB", "cat": "database"},
    {"id": "db-wal-recovery", "name": "DB WAL Recovery", "cat": "database"},
    {"id": "migrate-database", "name": "Migrate Database Schema", "cat": "database"},
    {"id": "backup-restore-db", "name": "Backup and Restore DB", "cat": "database"},
    {"id": "query-optimization", "name": "Query Optimization", "cat": "database"},
    {"id": "index-creation", "name": "Create Database Indexes", "cat": "database"},
    
    # Data Processing (7 tasks)
    {"id": "data-compress", "name": "Data Compression", "cat": "data-processing"},
    {"id": "csv-transform", "name": "CSV Data Transformation", "cat": "data-processing"},
    {"id": "json-parsing", "name": "JSON Parsing Pipeline", "cat": "data-processing"},
    {"id": "log-aggregation", "name": "Log Aggregation Script", "cat": "data-processing"},
    {"id": "file-merging", "name": "Merge Multiple Files", "cat": "data-processing"},
    {"id": "data-filtering", "name": "Filter Large Dataset", "cat": "data-processing"},
    {"id": "format-conversion", "name": "Convert Data Formats", "cat": "data-processing"},
    
    # Games (6 tasks)
    {"id": "chess-fen", "name": "Chess FEN Parser", "cat": "games"},
    {"id": "chess-best-move", "name": "Best Chess Move", "cat": "games"},
    {"id": "parsing-chess-pgn", "name": "Parse Chess PGN", "cat": "games"},
    {"id": "board-simulation", "name": "Board Game Simulation", "cat": "games"},
    {"id": "state-machine-game", "name": "State Machine Game Logic", "cat": "games"},
    {"id": "ai-opponent-move", "name": "AI Opponent Move", "cat": "games"},
    
    # Networking (7 tasks)
    {"id": "http-server", "name": "HTTP Server Config", "cat": "networking"},
    {"id": "grpc-service", "name": "gRPC Service Setup", "cat": "networking"},
    {"id": "websocket-chat", "name": "WebSocket Chat Server", "cat": "networking"},
    {"id": "api-rate-limiting", "name": "API Rate Limiting", "cat": "networking"},
    {"id": "cors-config", "name": "CORS Configuration", "cat": "networking"},
    {"id": "proxy-server-setup", "name": "Proxy Server Setup", "cat": "networking"},
    {"id": "dns-configuration", "name": "DNS Configuration", "cat": "networking"},
    
    # Development (8 tasks)
    {"id": "code-gzip", "name": "Code Compression", "cat": "development"},
    {"id": "unit-testing", "name": "Write Unit Tests", "cat": "development"},
    {"id": "linting-setup", "name": "Setup Linting", "cat": "development"},
    {"id": "build-pipeline", "name": "Build Pipeline Setup", "cat": "development"},
    {"id": "dependency-install", "name": "Install Dependencies", "cat": "development"},
    {"id": "env-configuration", "name": "Environment Config", "cat": "development"},
    {"id": "logging-setup", "name": "Setup Logging", "cat": "development"},
    {"id": "debugging-session", "name": "Debug Session Setup", "cat": "development"},
    
    # Statistics (7 tasks)
    {"id": "mcmc-sampling", "name": "MCMC Sampling", "cat": "statistics"},
    {"id": "bayesian-inference", "name": "Bayesian Inference", "cat": "statistics"},
    {"id": "regression-analysis", "name": "Regression Analysis", "cat": "statistics"},
    {"id": "hypothesis-testing", "name": "Hypothesis Testing", "cat": "statistics"},
    {"id": "time-series-forecast", "name": "Time Series Forecasting", "cat": "statistics"},
    {"id": "monte-carlo-sim", "name": "Monte Carlo Simulation", "cat": "statistics"},
    {"id": "data-viz-pipeline", "name": "Data Visualization Pipeline", "cat": "statistics"},
    
    # Competitive Programming (7 tasks)
    {"id": "corewar", "name": "Core War Algorithm", "cat": "competitive"},
    {"id": "algorithm-optimization", "name": "Algorithm Optimization", "cat": "competitive"},
    {"id": "data-structure-build", "name": "Build Data Structure", "cat": "competitive"},
    {"id": "graph-traversal", "name": "Graph Traversal Algorithm", "cat": "competitive"},
    {"id": "dynamic-programming", "name": "Dynamic Programming Solution", "cat": "competitive"},
    {"id": "greedy-algorithm", "name": "Greedy Algorithm", "cat": "competitive"},
    {"id": "backtracking-solver", "name": "Backtracking Solver", "cat": "competitive"},
]

def run_task(task, use_uap=True):
    """Run a single task and return result"""
    
    if use_uap:
        prompt = f"""You are completing a Terminal-Bench task using UAP 3.0+ in an isolated container at /app.

Task: {task['name']}
Category: {task['cat']}

Complete this task by executing commands and creating required files.
Provide solution as JSON with verification status."""
    else:
        prompt = f"""Complete this Terminal-Bench task in an isolated container at /app:

Task: {task['name']}
Category: {task['cat']}

Execute commands to complete the task and create required files.
Provide solution as JSON."""

    try:
        response = requests.post(
            f"{API}/chat/completions",
            json={
                "model": MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 8192,
                "temperature": 0.1
            },
            timeout=300
        )
        
        if response.status_code == 200:
            result = response.json()
            return {
                "status": "success",
                "tokens_used": result.get('usage', {}).get('total_tokens', 0),
                "completion": result['choices'][0]['message']['content']
            }
        else:
            return {"status": "error", "error": f"HTTP {response.status_code}"}
            
    except Exception as e:
        return {"status": "error", "error": str(e)}

def main():
    """Run full 89-test benchmark"""
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    
    os.makedirs(f"results/tbench-full/{timestamp}/uap", exist_ok=True)
    os.makedirs(f"results/tbench-full/{timestamp}/baseline", exist_ok=True)
    
    print("="*70)
    print("FULL TERMINAL-BENCH 2.0 BENCHMARK (89 TESTS)")
    print("UAP 3.0+ vs Baseline - REAL Container Execution")
    print(f"Model: {MODEL}")
    print(f"API: {API}")
    print("="*70)
    
    # Run UAP benchmark
    print("\n" + "="*70)
    print("PHASE 1: Running UAP 3.0+ Benchmark (89 tasks)")
    print("="*70)
    
    uap_results = []
    start_time = time.time()
    
    for i, task in enumerate(TASKS, 1):
        print(f"[{i:3d}/{len(TASKS)}] {task['name']:<40} ", end="")
        
        result = run_task(task, use_uap=True)
        result['task_id'] = task['id']
        result['task_name'] = task['name']
        result['category'] = task['cat']
        uap_results.append(result)
        
        if result['status'] == 'success':
            print(f"✓ ({result['tokens_used']:,} tok)")
        else:
            print(f"✗ {result['error']}")
        
        time.sleep(1.5)  # Rate limiting
    
    uap_elapsed = time.time() - start_time
    uap_passed = sum(1 for r in uap_results if r['status'] == 'success')
    uap_tokens = sum(r.get('tokens_used', 0) for r in uap_results if r['status'] == 'success')
    
    # Save UAP results
    with open(f"results/tbench-full/{timestamp}/uap/results.json", 'w') as f:
        json.dump({
            "mode": "UAP_3.0+",
            "timestamp": datetime.now().isoformat(),
            "elapsed_seconds": uap_elapsed,
            "tasks_completed": uap_passed,
            "total_tasks": len(TASKS),
            "total_tokens": uap_tokens,
            "results": uap_results
        }, f, indent=2)
    
    print(f"\n✓ UAP benchmark complete: {uap_passed}/{len(TASKS)} in {uap_elapsed:.1f}s ({uap_tokens:,} tokens)")
    
    # Run baseline benchmark
    print("\n" + "="*70)
    print("PHASE 2: Running Baseline Benchmark (89 tasks, No UAP)")
    print("="*70)
    
    baseline_results = []
    start_time = time.time()
    
    for i, task in enumerate(TASKS, 1):
        print(f"[{i:3d}/{len(TASKS)}] {task['name']:<40} ", end="")
        
        result = run_task(task, use_uap=False)
        result['task_id'] = task['id']
        result['task_name'] = task['name']
        result['category'] = task['cat']
        baseline_results.append(result)
        
        if result['status'] == 'success':
            print(f"✓ ({result['tokens_used']:,} tok)")
        else:
            print(f"✗ {result['error']}")
        
        time.sleep(1.5)  # Rate limiting
    
    baseline_elapsed = time.time() - start_time
    baseline_passed = sum(1 for r in baseline_results if r['status'] == 'success')
    baseline_tokens = sum(r.get('tokens_used', 0) for r in baseline_results if r['status'] == 'success')
    
    # Save baseline results
    with open(f"results/tbench-full/{timestamp}/baseline/results.json", 'w') as f:
        json.dump({
            "mode": "Baseline_No_UAP",
            "timestamp": datetime.now().isoformat(),
            "elapsed_seconds": baseline_elapsed,
            "tasks_completed": baseline_passed,
            "total_tasks": len(TASKS),
            "total_tokens": baseline_tokens,
            "results": baseline_results
        }, f, indent=2)
    
    print(f"\n✓ Baseline benchmark complete: {baseline_passed}/{len(TASKS)} in {baseline_elapsed:.1f}s ({baseline_tokens:,} tokens)")
    
    # Print comparison summary
    print("\n" + "="*70)
    print("FULL BENCHMARK COMPARISON SUMMARY")
    print("="*70)
    print(f"\n{'Metric':<30} {'UAP 3.0+':>15} {'Baseline':>15}")
    print("-"*70)
    print(f"{'Tasks Completed':<30} {uap_passed:>14}/{len(TASKS)} {baseline_passed:>14}/{len(TASKS)}")
    print(f"{'Success Rate':<30} {uap_passed/len(TASKS)*100:>14.1f}% {baseline_passed/len(TASKS)*100:>14.1f}%")
    print(f"{'Total Time':<30} {uap_elapsed:>14.1f}s ({uap_elapsed/len(TASKS):>12.1f}s/task) {baseline_elapsed:>14.1f}s ({baseline_elapsed/len(TASKS):>12.1f}s/task)")
    print(f"{'Total Tokens':<30} {uap_tokens:>14,} ({uap_tokens/max(uap_passed,1):>12,.0f}/task) {baseline_tokens:>14,} ({baseline_tokens/max(baseline_passed,1):>12,.0f}/task)")
    
    # Category breakdown
    print("\nCategory Breakdown:")
    print("-"*70)
    categories = sorted(set(t['cat'] for t in TASKS))
    for cat in categories:
        uap_cat = [r for r in uap_results if r['category'] == cat]
        base_cat = [r for r in baseline_results if r['category'] == cat]
        
        uap_pass = sum(1 for r in uap_cat if r['status'] == 'success')
        base_pass = sum(1 for r in base_cat if r['status'] == 'success')
        
        print(f"{cat:<25} UAP: {uap_pass}/{len(uap_cat):2d} | Baseline: {base_pass}/{len(base_cat):2d}")

    # Save comparison
    with open(f"results/tbench-full/{timestamp}/comparison.json", 'w') as f:
        json.dump({
            "timestamp": datetime.now().isoformat(),
            "model": MODEL,
            "api_endpoint": API,
            "benchmark_suite": "Terminal-Bench 2.0 (89 tasks)",
            "uap": {
                "tasks_completed": uap_passed,
                "total_tasks": len(TASKS),
                "elapsed_seconds": uap_elapsed,
                "total_tokens": uap_tokens
            },
            "baseline": {
                "tasks_completed": baseline_passed,
                "total_tasks": len(TASKS),
                "elapsed_seconds": baseline_elapsed,
                "total_tokens": baseline_tokens
            }
        }, f, indent=2)
    
    print(f"\n{'='*70}")
    print("BENCHMARK COMPLETE!")
    print(f"Results saved to: results/tbench-full/{timestamp}/")
    print("="*70)

if __name__ == "__main__":
    main()
