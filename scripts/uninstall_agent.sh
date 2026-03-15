#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/opt/files-agent"
ENV_DIR="/etc/files-agent"
ENV_FILE="$ENV_DIR/files-agent.env"
STATE_DIR="/var/lib/files-agent"
SERVICE_NAME="files-agent"
SERVICE_USER="filepanel"
SERVICE_GROUP="filepanel"
GLOBAL_COMMAND_PATH="/usr/local/bin/file-panel"
HELPER_INSTALL_DIR="/usr/local/libexec/file-panel"
HELPER_INSTALL_PATH="$HELPER_INSTALL_DIR/file-panel-helper.sh"
SUDOERS_FILE="/etc/sudoers.d/file-panel"
AGENT_ROOT_BASE="/srv/file-panel"

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d "=" -f 2- || true
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run the uninstall script as root." >&2
  exit 1
fi

NGINX_SITES_AVAILABLE_DIR="$(read_env_value NGINX_SITES_AVAILABLE_DIR)"
NGINX_SITES_ENABLED_DIR="$(read_env_value NGINX_SITES_ENABLED_DIR)"
AGENT_ROOT_VALUE="$(read_env_value AGENT_ROOT)"
if [[ -z "$NGINX_SITES_AVAILABLE_DIR" ]]; then
  NGINX_SITES_AVAILABLE_DIR="/etc/nginx/sites-available"
fi
if [[ -z "$NGINX_SITES_ENABLED_DIR" ]]; then
  NGINX_SITES_ENABLED_DIR="/etc/nginx/sites-enabled"
fi

if systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
  systemctl disable --now "$SERVICE_NAME" || true
  systemctl reset-failed "$SERVICE_NAME" || true
fi

rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload

rm -f "$GLOBAL_COMMAND_PATH"
rm -f "$HELPER_INSTALL_PATH"
rmdir "$HELPER_INSTALL_DIR" 2>/dev/null || true
rm -f "$SUDOERS_FILE"
rm -rf "$APP_DIR" "$ENV_DIR" "$STATE_DIR"
rm -f "${NGINX_SITES_AVAILABLE_DIR}"/files-agent-*.conf
rm -f "${NGINX_SITES_ENABLED_DIR}"/files-agent-*.conf

if [[ -n "$AGENT_ROOT_VALUE" ]] && [[ "$AGENT_ROOT_VALUE" == "$AGENT_ROOT_BASE" || "$AGENT_ROOT_VALUE" == "$AGENT_ROOT_BASE/"* ]]; then
  rm -rf "$AGENT_ROOT_BASE"
fi

if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  userdel "$SERVICE_USER" 2>/dev/null || true
fi
if getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  groupdel "$SERVICE_GROUP" 2>/dev/null || true
fi

echo
echo "File Panel removed"
echo "Application files, environment files, SQLite data, helper scripts and the service account were deleted."
echo "System packages such as nginx, certbot, sqlite3 and wireguard-tools were not removed automatically."
