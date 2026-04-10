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
FILE_PANEL_ROLE="${FILE_PANEL_ROLE_OVERRIDE:-manager}"
INSTALL_WEB_STACK_PACKAGES="${INSTALL_WEB_STACK_PACKAGES:-1}"
DEFAULT_BIND_HOST_OVERRIDE="${DEFAULT_BIND_HOST_OVERRIDE:-}"
SERVICE_UNIT_FILE="${SERVICE_UNIT_FILE_OVERRIDE:-$PROJECT_DIR/systemd/$SERVICE_NAME.service}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run the installer as root." >&2
  exit 1
fi

if [[ "$FILE_PANEL_ROLE" != "manager" && "$FILE_PANEL_ROLE" != "agent" ]]; then
  echo "Invalid FILE_PANEL_ROLE: $FILE_PANEL_ROLE" >&2
  exit 1
fi

if [[ ! -d "$PROJECT_DIR/app" || ! -d "$PROJECT_DIR/static" || ! -d "$PROJECT_DIR/scripts" ]]; then
  echo "Invalid project directory: $PROJECT_DIR" >&2
  exit 1
fi

if [[ ! -f "$SERVICE_UNIT_FILE" ]]; then
  echo "Missing systemd unit file: $SERVICE_UNIT_FILE" >&2
  exit 1
fi

append_group_if_exists() {
  local user_name="$1"
  local group_name="$2"
  if getent group "$group_name" >/dev/null 2>&1; then
    usermod -a -G "$group_name" "$user_name"
  fi
}

install_system_packages() {
  local base_packages=(
    sudo
    python3
    python3-venv
    python3-pip
    sqlite3
    wireguard-tools
    acl
  )
  local web_packages=(
    nginx
    certbot
    python3-certbot-nginx
  )

  if [[ "$INSTALL_SYSTEM_PACKAGES" != "1" ]]; then
    return
  fi

  apt-get update
  apt-get install -y "${base_packages[@]}"
  if [[ "$INSTALL_WEB_STACK_PACKAGES" == "1" ]]; then
    apt-get install -y "${web_packages[@]}"
  fi
}

copy_project_files() {
  install -d -m 755 "$APP_DIR"
  rm -rf "$APP_DIR/app" "$APP_DIR/static" "$APP_DIR/scripts" "$APP_DIR/systemd" "$APP_DIR/wiki"
  # Remove legacy root-level docs from older installs before copying README + wiki/.
  rm -f \
    "$APP_DIR/README.md" \
    "$APP_DIR/ARCHITECTURE.md" \
    "$APP_DIR/API.md" \
    "$APP_DIR/CONCEPTS.md" \
    "$APP_DIR/DEVELOPMENT.md" \
    "$APP_DIR/USAGE.md" \
    "$APP_DIR/WIREGUARD.md" \
    "$APP_DIR/WIREGUARD_BOOTSTRAP.md" \
    "$APP_DIR/AGENT_ONBOARDING.md" \
    "$APP_DIR/VERSION" \
    "$APP_DIR/requirements.txt" \
    "$APP_DIR/.env.example"

  cp -a "$PROJECT_DIR/app" "$APP_DIR/"
  cp -a "$PROJECT_DIR/static" "$APP_DIR/"
  cp -a "$PROJECT_DIR/scripts" "$APP_DIR/"
  cp -a "$PROJECT_DIR/systemd" "$APP_DIR/"
  if [[ -d "$PROJECT_DIR/wiki" ]]; then
    cp -a "$PROJECT_DIR/wiki" "$APP_DIR/"
  fi

  for doc_name in README.md VERSION requirements.txt .env.example; do
    if [[ -f "$PROJECT_DIR/$doc_name" ]]; then
      cp -a "$PROJECT_DIR/$doc_name" "$APP_DIR/"
    fi
  done

  cp -a "$SERVICE_UNIT_FILE" "/etc/systemd/system/$SERVICE_NAME.service"
  install -o root -g root -m 755 "$PROJECT_DIR/scripts/file-panel" "$GLOBAL_COMMAND_PATH"
  install -o root -g root -m 755 "$PROJECT_DIR/scripts/file-panel-helper.sh" "$HELPER_INSTALL_PATH"

  chown -R root:root "$APP_DIR"
  chmod -R a+rX "$APP_DIR"
}

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

wireguard_ip() {
  if ! command -v ip >/dev/null 2>&1; then
    return 0
  fi
  ip -4 -o addr show wg0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true
}

install_system_packages

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

install -d -m 750 -o root -g "$SERVICE_GROUP" "$ENV_DIR"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$AGENT_ROOT_BASE"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$DEFAULT_AGENT_ROOT"
install -d -m 755 "$HELPER_INSTALL_DIR"
chown -R "$SERVICE_USER":"$SERVICE_GROUP" "$STATE_DIR"
chown -R "$SERVICE_USER":"$SERVICE_GROUP" "$AGENT_ROOT_BASE"

copy_project_files

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
  SAMPLE_INTERVAL_VALUE="5"
fi

UPDATE_CHANNEL_VALUE="$(read_config_value UPDATE_CHANNEL)"
if [[ -z "$UPDATE_CHANNEL_VALUE" ]]; then
  UPDATE_CHANNEL_VALUE="main"
fi

SYSTEM_READONLY_PATHS_VALUE="$(read_config_value SYSTEM_READONLY_PATHS)"
if [[ -z "$SYSTEM_READONLY_PATHS_VALUE" ]]; then
  SYSTEM_READONLY_PATHS_VALUE="/root,/etc,/opt,/var/log"
fi

PUBLIC_DOMAIN_VALUE="$(read_access_value domain)"
if [[ -z "$PUBLIC_DOMAIN_VALUE" ]]; then
  PUBLIC_DOMAIN_VALUE="$(read_env_value PUBLIC_DOMAIN)"
fi

CERTBOT_EMAIL_VALUE="$(read_config_value CERTBOT_EMAIL)"
HOST_VALUE="0.0.0.0"
if [[ -n "$DEFAULT_BIND_HOST_OVERRIDE" ]]; then
  HOST_VALUE="$DEFAULT_BIND_HOST_OVERRIDE"
elif [[ "$FILE_PANEL_ROLE" == "manager" && -n "$PUBLIC_DOMAIN_VALUE" ]]; then
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
    echo "Skipping automatic access grant for protected path: $ROOT_VALUE" >&2
  fi
fi

cat >"$ENV_FILE" <<EOF
# Managed by File Panel installer
FILE_PANEL_ROLE=$FILE_PANEL_ROLE
FILE_PANEL_SOURCE_DIR=$PROJECT_DIR
HOST=$HOST_VALUE
PORT=3000
AGENT_NAME=$AGENT_NAME_VALUE
AGENT_ROOT=$ROOT_VALUE
AGENT_TOKEN=$TOKEN
UPDATE_CHANNEL=$UPDATE_CHANNEL_VALUE
RESOURCE_SAMPLE_INTERVAL=$SAMPLE_INTERVAL_VALUE
SYSTEM_READONLY_PATHS=$SYSTEM_READONLY_PATHS_VALUE
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
if [[ "$FILE_PANEL_ROLE" == "manager" ]] && systemctl list-unit-files | grep -q "^${NGINX_SERVICE_NAME}.service"; then
  systemctl enable --now "$NGINX_SERVICE_NAME"
fi
systemctl enable --now "$SERVICE_NAME"

SERVER_IP="$(hostname -I | awk '{print $1}')"
WIREGUARD_IP_VALUE="$(wireguard_ip)"

echo
if [[ "$FILE_PANEL_ROLE" == "manager" ]]; then
  echo "File Panel manager installed"
  if [[ -n "$PUBLIC_DOMAIN_VALUE" ]]; then
    echo "Manager URL: https://${PUBLIC_DOMAIN_VALUE}"
  elif [[ "$HOST_VALUE" == "127.0.0.1" || "$HOST_VALUE" == "::1" || "$HOST_VALUE" == "localhost" ]]; then
    echo "Manager URL: http://127.0.0.1:3000"
  else
    echo "Manager URL: http://${SERVER_IP}:3000"
  fi
else
  echo "File Panel agent installed"
  if [[ "$HOST_VALUE" == "127.0.0.1" || "$HOST_VALUE" == "::1" || "$HOST_VALUE" == "localhost" ]]; then
    echo "Agent API: http://127.0.0.1:3000"
  else
    echo "Agent API: http://${SERVER_IP}:3000"
  fi
  echo "Browser UI: disabled on agent-only nodes"
  echo "Next step: run 'sudo file-panel setup-agent' for interactive WireGuard onboarding"
fi

echo "Role: ${FILE_PANEL_ROLE}"
echo "AGENT_TOKEN: ${TOKEN}"
echo "Release channel: ${UPDATE_CHANNEL_VALUE}"
echo "SQLite: ${DATABASE_PATH}"
echo "Default file root: ${ROOT_VALUE}"
echo "Service user: ${SERVICE_USER}"
if [[ -n "$WIREGUARD_IP_VALUE" ]]; then
  echo "WireGuard IP: ${WIREGUARD_IP_VALUE}"
fi
echo "WireGuard: wireguard-tools is installed"
if [[ "$FILE_PANEL_ROLE" == "manager" ]]; then
  echo "WireGuard bootstrap: configure wg0 on the manager first, then generate one-time bootstrap commands from the Nodes view"
else
  echo "WireGuard onboarding: run 'sudo file-panel setup-agent' for the interactive wizard"
  echo "Advanced mode: 'sudo file-panel bootstrap-wireguard --manager-url <manager-url> --bootstrap-token <token>'"
fi
echo "Global command: file-panel start | file-panel restart | file-panel status | file-panel info | file-panel setup-agent | file-panel uninstall"
if [[ -n "$CERTBOT_EMAIL_VALUE" ]]; then
  echo "Certbot email: ${CERTBOT_EMAIL_VALUE}"
fi
if [[ -n "$PUBLIC_DOMAIN_VALUE" ]]; then
  echo "Existing domain preserved: https://${PUBLIC_DOMAIN_VALUE}"
fi
