#!/usr/bin/env bash
# Install the UAP dashboard as a systemd user service (default port 3847).
#
# "If the proxy is active, the dashboard is active": uap-dashboard.service is
# WantedBy=default.target (always with the login session) and
# uap-anthropic-proxy.service Wants= it, so starting the proxy starts the
# dashboard too. The placement controller URL (PROXY_PLACEMENT_CONTROLLER)
# points at this port, so the dashboard owning :3847 is load-bearing, not
# cosmetic.
#
# Usage:
#   scripts/install-uap-dashboard-service.sh           # embeds THIS checkout
#   ROOT_DIR=/path/to/checkout scripts/...             # embed another checkout
#
# The unit pins the checkout that installs it (WorkingDirectory decides which
# project's data the dashboard serves). After merging a feature branch that
# carried this service, re-run this script FROM THE MAIN CHECKOUT to repoint
# it — a unit left pointing at a removed worktree serves nothing.
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${USER_SYSTEMD_DIR}/uap-dashboard.service"

if [[ ! -x "${ROOT_DIR}/dist/bin/cli.js" && ! -f "${ROOT_DIR}/dist/bin/cli.js" ]]; then
  echo "error: ${ROOT_DIR}/dist/bin/cli.js not found — run npm run build first" >&2
  exit 1
fi

mkdir -p "${USER_SYSTEMD_DIR}"
sed "s|__ROOT__|${ROOT_DIR}|g" "${ROOT_DIR}/deploy/systemd/uap-dashboard.service" >"${UNIT_FILE}"

# The proxy unit pulls the dashboard up with it ("proxy active => dash active").
# Use systemctl add-wants (a drop-in .wants/ symlink) rather than sed-editing
# the proxy unit file: a sed edit silently disappears the next time the proxy
# unit is reinstalled from its template, and a second Wants= line would be
# ignored rather than merged. add-wants is idempotent and survives reinstalls.
if systemctl --user list-unit-files uap-anthropic-proxy.service --no-legend 2>/dev/null | grep -q uap-anthropic-proxy; then
  systemctl --user add-wants uap-anthropic-proxy.service uap-dashboard.service
  echo "linked: uap-anthropic-proxy.service now Wants=uap-dashboard.service (drop-in)"
fi

systemctl --user daemon-reload
systemctl --user enable --now uap-dashboard.service

echo "installed: ${UNIT_FILE}"
echo "  serving: ${ROOT_DIR} on :3847"
systemctl --user --no-pager --lines=0 status uap-dashboard.service || true
