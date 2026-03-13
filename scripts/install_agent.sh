#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/opt/files-agent"
ENV_DIR="/etc/files-agent"
ENV_FILE="$ENV_DIR/files-agent.env"
STATE_DIR="/var/lib/files-agent"
SERVICE_NAME="files-agent"
NGINX_SERVICE_NAME="nginx"
NGINX_SITES_AVAILABLE_DIR="/etc/nginx/sites-available"
NGINX_SITES_ENABLED_DIR="/etc/nginx/sites-enabled"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行安装脚本" >&2
  exit 1
fi

apt-get update
apt-get install -y python3 python3-venv python3-pip nginx certbot python3-certbot-nginx

install -d -m 755 "$APP_DIR" "$ENV_DIR" "$STATE_DIR"

cp -a "$PROJECT_DIR/app" "$APP_DIR/"
cp -a "$PROJECT_DIR/static" "$APP_DIR/"
cp -a "$PROJECT_DIR/scripts" "$APP_DIR/"
cp -a "$PROJECT_DIR/README.md" "$APP_DIR/"
cp -a "$PROJECT_DIR/requirements.txt" "$APP_DIR/"
cp -a "$PROJECT_DIR/.env.example" "$APP_DIR/"
cp -a "$PROJECT_DIR/systemd/$SERVICE_NAME.service" "/etc/systemd/system/$SERVICE_NAME.service"

python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d "=" -f 2- || true
}

TOKEN="$(read_env_value AGENT_TOKEN)"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$("$APP_DIR/.venv/bin/python" "$APP_DIR/scripts/generate_token.py")"
fi

AGENT_NAME_VALUE="$(read_env_value AGENT_NAME)"
if [[ -z "$AGENT_NAME_VALUE" ]]; then
  AGENT_NAME_VALUE="$(hostname)"
fi

ROOT_VALUE="$(read_env_value AGENT_ROOT)"
if [[ -z "$ROOT_VALUE" ]]; then
  ROOT_VALUE="/"
fi

PUBLIC_DOMAIN_VALUE="$(read_env_value PUBLIC_DOMAIN)"
CERTBOT_EMAIL_VALUE="$(read_env_value CERTBOT_EMAIL)"
HOST_VALUE="0.0.0.0"
if [[ -n "$PUBLIC_DOMAIN_VALUE" ]]; then
  HOST_VALUE="127.0.0.1"
fi

cat >"$ENV_FILE" <<EOF
# Managed by Files Agent installer
HOST=$HOST_VALUE
PORT=3000
AGENT_NAME=$AGENT_NAME_VALUE
AGENT_ROOT=$ROOT_VALUE
AGENT_TOKEN=$TOKEN
ENV_FILE_PATH=$ENV_FILE
STATE_DIR=$STATE_DIR
NGINX_SITES_AVAILABLE_DIR=$NGINX_SITES_AVAILABLE_DIR
NGINX_SITES_ENABLED_DIR=$NGINX_SITES_ENABLED_DIR
AGENT_SERVICE_NAME=$SERVICE_NAME
NGINX_SERVICE_NAME=$NGINX_SERVICE_NAME
CERTBOT_EMAIL=$CERTBOT_EMAIL_VALUE
ALLOW_SELF_RESTART=1
EOF

if [[ -n "$PUBLIC_DOMAIN_VALUE" ]]; then
  printf 'PUBLIC_DOMAIN=%s\n' "$PUBLIC_DOMAIN_VALUE" >>"$ENV_FILE"
fi

chmod 600 "$ENV_FILE"

systemctl daemon-reload
systemctl enable --now "$NGINX_SERVICE_NAME"
systemctl enable --now "$SERVICE_NAME"

SERVER_IP="$(hostname -I | awk '{print $1}')"

echo
echo "Files Agent 安装完成"
echo "临时访问地址: http://${SERVER_IP}:3000"
echo "AGENT_TOKEN: ${TOKEN}"
echo "Nginx: 已启用，域名接入时会自动写入站点配置并调用 certbot"
if [[ -n "$CERTBOT_EMAIL_VALUE" ]]; then
  echo "Certbot 邮箱: ${CERTBOT_EMAIL_VALUE}"
fi
if [[ -n "$PUBLIC_DOMAIN_VALUE" ]]; then
  echo "已保留现有域名配置: https://${PUBLIC_DOMAIN_VALUE}"
fi
