#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec env \
  FILE_PANEL_ROLE_OVERRIDE=manager \
  INSTALL_WEB_STACK_PACKAGES=1 \
  SERVICE_UNIT_FILE_OVERRIDE="$SCRIPT_DIR/../systemd/files-agent.service" \
  bash "$SCRIPT_DIR/install_agent.sh"
