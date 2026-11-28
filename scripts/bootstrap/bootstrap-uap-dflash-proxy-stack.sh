#!/usr/bin/env bash
# Bootstrap the DFlash + uap-anthropic-proxy stack. Mirrors
# bootstrap-uap-llama-proxy-stack.sh but swaps the inference backend
# from vanilla llama-server to lucebox-hub's DFlash server (Qwen3.6-27B
# with speculative decoding).
#
# Prereqs (manual one-time, see README of lucebox-hub/dflash):
#   - Repo cloned at $DFLASH_ROOT (default $HOME/lucebox/lucebox-hub/dflash)
#   - test_dflash built: cmake --build build --target test_dflash
#   - venv at $DFLASH_VENV with: fastapi uvicorn transformers jinja2 gguf torch
#   - Target GGUF + draft safetensors downloaded
#
# After bootstrap:
#   systemctl --user disable --now uap-llama-server.service   # if previously enabled
#   systemctl --user enable  --now uap-dflash-server.service
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
UAP_CONFIG_DIR="${HOME}/.config/uap"

mkdir -p "$USER_SYSTEMD_DIR" "$UAP_CONFIG_DIR"

cat >"${UAP_CONFIG_DIR}/dflash-server.env" <<EOF
DFLASH_ROOT=${DFLASH_ROOT:-$HOME/lucebox/lucebox-hub/dflash}
DFLASH_VENV=${DFLASH_VENV:-$HOME/lucebox/lucebox-hub/dflash/.venv}
DFLASH_BIN=${DFLASH_BIN:-$HOME/lucebox/lucebox-hub/dflash/build/test_dflash}
DFLASH_TARGET=${DFLASH_TARGET:-$HOME/Downloads/Qwen3.6-27B-Q3_K_M.gguf}
DFLASH_DRAFT=${DFLASH_DRAFT:-$HOME/lucebox/lucebox-hub/dflash/models/draft}

DFLASH_HOST=${DFLASH_HOST:-0.0.0.0}
DFLASH_PORT=${DFLASH_PORT:-8080}
# Budget 22 OOMs the rollback cache with Qwen3.6-27B target on 24 GB; 16 fits.
DFLASH_BUDGET=${DFLASH_BUDGET:-16}
# Issue #10: attention scales with --max-ctx not actual prompt length.
# Also: 32768 OOMs rollback cache on Qwen3.6-27B / 24 GB. Keep in sync
# with PROXY_CONTEXT_WINDOW (anthropic-proxy.env) — DFlash has no /slots.
DFLASH_MAX_CTX=${DFLASH_MAX_CTX:-16384}
DFLASH_FA_WINDOW=${DFLASH_FA_WINDOW:-2048}
DFLASH_KV_TQ3=${DFLASH_KV_TQ3:-1}
DFLASH_TOKENIZER=${DFLASH_TOKENIZER:-}
DFLASH_EXTRA_ARGS=${DFLASH_EXTRA_ARGS:-}
EOF

cat >"${USER_SYSTEMD_DIR}/uap-dflash-server.service" <<EOF
[Unit]
Description=lucebox-hub DFlash server (Qwen3.6-27B speculative decoding)
After=network-online.target
Wants=network-online.target
Conflicts=uap-llama-server.service

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
EnvironmentFile=${UAP_CONFIG_DIR}/dflash-server.env
ExecStart=${ROOT_DIR}/scripts/run-dflash-server-continuity.sh
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGINT

[Install]
WantedBy=default.target
EOF

chmod +x "${ROOT_DIR}/scripts/run-dflash-server-continuity.sh"

systemctl --user daemon-reload

echo "DFlash bootstrap written:"
echo "  env:      ${UAP_CONFIG_DIR}/dflash-server.env"
echo "  service:  ${USER_SYSTEMD_DIR}/uap-dflash-server.service"
echo
echo "To activate:"
echo "  systemctl --user disable --now uap-llama-server.service   # if running"
echo "  systemctl --user enable  --now uap-dflash-server.service"
echo
echo "Verify proxy upstream context matches DFLASH_MAX_CTX:"
echo "  grep PROXY_CONTEXT_WINDOW ${UAP_CONFIG_DIR}/anthropic-proxy.env"
