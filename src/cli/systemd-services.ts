import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import { join } from 'path';

export interface SystemdServiceSetupOptions {
  force?: boolean;
  homeDir?: string;
}

export interface SystemdServiceSetupResult {
  installed: string[];
  skipped: string[];
  userServiceDir: string;
  envDir: string;
}

function writeIfMissing(
  filePath: string,
  content: string,
  installed: string[],
  skipped: string[],
  force = false
): void {
  if (existsSync(filePath) && !force) {
    skipped.push(filePath);
    return;
  }

  writeFileSync(filePath, content);
  installed.push(filePath);
}

export function installSystemdUserServices(
  projectDir: string,
  options: SystemdServiceSetupOptions = {}
): SystemdServiceSetupResult {
  const installed: string[] = [];
  const skipped: string[] = [];
  const force = options.force === true;

  const scriptsDir = join(projectDir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });

  const proxyScriptPath = join(scriptsDir, 'run-anthropic-proxy-continuity.sh');
  const llamaScriptPath = join(scriptsDir, 'run-llama-server-continuity.sh');

  writeIfMissing(
    proxyScriptPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',
      '',
      'export PROXY_PORT="${PROXY_PORT:-4000}"',
      'export LLAMA_CPP_BASE="${LLAMA_CPP_BASE:-http://127.0.0.1:8080/v1}"',
      'export PROXY_LOG_LEVEL="${PROXY_LOG_LEVEL:-INFO}"',
      '',
      'export PROXY_LOOP_BREAKER="${PROXY_LOOP_BREAKER:-on}"',
      'export PROXY_LOOP_WINDOW="${PROXY_LOOP_WINDOW:-6}"',
      'export PROXY_LOOP_REPEAT_THRESHOLD="${PROXY_LOOP_REPEAT_THRESHOLD:-8}"',
      'export PROXY_FORCED_THRESHOLD="${PROXY_FORCED_THRESHOLD:-15}"',
      'export PROXY_NO_PROGRESS_THRESHOLD="${PROXY_NO_PROGRESS_THRESHOLD:-4}"',
      'export PROXY_CONTEXT_RELEASE_THRESHOLD="${PROXY_CONTEXT_RELEASE_THRESHOLD:-0.90}"',
      'export PROXY_GUARDRAIL_RETRY="${PROXY_GUARDRAIL_RETRY:-on}"',
      'export PROXY_SESSION_TTL_SECS="${PROXY_SESSION_TTL_SECS:-7200}"',
      '',
      'cd "$ROOT_DIR"',
      'exec python3 tools/agents/scripts/anthropic_proxy.py',
      '',
    ].join('\n'),
    installed,
    skipped,
    force
  );

  writeIfMissing(
    llamaScriptPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      'LLAMA_BIN="${LLAMA_BIN:-/home/cogtek/llama.cpp/build-cuda/bin/llama-server}"',
      'LLAMA_MODEL="${LLAMA_MODEL:-/home/cogtek/Downloads/Qwen3.5-35B-A3B-UD-IQ4_XS.gguf}"',
      '',
      'if [[ ! -x "$LLAMA_BIN" ]]; then',
      '  echo "ERROR: LLAMA_BIN is not executable: $LLAMA_BIN" >&2',
      '  exit 1',
      'fi',
      '',
      'if [[ ! -f "$LLAMA_MODEL" ]]; then',
      '  echo "ERROR: LLAMA_MODEL not found: $LLAMA_MODEL" >&2',
      '  exit 1',
      'fi',
      '',
      'export LLAMA_HOST="${LLAMA_HOST:-0.0.0.0}"',
      'export LLAMA_PORT="${LLAMA_PORT:-8080}"',
      'export LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-262144}"',
      'export LLAMA_THREADS="${LLAMA_THREADS:-32}"',
      'export LLAMA_GPU_LAYERS="${LLAMA_GPU_LAYERS:-99}"',
      'export LLAMA_BATCH_SIZE="${LLAMA_BATCH_SIZE:-512}"',
      'export LLAMA_UBATCH_SIZE="${LLAMA_UBATCH_SIZE:-512}"',
      'export LLAMA_SPEC_TYPE="${LLAMA_SPEC_TYPE:-ngram-cache}"',
      'export LLAMA_HYBRID_ROLLBACK_MODE="${LLAMA_HYBRID_ROLLBACK_MODE:-strict}"',
      'export LLAMA_LOG_FILE="${LLAMA_LOG_FILE:-llama-server.log}"',
      '',
      'exec "$LLAMA_BIN" \\',
      '  --model "$LLAMA_MODEL" \\',
      '  --host "$LLAMA_HOST" \\',
      '  --port "$LLAMA_PORT" \\',
      '  --threads "$LLAMA_THREADS" \\',
      '  --ctx-size "$LLAMA_CTX_SIZE" \\',
      '  --cache-type-k q4_0 \\',
      '  --cache-type-v q4_0 \\',
      '  --gpu-layers "$LLAMA_GPU_LAYERS" \\',
      '  --flash-attn on \\',
      '  --batch-size "$LLAMA_BATCH_SIZE" \\',
      '  --ubatch-size "$LLAMA_UBATCH_SIZE" \\',
      '  --parallel 1 \\',
      '  --no-context-shift \\',
      '  --n-predict 32768 \\',
      '  --repeat-penalty 1.0 \\',
      '  --defrag-thold 0.1 \\',
      '  --spec-type "$LLAMA_SPEC_TYPE" \\',
      '  --log-file "$LLAMA_LOG_FILE"',
      '',
    ].join('\n'),
    installed,
    skipped,
    force
  );

  chmodSync(proxyScriptPath, 0o755);
  chmodSync(llamaScriptPath, 0o755);

  const homeDir = options.homeDir || os.homedir();
  const userServiceDir = join(homeDir, '.config', 'systemd', 'user');
  const envDir = join(homeDir, '.config', 'uap');
  mkdirSync(userServiceDir, { recursive: true });
  mkdirSync(envDir, { recursive: true });

  const proxyServicePath = join(userServiceDir, 'uap-anthropic-proxy.service');
  const llamaServicePath = join(userServiceDir, 'uap-llama-server.service');
  const proxyEnvPath = join(envDir, 'anthropic-proxy.env');
  const llamaEnvPath = join(envDir, 'llama-server.env');

  writeIfMissing(
    proxyServicePath,
    [
      '[Unit]',
      'Description=UAP Anthropic Proxy (continuity mode)',
      'After=network-online.target uap-llama-server.service',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${projectDir}`,
      `EnvironmentFile=${proxyEnvPath}`,
      `ExecStart=${proxyScriptPath}`,
      'Restart=always',
      'RestartSec=3',
      'TimeoutStopSec=20',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
    installed,
    skipped,
    force
  );

  writeIfMissing(
    llamaServicePath,
    [
      '[Unit]',
      'Description=llama.cpp server (continuity profile)',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${projectDir}`,
      `EnvironmentFile=${llamaEnvPath}`,
      `ExecStart=${llamaScriptPath}`,
      'Restart=always',
      'RestartSec=5',
      'TimeoutStopSec=20',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
    installed,
    skipped,
    force
  );

  writeIfMissing(
    proxyEnvPath,
    [
      'PROXY_PORT=4000',
      'LLAMA_CPP_BASE=http://127.0.0.1:8080/v1',
      'PROXY_LOG_LEVEL=INFO',
      '',
      'PROXY_LOOP_BREAKER=on',
      'PROXY_LOOP_WINDOW=6',
      'PROXY_LOOP_REPEAT_THRESHOLD=8',
      'PROXY_FORCED_THRESHOLD=15',
      'PROXY_NO_PROGRESS_THRESHOLD=4',
      'PROXY_CONTEXT_RELEASE_THRESHOLD=0.90',
      'PROXY_GUARDRAIL_RETRY=on',
      'PROXY_SESSION_TTL_SECS=7200',
      '',
    ].join('\n'),
    installed,
    skipped,
    force
  );

  writeIfMissing(
    llamaEnvPath,
    [
      'LLAMA_BIN=/home/cogtek/llama.cpp/build-cuda/bin/llama-server',
      'LLAMA_MODEL=/home/cogtek/Downloads/Qwen3.5-35B-A3B-UD-IQ4_XS.gguf',
      '',
      'LLAMA_HOST=0.0.0.0',
      'LLAMA_PORT=8080',
      'LLAMA_CTX_SIZE=262144',
      'LLAMA_THREADS=32',
      'LLAMA_GPU_LAYERS=99',
      'LLAMA_BATCH_SIZE=512',
      'LLAMA_UBATCH_SIZE=512',
      'LLAMA_SPEC_TYPE=ngram-cache',
      'LLAMA_HYBRID_ROLLBACK_MODE=strict',
      'LLAMA_LOG_FILE=llama-server.log',
      '',
    ].join('\n'),
    installed,
    skipped,
    force
  );

  return {
    installed,
    skipped,
    userServiceDir,
    envDir,
  };
}
