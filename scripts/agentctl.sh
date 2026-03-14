#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-files-agent}"
ENV_FILE="${ENV_FILE:-/etc/files-agent/files-agent.env}"
STATE_DIR="${STATE_DIR:-/var/lib/files-agent}"
DB_PATH="${DB_PATH:-}"
DEFAULT_LOG_LINES="${DEFAULT_LOG_LINES:-80}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SCRIPT="$SCRIPT_DIR/install_agent.sh"
UNINSTALL_SCRIPT="$SCRIPT_DIR/uninstall_agent.sh"

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d "=" -f 2- || true
}

database_path() {
  if [[ -n "$DB_PATH" ]]; then
    printf '%s\n' "$DB_PATH"
    return
  fi

  local from_env
  from_env="$(read_env_value DATABASE_PATH)"
  if [[ -n "$from_env" ]]; then
    printf '%s\n' "$from_env"
    return
  fi

  printf '%s\n' "${STATE_DIR}/file-panel.db"
}

db_query() {
  local sql="$1"
  local path
  path="$(database_path)"
  if [[ ! -f "$path" ]]; then
    return 0
  fi
  sqlite3 -batch -noheader "$path" "$sql" 2>/dev/null || true
}

read_config_value() {
  local key="$1"
  local value
  value="$(db_query "SELECT value FROM config WHERE key='${key}' LIMIT 1;")"
  if [[ -n "$value" ]]; then
    printf '%s\n' "$value"
    return
  fi
  read_env_value "$key"
}

read_access_value() {
  local key="$1"
  db_query "SELECT ${key} FROM access_state WHERE singleton_id=1 LIMIT 1;"
}

server_ip() {
  hostname -I | awk '{print $1}'
}

bind_host() {
  local host
  host="$(read_config_value HOST)"
  if [[ -z "$host" ]]; then
    host="127.0.0.1"
  fi
  printf '%s\n' "$host"
}

bind_port() {
  local port
  port="$(read_config_value PORT)"
  if [[ -z "$port" ]]; then
    port="3000"
  fi
  printf '%s\n' "$port"
}

log() {
  printf '\n==> %s\n' "$1"
}

ensure_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    return
  fi
  exec sudo bash "$0" "$@"
}

show_access_info() {
  local host port domain token ip db
  host="$(bind_host)"
  port="$(bind_port)"
  domain="$(read_access_value domain)"
  token="$(read_config_value AGENT_TOKEN)"
  ip="$(server_ip)"
  db="$(database_path)"

  log "访问信息"
  if [[ -n "$domain" ]]; then
    echo "域名入口: https://${domain}"
  elif [[ "$host" == "127.0.0.1" || "$host" == "::1" || "$host" == "localhost" ]]; then
    echo "本地入口: http://127.0.0.1:${port}"
  else
    echo "公网入口: http://${ip}:${port}"
  fi

  if [[ -n "$token" ]]; then
    echo "AGENT_TOKEN: ${token}"
  fi
  echo "SQLite: ${db}"
}

run_install() {
  local install_system_packages="$1"
  local sync_python_deps="$2"

  log "同步 File Panel"
  INSTALL_SYSTEM_PACKAGES="$install_system_packages" \
  SYNC_PYTHON_DEPS="$sync_python_deps" \
  bash "$INSTALL_SCRIPT"
}

start_agent() {
  log "启动 ${SERVICE_NAME}"
  systemctl start "$SERVICE_NAME"
}

restart_agent() {
  log "重启 ${SERVICE_NAME}"
  systemctl restart "$SERVICE_NAME"
}

stop_agent() {
  log "停止 ${SERVICE_NAME}"
  systemctl stop "$SERVICE_NAME"
}

status_agent() {
  log "服务状态"
  systemctl status "$SERVICE_NAME" --no-pager --lines=30 || true
}

logs_agent() {
  local lines="${1:-$DEFAULT_LOG_LINES}"
  log "最近日志"
  journalctl -u "$SERVICE_NAME" -n "$lines" --no-pager
}

full_install() {
  run_install 1 1
  restart_agent
  status_agent
  show_access_info
}

redeploy() {
  run_install 0 1
  restart_agent
  status_agent
  show_access_info
}

quick_reload() {
  run_install 0 0
  restart_agent
  status_agent
  show_access_info
}

uninstall_panel() {
  log "卸载 File Panel"
  bash "$UNINSTALL_SCRIPT"
}

show_help() {
  cat <<'EOF'
用法:
  file-panel <command>

命令:
  start         启动服务
  restart       重启服务
  stop          停止服务
  status        查看服务状态
  logs [n]      查看最近 n 行日志，默认 80 行
  info          输出当前入口、访问令牌和 SQLite 路径
  uninstall     一键卸载 File Panel 及 SQLite 数据
  full-install  首次安装或补系统依赖，然后重启服务
  redeploy      跳过 apt，只同步代码和 Python 依赖，然后重启服务
  quick         跳过 apt 和 pip，只同步代码后重启服务
  help          显示帮助

常用:
  file-panel start
  file-panel restart
  file-panel uninstall
EOF
}

command="${1:-status}"
shift || true

case "$command" in
  help|-h|--help)
    show_help
    ;;
  full-install)
    ensure_root "$command" "$@"
    full_install
    ;;
  redeploy)
    ensure_root "$command" "$@"
    redeploy
    ;;
  quick)
    ensure_root "$command" "$@"
    quick_reload
    ;;
  start)
    ensure_root "$command" "$@"
    start_agent
    status_agent
    show_access_info
    ;;
  restart)
    ensure_root "$command" "$@"
    restart_agent
    status_agent
    show_access_info
    ;;
  stop)
    ensure_root "$command" "$@"
    stop_agent
    status_agent
    ;;
  status)
    ensure_root "$command" "$@"
    status_agent
    ;;
  logs)
    ensure_root "$command" "$@"
    logs_agent "${1:-$DEFAULT_LOG_LINES}"
    ;;
  info)
    ensure_root "$command" "$@"
    show_access_info
    ;;
  uninstall)
    ensure_root "$command" "$@"
    uninstall_panel
    ;;
  *)
    echo "未知命令: $command" >&2
    show_help >&2
    exit 1
    ;;
esac
