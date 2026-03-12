#!/usr/bin/env python3
"""
Baseline Benchmark - Direct Qwen3.5 API (No UAP)
For comparison with UAP-enhanced version
"""

import json
import time
import requests
from datetime import datetime

API_ENDPOINT = "http://192.168.1.165:8080/v1"
MODEL_NAME = "qwen3.5-a3b-iq4xs"

# Same 12 tasks for fair comparison
TASKS = [
    {"id": "git-recovery", "name": "Git Repository Recovery", "instruction": "Initialize a git repository at /app/test_repo with an initial commit. Use git fsck to verify integrity and create a verification file at /app/results/git_status.txt.", "category": "system-administration"},
    {"id": "password-hash", "name": "Password Hash Recovery", "instruction": "Create a password hash file at /app/cracking/hashes.txt containing MD5 hashes. Parse and validate the hash format.", "category": "security"},
    {"id": "tls-setup", "name": "mTLS Certificate Setup", "instruction": "Generate CA certificate (CN=Benchmark CA) and server certificate signed by CA at /app/certs/. Verify the certificate chain.", "category": "security"},
    {"id": "multi-container", "name": "Multi-Container Deployment", "instruction": "Create docker-compose.yml for nginx web server on port 8080 and Python API service. Both should be accessible.", "category": "containers"},
    {"id": "ml-training", "name": "ML Model Training", "instruction": "Train a scikit-learn logistic regression classifier on sample review data. Save model to /app/ml/model.pkl under 1MB.", "category": "ml"},
    {"id": "data-compression", "name": "Data Compression", "instruction": "Compress test files into tar.gz archive at /app/data/compressed.tar.gz. Verify compression ratio.", "category": "data-processing"},
    {"id": "chess-fen", "name": "Chess FEN Parser", "instruction": "Parse chess position FEN string and validate it follows proper format. Store result in /app/chess/position.json.", "category": "games"},
    {"id": "sqlite-recovery", "name": "SQLite WAL Recovery", "instruction": "Create SQLite database with test data. Simulate WAL recovery and verify data integrity.", "category": "database"},
    {"id": "http-server", "name": "HTTP Server Config", "instruction": "Start a Python HTTP server on port 8001 serving from /app/web directory. Verify it responds to requests.", "category": "networking"},
    {"id": "code-compression", "name": "Code Compression", "instruction": "Compress Python source code using gzip. Create compressed file at /app/code/source.py.gz.", "category": "development"},
    {"id": "mcmc-sampling", "name": "MCMC Sampling", "instruction": "Implement a simple Metropolis-Hastings MCMC sampler. Generate 10 samples from N(0,1) distribution.", "category": "statistics"},
    {"id": "corewar", "name": "Core War Algorithm", "instruction": "Implement simplified Core War memory game simulation with 8000 cell array. Execute 5 instruction cycles.", "category": "competitive"}
]

def run_baseline_task(task):
    """Run task with direct API call (no UAP)"""
    prompt = f"""Complete this Terminal-Bench task:

Task: {task['name']} ({task['category']})

Instruction: {task['instruction']}

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
            return {
                "task_id": task['id'],
                "task_name": task['name'],
                "category": task['category'],
                "status": "success",
                "completion": response.json()['choices'][0]['message']['content'][:500],
                "tokens_used": response.json().get('usage', {}).get('total_tokens', 0)
            }
        else:
            return {"task_id": task['id'], "status": "error", "error": f"HTTP {response.status_code}"}
            
    except Exception as e:
        return {"task_id": task['id'], "status": "error", "error": str(e)}

def main():
    print("=" * 70)
    print("BASELINE BENCHMARK - Direct Qwen3.5 (No UAP)")
    print(f"Model: {MODEL_NAME}")
    print(f"API: {API_ENDPOINT}")
    print("=" * 70)
    
    results = []
    start_time = time.time()
    
    for i, task in enumerate(TASKS, 1):
        print(f"\n[{i:2d}/{len(TASKS)}] Running: {task['name']:<35} ", end="")
        
        result = run_baseline_task(task)
        results.append(result)
        
        if result['status'] == 'success':
            print(f"✓ Success ({result['tokens_used']} tokens)")
        else:
            print(f"✗ {result['error']}")
        
        time.sleep(1)
    
    elapsed = time.time() - start_time
    
    success_count = sum(1 for r in results if r['status'] == 'success')
    total_tokens = sum(r.get('tokens_used', 0) for r in results if r['status'] == 'success')
    
    print("\n" + "=" * 70)
    print("BASELINE SUMMARY")
    print("=" * 70)
    print(f"Tasks Completed: {success_count}/{len(TASKS)}")
    print(f"Total Time: {elapsed:.1f}s ({elapsed/len(TASKS):.1f}s per task)")
    print(f"Total Tokens Used: {total_tokens:,}")
    
    output_file = f"results/baseline_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(output_file, 'w') as f:
        json.dump({
            "model": MODEL_NAME, 
            "mode": "baseline_no_uap",
            "api_endpoint": API_ENDPOINT,
            "timestamp": datetime.now().isoformat(),
            "elapsed_seconds": elapsed,
            "tasks": results
        }, f, indent=2)
    
    print(f"\nResults saved to: {output_file}")
    return success_count == len(TASKS)

if __name__ == "__main__":
    import sys
    sys.exit(0 if main() else 1)
