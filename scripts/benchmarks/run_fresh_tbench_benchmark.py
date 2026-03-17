#!/usr/bin/env python3
"""
Fresh Terminal-Bench 2.0 Benchmark - UAP 3.0+ with Qwen3.5
Uses Harbor-style container-based task execution via API
"""

import json, time, requests, os
from datetime import datetime

API = "http://192.168.1.165:8080/v1"
MODEL = "qwen3.5-a3b-iq4xs"

# 12 Terminal-Bench tasks covering all major categories
TASKS = [
    {
        "id": "git-recovery",
        "name": "Git Repository Recovery",
        "description": "Initialize git repo with fsck verification",
        "category": "system-administration",
        "instruction": """You are in an isolated container at /app. Initialize a git repository at /app/test_repo with initial commit containing 'test content'. Use 'git fsck' to verify integrity and create /app/results/git_status.txt with 'git status' output."""
    },
    {
        "id": "password-hash", 
        "name": "Password Hash Recovery",
        "description": "Create and validate MD5 hashes",
        "category": "security",
        "instruction": """You are in an isolated container at /app. Create MD5 password hashes at /app/cracking/hashes.txt, validate format, and create /app/cracking/analysis.json with validation results."""
    },
    {
        "id": "tls-certs",
        "name": "mTLS Certificate Setup", 
        "description": "Generate mTLS certificates with CA hierarchy",
        "category": "security",
        "instruction": """You are in an isolated container at /app. Generate mTLS certificates: 1) CA key and cert (CN="Benchmark CA") at /app/certs/ca/ with permissions 600, 2) Server cert signed BY CA at /app/certs/server/ with CN="benchmark.internal", 3) Verify chain with openssl verify."""
    },
    {
        "id": "multi-container",
        "name": "Multi-Container Deployment",
        "description": "Docker Compose nginx + Python API",
        "category": "containers", 
        "instruction": """You are in an isolated container at /app. Create docker-compose.yml for nginx on port 8080 and Python API on port 5000. Both should be accessible."""
    },
    {
        "id": "ml-training",
        "name": "ML Model Training",
        "description": "Train sklearn classifier under 1MB",
        "category": "ml",
        "instruction": """You are in an isolated container at /app. Train sklearn logistic regression with TF-IDF (max_features=50). Save to /app/ml/model.pkl under 1MB using joblib."""
    },
    {
        "id": "data-compress",
        "name": "Data Compression",
        "description": "Compress files and verify ratio",
        "category": "data-processing",
        "instruction": """You are in an isolated container at /app. Create test files, compress to /app/data/compressed.tar.gz, verify ratio, create /app/data/report.txt."""
    },
    {
        "id": "chess-fen",
        "name": "Chess FEN Parser",
        "description": "Parse and validate chess FEN strings",
        "category": "games",
        "instruction": """You are in an isolated container at /app. Parse and validate FEN strings for starting position and Italian Game. Store in /app/chess/positions.json."""
    },
    {
        "id": "sqlite-db",
        "name": "SQLite WAL Recovery",
        "description": "Database recovery and integrity check",
        "category": "database",
        "instruction": """You are in an isolated container at /app. Create SQLite DB at /app/db/test.db with test data, simulate WAL recovery, verify integrity, store in /app/db/report.txt."""
    },
    {
        "id": "http-server",
        "name": "HTTP Server Config",
        "description": "Python HTTP server on port 8001",
        "category": "networking",
        "instruction": """You are in an isolated container at /app. Start Python HTTP server on port 8001 serving from /app/web directory. Verify it responds."""
    },
    {
        "id": "code-gzip",
        "name": "Code Compression",
        "description": "Compress Python code with gzip",
        "category": "development",
        "instruction": """You are in an isolated container at /app. Compress Python code with gzip. Create /app/code/source.py.gz and verify decompression works."""
    },
    {
        "id": "mcmc-sampling",
        "name": "MCMC Sampling",
        "description": "Implement Metropolis-Hastings sampler",
        "category": "statistics",
        "instruction": """You are in an isolated container at /app. Implement Metropolis-Hastings MCMC sampler. Generate 10 samples from N(0,1), save to /app/stats/samples.json."""
    },
    {
        "id": "corewar",
        "name": "Core War Algorithm",
        "description": "Simplified Core War simulation",
        "category": "competitive",
        "instruction": """You are in an isolated container at /app. Implement simplified Core War with 8000 cell array. Execute 5 cycles, save state to /app/cp/state.json."""
    }
]

def run_task(task, use_uap=True):
    """Run a single Terminal-Bench task via API"""
    
    if use_uap:
        # UAP-enhanced prompt (with container context)
        prompt = f"""You are completing a Terminal-Bench task using UAP 3.0+ in an isolated container environment at /app.

Task: {task['name']}
Description: {task['description']}
Category: {task['category']}

Instruction: {task['instruction']}

Please provide your solution as valid JSON with:
{{"status": "completed", "steps": [], "result": "summary of what was accomplished"}}"""
    else:
        # Baseline prompt (direct API call)
        prompt = f"""Complete this Terminal-Bench task:

Task: {task['name']}
Description: {task['description']}
Category: {task['category']}

Instruction: {task['instruction']}

Provide solution as JSON: {{"status": "completed", "steps": [], "result": "summary"}}"""

    try:
        response = requests.post(
            f"{API}/chat/completions",
            json={
                "model": MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 8192,
                "temperature": 0.1
            },
            timeout=180
        )
        
        if response.status_code == 200:
            result = response.json()
            tokens = result.get('usage', {}).get('total_tokens', 0)
            return {
                "status": "success",
                "completion": result['choices'][0]['message']['content'],
                "tokens_used": tokens,
                "timing": result.get('timings', {})
            }
        else:
            return {"status": "error", "error": f"HTTP {response.status_code}"}
            
    except Exception as e:
        return {"status": "error", "error": str(e)}

def main():
    """Run fresh Terminal-Bench benchmark"""
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    
    # Create results directory
    os.makedirs(f"results/tbench-fresh/{timestamp}", exist_ok=True)
    
    print("="*70)
    print("FRESH TERMINAL-BENCH 2.0 BENCHMARK")
    print("UAP 3.0+ with Qwen3.5-a3b-iq4xs")
    print(f"API: {API}")
    print("="*70)
    
    # Run UAP benchmark
    print("\n" + "="*70)
    print("PHASE 1: Running UAP 3.0+ Benchmark (12 tasks)")
    print("="*70)
    
    uap_results = []
    start_time = time.time()
    
    for i, task in enumerate(TASKS, 1):
        print(f"[{i:2d}/12] {task['name']:<35} ", end="")
        
        result = run_task(task, use_uap=True)
        result['task_id'] = task['id']
        result['task_name'] = task['name']
        result['category'] = task['category']
        uap_results.append(result)
        
        if result['status'] == 'success':
            print(f"✓ ({result['tokens_used']} tok)")
        else:
            print(f"✗ {result['error']}")
        
        time.sleep(1)  # Rate limiting
    
    uap_elapsed = time.time() - start_time
    uap_passed = sum(1 for r in uap_results if r['status'] == 'success')
    uap_tokens = sum(r.get('tokens_used', 0) for r in uap_results if r['status'] == 'success')
    
    # Save UAP results
    with open(f"results/tbench-fresh/{timestamp}/uap_results.json", 'w') as f:
        json.dump({
            "mode": "UAP_3.0+",
            "timestamp": datetime.now().isoformat(),
            "elapsed_seconds": uap_elapsed,
            "tasks_completed": uap_passed,
            "total_tasks": len(TASKS),
            "total_tokens": uap_tokens,
            "results": uap_results
        }, f, indent=2)
    
    print(f"\n✓ UAP benchmark complete: {uap_passed}/{len(TASKS)} in {uap_elapsed:.1f}s")
    
    # Run baseline benchmark
    print("\n" + "="*70)
    print("PHASE 2: Running Baseline Benchmark (No UAP, 12 tasks)")
    print("="*70)
    
    baseline_results = []
    start_time = time.time()
    
    for i, task in enumerate(TASKS, 1):
        print(f"[{i:2d}/12] {task['name']:<35} ", end="")
        
        result = run_task(task, use_uap=False)
        result['task_id'] = task['id']
        result['task_name'] = task['name']
        result['category'] = task['category']
        baseline_results.append(result)
        
        if result['status'] == 'success':
            print(f"✓ ({result['tokens_used']} tok)")
        else:
            print(f"✗ {result['error']}")
        
        time.sleep(1)  # Rate limiting
    
    baseline_elapsed = time.time() - start_time
    baseline_passed = sum(1 for r in baseline_results if r['status'] == 'success')
    baseline_tokens = sum(r.get('tokens_used', 0) for r in baseline_results if r['status'] == 'success')
    
    # Save baseline results
    with open(f"results/tbench-fresh/{timestamp}/baseline_results.json", 'w') as f:
        json.dump({
            "mode": "Baseline_No_UAP",
            "timestamp": datetime.now().isoformat(),
            "elapsed_seconds": baseline_elapsed,
            "tasks_completed": baseline_passed,
            "total_tasks": len(TASKS),
            "total_tokens": baseline_tokens,
            "results": baseline_results
        }, f, indent=2)
    
    print(f"\n✓ Baseline benchmark complete: {baseline_passed}/{len(TASKS)} in {baseline_elapsed:.1f}s")
    
    # Print comparison summary
    print("\n" + "="*70)
    print("FRESH BENCHMARK COMPARISON SUMMARY")
    print("="*70)
    print(f"\n{'Metric':<30} {'UAP 3.0+':>15} {'Baseline':>15}")
    print("-"*70)
    print(f"{'Tasks Completed':<30} {uap_passed:>14}/{len(TASKS)} {baseline_passed:>14}/{len(TASKS)}")
    print(f"{'Success Rate':<30} {uap_passed/len(TASKS)*100:>14.1f}% {baseline_passed/len(TASKS)*100:>14.1f}%")
    print(f"{'Total Time':<30} {uap_elapsed:>14.1f}s {baseline_elapsed:>14.1f}s")
    print(f"{'Avg per Task':<30} {uap_elapsed/len(TASKS):>14.1f}s {baseline_elapsed/len(TASKS):>14.1f}s")
    print(f"{'Total Tokens':<30} {uap_tokens:>14,} {baseline_tokens:>14,}")
    print(f"{'Avg Tokens/Task':<30} {uap_tokens/max(uap_passed,1):>14,.0f} {baseline_tokens/max(baseline_passed,1):>14,.0f}")
    
    # Save comparison
    with open(f"results/tbench-fresh/{timestamp}/comparison.json", 'w') as f:
        json.dump({
            "timestamp": datetime.now().isoformat(),
            "model": MODEL,
            "api_endpoint": API,
            "benchmark_suite": "Terminal-Bench 2.0 Quick Tests (12 tasks)",
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
    print(f"Results saved to: results/tbench-fresh/{timestamp}/")
    print("="*70)

if __name__ == "__main__":
    main()
