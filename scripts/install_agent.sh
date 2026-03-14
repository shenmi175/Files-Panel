#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/opt/files-agent"
ENV_DIR="/etc/files-agent"
ENV_FILE="$ENV_DIR/files-agent.env"
STATE_DIR="/var/lib/files-agent"
DATABASE_PATH="$STATE_DIR/file-panel.db"
AGENT_ROOT_BASE="/srv/file-panel"
DEFAULT_AGENT_ROOT="$AGENT_ROOT_BASE/data"
SERVICE_NAME="files-agent"
SERVICE_USER="filepanel"
SERVICE_GROUP="filepanel"
NGINX_SERVICE_NAME="nginx"
NGINX_SITES_AVAILABLE_DIR="/etc/nginx/sites-available"
NGINX_SITES_ENABLED_DIR="/etc/nginx/sites-enabled"
GLOBAL_COMMAND_PATH="/usr/local/bin/file-panel"
HELPER_INSTALL_DIR="/usr/local/libexec/file-panel"
HELPER_INSTALL_PATH="$HELPER_INSTALL_DIR/file-panel-helper.sh"
SUDOERS_FILE="/etc/sudoers.d/file-panel"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="${PROJECT_DIR_OVERRIDE:-$DEFAULT_PROJECT_DIR}"
INSTALL_SYSTEM_PACKAGES="${INSTALL_SYSTEM_PACKAGES:-1}"
SYNC_PYTHON_DEPS="${SYNC_PYTHON_DEPS:-1}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行安装脚本" >&2
  exit 1
fi

if [[ ! -d "$PROJECT_DIR/app" || ! -d "$PROJECT_DIR/static" || ! -d "$PROJECT_DIR/scripts" ]]; then
  echo "无效的源码目录: $PROJECT_DIR" >&2
  exit 1
fi

append_group_if_exists() {
  local user_name="$1"
  local group_name="$2"
  if getent group "$group_name" >/dev/null 2>&1; then
    usermod -a -G "$group_name" "$user_name"
  fi
}

if [[ "$INSTALL_SYSTEM_PACKAGES" == "1" ]]; then
  apt-get update
  apt-get install -y sudo python3 python3-venv python3-pip nginx certbot python3-certbot-nginx sqlite3 wireguard-tools acl
fi

if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  groupadd --system "$SERVICE_GROUP"
fi

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd \
    --system \
    --gid "$SERVICE_GROUP" \
    --home-dir "$STATE_DIR" \
    --shell /usr/sbin/nologin \
    --no-create-home \
    "$SERVICE_USER"
fi

append_group_if_exists "$SERVICE_USER" "systemd-journal"
append_group_if_exists "$SERVICE_USER" "adm"
append_group_if_exists "$SERVICE_USER" "docker"

install -d -m 755 "$APP_DIR"
install -d -m 750 -o root -g "$SERVICE_GROUP" "$ENV_DIR"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$AGENT_ROOT_BASE"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$DEFAULT_AGENT_ROOT"
install -d -m 755 "$HELPER_INSTALL_DIR"
chown -R "$SERVICE_USER":"$SERVICE_GROUP" "$STATE_DIR"
chown -R "$SERVICE_USER":"$SERVICE_GROUP" "$AGENT_ROOT_BASE"

cp -a "$PROJECT_DIR/app" "$APP_DIR/"
cp -a "$PROJECT_DIR/static" "$APP_DIR/"
cp -a "$PROJECT_DIR/scripts" "$APP_DIR/"
cp -a "$PROJECT_DIR/README.md" "$APP_DIR/"
cp -a "$PROJECT_DIR/requirements.txt" "$APP_DIR/"
cp -a "$PROJECT_DIR/.env.example" "$APP_DIR/"
cp -a "$PROJECT_DIR/systemd/$SERVICE_NAME.service" "/etc/systemd/system/$SERVICE_NAME.service"
install -o root -g root -m 755 "$PROJECT_DIR/scripts/file-panel" "$GLOBAL_COMMAND_PATH"
install -o root -g root -m 755 "$PROJECT_DIR/scripts/file-panel-helper.sh" "$HELPER_INSTALL_PATH"

chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"

cat >"$SUDOERS_FILE" <<EOF
Defaults:${SERVICE_USER} !requiretty
${SERVICE_USER} ALL=(root) NOPASSWD: ${HELPER_INSTALL_PATH} *
EOF
chmod 440 "$SUDOERS_FILE"

if [[ ! -x "$APP_DIR/.venv/bin/python" ]]; then
  python3 -m venv "$APP_DIR/.venv"
fi

if [[ "$SYNC_PYTHON_DEPS" == "1" ]]; then
  "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"
fi

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d "=" -f 2- || true
}

read_db_config_value() {
  local key="$1"
  if [[ ! -f "$DATABASE_PATH" ]]; then
    return 0
  fi
  sqlite3 -batch -noheader "$DATABASE_PATH" \
    "SELECT value FROM config WHERE key='${key}' LIMIT 1;" 2>/dev/null || true
}

read_access_value() {
  local key="$1"
  if [[ ! -f "$DATABASE_PATH" ]]; then
    return 0
  fi
  sqlite3 -batch -noheader "$DATABASE_PATH" \
    "SELECT ${key} FROM access_state WHERE singleton_id=1 LIMIT 1;" 2>/dev/null || true
}

read_config_value() {
  local key="$1"
  local from_db
  from_db="$(read_db_config_value "$key")"
  if [[ -n "$from_db" ]]; then
    printf '%s\n' "$from_db"
    return
  fi
  read_env_value "$key"
}

TOKEN="$(read_config_value AGENT_TOKEN)"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$("$APP_DIR/.venv/bin/python" "$APP_DIR/scripts/generate_token.py")"
fi

AGENT_NAME_VALUE="$(read_config_value AGENT_NAME)"
if [[ -z "$AGENT_NAME_VALUE" ]]; then
  AGENT_NAME_VALUE="$(hostname)"
fi

ROOT_VALUE="$(read_config_value AGENT_ROOT)"
if [[ -z "$ROOT_VALUE" ]]; then
  ROOT_VALUE="$DEFAULT_AGENT_ROOT"
fi

SAMPLE_INTERVAL_VALUE="$(read_config_value RESOURCE_SAMPLE_INTERVAL)"
if [[ -z "$SAMPLE_INTERVAL_VALUE" ]]; then
  SAMPLE_INTERVAL_VALUE="15"
fi

PUBLIC_DOMAIN_VALUE="$(read_access_value domain)"
if [[ -z "$PUBLIC_DOMAIN_VALUE" ]]; then
  PUBLIC_DOMAIN_VALUE="$(read_env_value PUBLIC_DOMAIN)"
fi
CERTBOT_EMAIL_VALUE="$(read_config_value CERTBOT_EMAIL)"
HOST_VALUE="0.0.0.0"
if [[ -n "$PUBLIC_DOMAIN_VALUE" ]]; then
  HOST_VALUE="127.0.0.1"
fi

if [[ "$ROOT_VALUE" == "$DEFAULT_AGENT_ROOT" ]]; then
  install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$ROOT_VALUE"
elif [[ "$ROOT_VALUE" == "$AGENT_ROOT_BASE" || "$ROOT_VALUE" == "$AGENT_ROOT_BASE/"* ]]; then
  install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$ROOT_VALUE"
  chown -R "$SERVICE_USER":"$SERVICE_GROUP" "$AGENT_ROOT_BASE"
fi

if [[ -d "$ROOT_VALUE" ]]; then
  if ! "$HELPER_INSTALL_PATH" grant-path-access "$ROOT_VALUE"; then
    echo "跳过自动授权: ${ROOT_VALUE}" >&2
  fi
fi

cat >"$ENV_FILE" <<EOF
# Managed by File Panel installer
HOST=$HOST_VALUE
PORT=3000
AGENT_NAME=$AGENT_NAME_VALUE
AGENT_ROOT=$ROOT_VALUE
AGENT_TOKEN=$TOKEN
RESOURCE_SAMPLE_INTERVAL=$SAMPLE_INTERVAL_VALUE
ENV_FILE_PATH=$ENV_FILE
STATE_DIR=$STATE_DIR
DATABASE_PATH=$DATABASE_PATH
NGINX_SITES_AVAILABLE_DIR=$NGINX_SITES_AVAILABLE_DIR
NGINX_SITES_ENABLED_DIR=$NGINX_SITES_ENABLED_DIR
AGENT_SERVICE_NAME=$SERVICE_NAME
NGINX_SERVICE_NAME=$NGINX_SERVICE_NAME
CERTBOT_EMAIL=$CERTBOT_EMAIL_VALUE
ALLOW_SELF_RESTART=1
PRIVILEGED_HELPER_PATH=$HELPER_INSTALL_PATH
EOF

if [[ -n "$PUBLIC_DOMAIN_VALUE" ]]; then
  printf 'PUBLIC_DOMAIN=%s\n' "$PUBLIC_DOMAIN_VALUE" >>"$ENV_FILE"
fi

chown root:"$SERVICE_GROUP" "$ENV_FILE"
chmod 640 "$ENV_FILE"

systemctl daemon-reload
systemctl enable --now "$NGINX_SERVICE_NAME"
systemctl enable --now "$SERVICE_NAME"

SERVER_IP="$(hostname -I | awk '{print $1}')"

echo
echo "File Panel 安装完成"
echo "临时访问地址: http://${SERVER_IP}:3000"
echo "AGENT_TOKEN: ${TOKEN}"
echo "SQLite 数据库: ${DATABASE_PATH}"
echo "默认文件根目录: ${ROOT_VALUE}"
echo "服务用户: ${SERVICE_USER}"
echo "WireGuard: 已安装 wireguard-tools，可用于后续节点互联"
echo "全局命令: file-panel start | file-panel restart | file-panel status | file-panel uninstall"
if [[ -n "$CERTBOT_EMAIL_VALUE" ]]; then
  echo "Certbot 邮箱: ${CERTBOT_EMAIL_VALUE}"
fi
if [[ -n "$PUBLIC_DOMAIN_VALUE" ]]; then
  echo "已保留现有域名配置: https://${PUBLIC_DOMAIN_VALUE}"
fi
