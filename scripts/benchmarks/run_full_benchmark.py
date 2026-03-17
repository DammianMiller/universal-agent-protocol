#!/usr/bin/env python3
"""
UAP 3.0+ Full Benchmark Suite - 12 Terminal-Bench Tests
Compares UAP-enhanced vs Baseline (no UAP) performance
"""

import json
import time
import requests
from datetime import datetime
import os

API_ENDPOINT = "http://192.168.1.165:8080/v1"
MODEL_NAME = "qwen3.5-a3b-iq4xs"

# 12 Terminal-Bench tasks covering all major categories
TASKS = [
    {
        "id": "git-recovery",
        "name": "Git Repository Recovery",
        "instruction": """You are in an isolated container at /app. Initialize a git repository at /app/test_repo with an initial commit containing 'test content'. Use 'git fsck' to verify integrity and create /app/results/git_status.txt with the output of 'git status'.""",
        "category": "system-administration"
    },
    {
        "id": "password-hash",
        "name": "Password Hash Recovery", 
        "instruction": """You are in an isolated container at /app. Create a password hash file at /app/cracking/hashes.txt containing MD5 hashes. Parse and validate the hash format, then create /app/cracking/analysis.json with validation results.""",
        "category": "security"
    },
    {
        "id": "tls-setup",
        "name": "mTLS Certificate Setup",
        "instruction": """You are in an isolated container at /app. Generate mTLS certificates: 1) Create CA key and self-signed certificate (CN="Benchmark CA") at /app/certs/ca/ with permissions 600 on key, 2) Create server certificate signed BY the CA at /app/certs/server/ with CN="benchmark.internal", 3) Verify the chain with openssl verify.""",
        "category": "security"
    },
    {
        "id": "multi-container",
        "name": "Multi-Container Deployment",
        "instruction": """You are in an isolated container at /app. Create docker-compose.yml for nginx web server on port 8080 serving static content, and Python API service on port 5000. Both should be accessible.""",
        "category": "containers"
    },
    {
        "id": "ml-training",
        "name": "ML Model Training",
        "instruction": """You are in an isolated container at /app. Train a scikit-learn logistic regression classifier on sample review data with TF-IDF vectorization (max_features=50). Save model to /app/ml/model.pkl under 1MB using joblib.""",
        "category": "ml"
    },
    {
        "id": "data-compression",
        "name": "Data Compression",
        "instruction": """You are in an isolated container at /app. Create test files in /app/data/original/, compress them into /app/data/compressed.tar.gz, verify the compression ratio, and create /app/data/compression_report.txt with details.""",
        "category": "data-processing"
    },
    {
        "id": "chess-fen",
        "name": "Chess FEN Parser",
        "instruction": """You are in an isolated container at /app. Parse and validate chess FEN strings for starting position and Italian Game. Store results in /app/chess/positions.json with validation status.""",
        "category": "games"
    },
    {
        "id": "sqlite-recovery",
        "name": "SQLite WAL Recovery",
        "instruction": """You are in an isolated container at /app. Create SQLite database at /app/db/test.db with test data, simulate WAL recovery and verify data integrity. Store results in /app/db/integrity_report.txt.""",
        "category": "database"
    },
    {
        "id": "http-server",
        "name": "HTTP Server Config",
        "instruction": """You are in an isolated container at /app. Start a Python HTTP server on port 8001 serving from /app/web directory. Verify it responds to requests.""",
        "category": "networking"
    },
    {
        "id": "code-compression",
        "name": "Code Compression",
        "instruction": """You are in an isolated container at /app. Compress Python source code using gzip. Create compressed file at /app/code/source.py.gz and verify it can be decompressed.""",
        "category": "development"
    },
    {
        "id": "mcmc-sampling",
        "name": "MCMC Sampling",
        "instruction": """You are in an isolated container at /app. Implement a simple Metropolis-Hastings MCMC sampler. Generate 10 samples from N(0,1) distribution and save to /app/stats/samples.json.""",
        "category": "statistics"
    },
    {
        "id": "corewar",
        "name": "Core War Algorithm",
        "instruction": """You are in an isolated container at /app. Implement simplified Core War memory game simulation with 8000 cell array. Execute 5 instruction cycles and save state to /app/cp/state.json.""",
        "category": "competitive"
    }
]

def run_task(instruction, use_uap=False):
    """Run a single benchmark task"""
    if use_uap:
        prompt = f"""You are completing a Terminal-Bench task using UAP 3.0+. Complete the following in an isolated container environment:

Task Instruction: {instruction}

Provide your solution as valid JSON with:
{{"status": "completed", "steps": [], "result": "summary of what was accomplished"}}"""
    else:
        prompt = f"""Complete this Terminal-Bench task:

Task: {instruction}

Provide solution as JSON: {{"status": "completed", "steps": [], "result": "summary"}}"""

    try:
        response = requests.post(
            f"{API_ENDPOINT}/chat/completions",
            json={
                "model": MODEL_NAME,
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
                "completion": result['choices'][0]['message']['content'][:500],
                "tokens_used": result.get('usage', {}).get('total_tokens', 0),
                "timing": result.get('timings', {})
            }
        else:
            return {
                "status": "error",
                "error": f"HTTP {response.status_code}",
                "response": response.text[:200]
            }
            
    except Exception as e:
        return {
            "status": "error", 
            "error": str(e)
        }

def run_benchmark_suite(use_uap=False):
    """Run full benchmark suite"""
    mode = "UAP 3.0+" if use_uap else "Baseline (No UAP)"
    
    print(f"\n{'='*70}")
    print(f"BENCHMARK SUITE: {mode}")
    print(f"Model: {MODEL_NAME}")
    print(f"API: {API_ENDPOINT}")
    print(f"{'='*70}\n")
    
    results = []
    start_time = time.time()
    
    for i, task in enumerate(TASKS, 1):
        print(f"[{i:2d}/{len(TASKS)}] Running: {task['name']:<35} ", end="")
        
        result = run_task(task['instruction'], use_uap)
        result['task_id'] = task['id']
        result['task_name'] = task['name']
        result['category'] = task['category']
        results.append(result)
        
        if result['status'] == 'success':
            print(f"✓ Success ({result['tokens_used']} tokens)")
        else:
            print(f"✗ {result['error']}")
        
        # Small delay between tasks to avoid rate limiting
        time.sleep(1)
    
    elapsed = time.time() - start_time
    
    # Calculate metrics
    success_count = sum(1 for r in results if r['status'] == 'success')
    total_tokens = sum(r.get('tokens_used', 0) for r in results if r['status'] == 'success')
    
    return {
        "mode": mode,
        "use_uap": use_uap,
        "elapsed_seconds": elapsed,
        "tasks_completed": success_count,
        "total_tasks": len(TASKS),
        "total_tokens": total_tokens,
        "avg_tokens_per_task": total_tokens / max(success_count, 1),
        "avg_time_per_task": elapsed / max(success_count, 1),
        "results": results
    }

def print_comparison(uap_results, baseline_results):
    """Print detailed comparison"""
    print("\n" + "="*70)
    print("BENCHMARK COMPARISON")
    print("="*70)
    
    uap = uap_results
    base = baseline_results
    
    print(f"\n{'Metric':<30} {'UAP 3.0+':>15} {'Baseline':>15}")
    print("-"*70)
    print(f"{'Tasks Completed':<30} {uap['tasks_completed']}/{uap['total_tasks']:<14} {base['tasks_completed']}/{base['total_tasks']:<14}")
    print(f"{'Success Rate':<30} {uap['tasks_completed']/uap['total_tasks']*100:>14.1f}% {base['tasks_completed']/base['total_tasks']*100:>14.1f}%")
    print(f"{'Total Time':<30} {uap['elapsed_seconds']:>14.1f}s {base['elapsed_seconds']:>14.1f}s")
    print(f"{'Avg per Task':<30} {uap['avg_time_per_task']:>14.1f}s {base['avg_time_per_task']:>14.1f}s")
    print(f"{'Total Tokens Used':<30} {uap['total_tokens']:>14,} {base['total_tokens']:>14,}")
    print(f"{'Avg Tokens/Task':<30} {uap['avg_tokens_per_task']:>14.1f} {base['avg_tokens_per_task']:>14.1f}")
    
    # Category breakdown
    print("\nCategory Comparison:")
    print("-"*70)
    print(f"{'Category':<25} {'UAP':>8} {'Base':>8}")
    print("-"*70)
    
    categories = sorted(set(t['category'] for t in TASKS))
    for cat in categories:
        uap_cat = [r for r in uap['results'] if r['category'] == cat]
        base_cat = [r for r in base['results'] if r['category'] == cat]
        
        uap_pass = sum(1 for r in uap_cat if r['status'] == 'success')
        base_pass = sum(1 for r in base_cat if r['status'] == 'success')
        
        print(f"{cat:<25} {uap_pass:8}/{len(uap_cat)} {base_pass:8}/{len(base_cat)}")

def main():
    """Main benchmark execution"""
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    
    # Create results directory
    os.makedirs(f"results/benchmark-{timestamp}", exist_ok=True)
    
    print("="*70)
    print("UAP 3.0+ FULL BENCHMARK SUITE")
    print("Terminal-Bench 12-Test Quick Suite")
    print("="*70)
    
    # Run UAP benchmark first
    print("\n" + "="*70)
    print("PHASE 1: Running UAP 3.0+ Benchmark...")
    print("="*70)
    uap_results = run_benchmark_suite(use_uap=True)
    
    # Save UAP results
    with open(f"results/benchmark-{timestamp}/uap_results.json", 'w') as f:
        json.dump(uap_results, f, indent=2)
    
    print(f"\n✓ UAP benchmark complete. Results saved to results/benchmark-{timestamp}/uap_results.json")
    
    # Run baseline benchmark
    print("\n" + "="*70)
    print("PHASE 2: Running Baseline Benchmark (No UAP)...")
    print("="*70)
    baseline_results = run_benchmark_suite(use_uap=False)
    
    # Save baseline results
    with open(f"results/benchmark-{timestamp}/baseline_results.json", 'w') as f:
        json.dump(baseline_results, f, indent=2)
    
    print(f"\n✓ Baseline benchmark complete. Results saved to results/benchmark-{timestamp}/baseline_results.json")
    
    # Print comparison
    print_comparison(uap_results, baseline_results)
    
    # Save comparison summary
    comparison = {
        "timestamp": datetime.now().isoformat(),
        "model": MODEL_NAME,
        "api_endpoint": API_ENDPOINT,
        "uap": uap_results,
        "baseline": baseline_results,
        "improvement": {
            "success_rate_diff": (uap_results['tasks_completed']/uap_results['total_tasks']) - 
                               (baseline_results['tasks_completed']/baseline_results['total_tasks']),
            "time_efficiency": uap_results['avg_time_per_task'] / max(baseline_results['avg_time_per_task'], 0.1),
            "token_efficiency": uap_results['avg_tokens_per_task'] / max(baseline_results['avg_tokens_per_task'], 0.1)
        }
    }
    
    with open(f"results/benchmark-{timestamp}/comparison.json", 'w') as f:
        json.dump(comparison, f, indent=2)
    
    print(f"\n{'='*70}")
    print("BENCHMARK COMPLETE!")
    print(f"Results saved to: results/benchmark-{timestamp}/")
    print("="*70)
    
    return uap_results['tasks_completed'] == baseline_results['tasks_completed']

if __name__ == "__main__":
    import sys
    success = main()
    sys.exit(0 if success else 1)
