#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
UAP_CONFIG_DIR="${HOME}/.config/uap"

mkdir -p "$USER_SYSTEMD_DIR" "$UAP_CONFIG_DIR"

cat >"${UAP_CONFIG_DIR}/llama-server.env" <<EOF
LLAMA_BIN=${LLAMA_BIN:-/home/cogtek/llama.cpp/.worktrees/001-llama-spec-rollback-fix/build-cuda/bin/llama-server}
LLAMA_MODEL=${LLAMA_MODEL:-/home/cogtek/Downloads/Qwen3.5-35B-A3B-UD-IQ4_XS.gguf}

LLAMA_HOST=${LLAMA_HOST:-0.0.0.0}
LLAMA_PORT=${LLAMA_PORT:-8080}
LLAMA_CTX_SIZE=${LLAMA_CTX_SIZE:-262144}
LLAMA_THREADS=${LLAMA_THREADS:-32}
LLAMA_GPU_LAYERS=${LLAMA_GPU_LAYERS:-99}
LLAMA_BATCH_SIZE=${LLAMA_BATCH_SIZE:-512}
LLAMA_UBATCH_SIZE=${LLAMA_UBATCH_SIZE:-512}
LLAMA_SPEC_TYPE=${LLAMA_SPEC_TYPE:-ngram-cache}
LLAMA_DRAFT_MAX=${LLAMA_DRAFT_MAX:-16}
LLAMA_DRAFT_MIN=${LLAMA_DRAFT_MIN:-3}
LLAMA_DRAFT_P_MIN=${LLAMA_DRAFT_P_MIN:-0.75}
LLAMA_LOG_FILE=${LLAMA_LOG_FILE:-/home/cogtek/llama.cpp/llama-server.log}
LLAMA_CHAT_TEMPLATE_FILE=${LLAMA_CHAT_TEMPLATE_FILE:-${ROOT_DIR}/tools/agents/config/chat_template.jinja}
LLAMA_EXTRA_ARGS=${LLAMA_EXTRA_ARGS:-}
EOF

cat >"${UAP_CONFIG_DIR}/anthropic-proxy.env" <<EOF
PROXY_PORT=${PROXY_PORT:-4000}
LLAMA_CPP_BASE=${LLAMA_CPP_BASE:-http://127.0.0.1:8080/v1}
PROXY_LOG_LEVEL=${PROXY_LOG_LEVEL:-INFO}

PROXY_LOOP_BREAKER=${PROXY_LOOP_BREAKER:-on}
PROXY_LOOP_WINDOW=${PROXY_LOOP_WINDOW:-6}
PROXY_LOOP_REPEAT_THRESHOLD=${PROXY_LOOP_REPEAT_THRESHOLD:-6}
PROXY_FORCED_THRESHOLD=${PROXY_FORCED_THRESHOLD:-10}
PROXY_NO_PROGRESS_THRESHOLD=${PROXY_NO_PROGRESS_THRESHOLD:-3}
PROXY_CONTEXT_RELEASE_THRESHOLD=${PROXY_CONTEXT_RELEASE_THRESHOLD:-0.75}
PROXY_GUARDRAIL_RETRY=${PROXY_GUARDRAIL_RETRY:-on}
PROXY_SESSION_TTL_SECS=${PROXY_SESSION_TTL_SECS:-7200}
PROXY_TOOL_CALL_GRAMMAR=${PROXY_TOOL_CALL_GRAMMAR:-on}
PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY=${PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY:-on}
PROXY_TOOL_CALL_GRAMMAR_PATH=${PROXY_TOOL_CALL_GRAMMAR_PATH:-${ROOT_DIR}/tools/agents/config/tool-call.gbnf}
EOF

cat >"${USER_SYSTEMD_DIR}/uap-llama-server.service" <<EOF
[Unit]
Description=llama.cpp server (continuity profile)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
EnvironmentFile=${UAP_CONFIG_DIR}/llama-server.env
ExecStart=${ROOT_DIR}/scripts/run-llama-server-continuity.sh
Restart=always
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF

cat >"${USER_SYSTEMD_DIR}/uap-anthropic-proxy.service" <<EOF
[Unit]
Description=UAP Anthropic Proxy (continuity mode)
After=network-online.target uap-llama-server.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
EnvironmentFile=${UAP_CONFIG_DIR}/anthropic-proxy.env
ExecStart=${ROOT_DIR}/scripts/run-anthropic-proxy-continuity.sh
Restart=always
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF

chmod +x "${ROOT_DIR}/scripts/run-llama-server-continuity.sh"
chmod +x "${ROOT_DIR}/scripts/run-anthropic-proxy-continuity.sh"

systemctl --user daemon-reload
systemctl --user enable --now uap-llama-server.service
systemctl --user enable --now uap-anthropic-proxy.service

echo "Bootstrap complete."
echo "  llama env: ${UAP_CONFIG_DIR}/llama-server.env"
echo "  proxy env: ${UAP_CONFIG_DIR}/anthropic-proxy.env"
echo "  services:  uap-llama-server.service, uap-anthropic-proxy.service"
