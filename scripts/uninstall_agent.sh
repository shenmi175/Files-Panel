#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/opt/files-agent"
ENV_DIR="/etc/files-agent"
ENV_FILE="$ENV_DIR/files-agent.env"
STATE_DIR="/var/lib/files-agent"
SERVICE_NAME="files-agent"
GLOBAL_COMMAND_PATH="/usr/local/bin/file-panel"

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d "=" -f 2- || true
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行卸载脚本" >&2
  exit 1
fi

NGINX_SITES_AVAILABLE_DIR="$(read_env_value NGINX_SITES_AVAILABLE_DIR)"
NGINX_SITES_ENABLED_DIR="$(read_env_value NGINX_SITES_ENABLED_DIR)"
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
rm -rf "$APP_DIR" "$ENV_DIR" "$STATE_DIR"
rm -f "${NGINX_SITES_AVAILABLE_DIR}"/files-agent-*.conf
rm -f "${NGINX_SITES_ENABLED_DIR}"/files-agent-*.conf

echo
echo "File Panel 已卸载"
echo "已删除应用目录、环境文件、SQLite 数据和全局命令"
echo "nginx/certbot/sqlite3 等系统软件包未自动卸载"
