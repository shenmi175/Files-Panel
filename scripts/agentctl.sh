#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-files-agent}"
ENV_FILE="${ENV_FILE:-/etc/files-agent/files-agent.env}"
DEFAULT_LOG_LINES="${DEFAULT_LOG_LINES:-80}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SCRIPT="$SCRIPT_DIR/install_agent.sh"

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d "=" -f 2- || true
}

server_ip() {
  hostname -I | awk '{print $1}'
}

bind_host() {
  local host
  host="$(read_env_value HOST)"
  if [[ -z "$host" ]]; then
    host="127.0.0.1"
  fi
  printf '%s\n' "$host"
}

bind_port() {
  local port
  port="$(read_env_value PORT)"
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
  local host port domain token ip
  host="$(bind_host)"
  port="$(bind_port)"
  domain="$(read_env_value PUBLIC_DOMAIN)"
  token="$(read_env_value AGENT_TOKEN)"
  ip="$(server_ip)"

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
}

run_install() {
  local install_system_packages="$1"
  local sync_python_deps="$2"

  log "同步 Files Agent"
  INSTALL_SYSTEM_PACKAGES="$install_system_packages" \
  SYNC_PYTHON_DEPS="$sync_python_deps" \
  bash "$INSTALL_SCRIPT"
}

restart_agent() {
  log "重启 ${SERVICE_NAME}"
  systemctl restart "$SERVICE_NAME"
}

status_agent() {
  log "服务状态"
  systemctl status "$SERVICE_NAME" --no-pager --lines=30
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

show_help() {
  cat <<'EOF'
用法:
  bash scripts/agentctl.sh <command>

命令:
  full-install  首次安装或补系统依赖，等价于执行完整 install_agent.sh 后重启
  redeploy      跳过 apt，只同步代码和 Python 依赖，然后重启服务
  quick         跳过 apt 和 pip，只同步代码后重启服务，适合频繁前后端测试
  restart       仅重启 files-agent
  status        查看 files-agent 状态
  logs [n]      查看最近 n 行日志，默认 80 行
  info          输出当前访问地址和 AGENT_TOKEN
  help          显示帮助

常用:
  bash scripts/agentctl.sh quick
  bash scripts/agentctl.sh redeploy
EOF
}

command="${1:-redeploy}"
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
  restart)
    ensure_root "$command" "$@"
    restart_agent
    status_agent
    show_access_info
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
  *)
    echo "未知命令: $command" >&2
    show_help >&2
    exit 1
    ;;
esac
