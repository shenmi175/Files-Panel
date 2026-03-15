#!/usr/bin/env bash

set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/files-agent/files-agent.env}"
SERVICE_USER="${SERVICE_USER:-filepanel}"
DATABASE_PATH="${DATABASE_PATH:-}"
STATE_DIR="${STATE_DIR:-}"
APP_DIR="/opt/files-agent"
READONLY_HELPER_SCRIPT="${APP_DIR}/scripts/readonly_system_helper.py"
GLOBAL_COMMAND_PATH="/usr/local/bin/file-panel"

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d "=" -f 2- || true
}

database_path() {
  if [[ -n "$DATABASE_PATH" ]]; then
    printf '%s\n' "$DATABASE_PATH"
    return
  fi
  local from_env
  from_env="$(read_env_value DATABASE_PATH)"
  if [[ -n "$from_env" ]]; then
    printf '%s\n' "$from_env"
    return
  fi
  printf '%s\n' "/var/lib/files-agent/file-panel.db"
}

read_db_config_value() {
  local key="$1"
  local db_path
  db_path="$(database_path)"
  if [[ ! -f "$db_path" ]]; then
    return 0
  fi
  sqlite3 -batch -noheader "$db_path" \
    "SELECT value FROM config WHERE key='${key}' LIMIT 1;" 2>/dev/null || true
}

read_setting_value() {
  local key="$1"
  local db_value
  db_value="$(read_db_config_value "$key")"
  if [[ -n "$db_value" ]]; then
    printf '%s\n' "$db_value"
    return
  fi
  read_env_value "$key"
}

state_dir_path() {
  if [[ -n "$STATE_DIR" ]]; then
    printf '%s\n' "$STATE_DIR"
    return
  fi
  local from_env
  from_env="$(read_env_value STATE_DIR)"
  if [[ -n "$from_env" ]]; then
    printf '%s\n' "$from_env"
    return
  fi
  printf '%s\n' "/var/lib/files-agent"
}

update_status_path() {
  printf '%s\n' "$(state_dir_path)/update-status.json"
}

update_log_path() {
  printf '%s\n' "$(state_dir_path)/update.log"
}

service_role() {
  local role
  role="$(read_env_value FILE_PANEL_ROLE)"
  if [[ -z "$role" ]]; then
    role="manager"
  fi
  printf '%s\n' "$role"
}

source_project_dir() {
  local configured
  configured="$(read_env_value FILE_PANEL_SOURCE_DIR)"
  if [[ -n "$configured" ]]; then
    printf '%s\n' "$configured"
    return
  fi
  printf '%s\n' "$APP_DIR"
}

is_project_dir() {
  local candidate="$1"
  [[ -n "$candidate" ]] \
    && [[ -d "$candidate/app" ]] \
    && [[ -d "$candidate/static" ]] \
    && [[ -d "$candidate/scripts" ]] \
    && [[ -f "$candidate/requirements.txt" ]]
}

write_update_status_json() {
  local status_value="$1"
  local mode_value="$2"
  local pull_latest_value="$3"
  local started_at_value="${4:-}"
  local finished_at_value="${5:-}"
  local message_value="${6:-}"
  local log_path_value="${7:-}"
  local status_path
  status_path="$(update_status_path)"
  install -d -m 750 "$(dirname "$status_path")"
  python3 - "$status_path" "$status_value" "$mode_value" "$pull_latest_value" "$started_at_value" "$finished_at_value" "$message_value" "$log_path_value" <<'PY'
import json
import sys
from pathlib import Path

status_path = Path(sys.argv[1])
payload = {
    "status": sys.argv[2],
    "mode": sys.argv[3] or None,
    "pull_latest": sys.argv[4] == "1",
    "started_at": sys.argv[5] or None,
    "finished_at": sys.argv[6] or None,
    "message": sys.argv[7] or None,
    "log_path": sys.argv[8] or None,
}
status_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
PY
}

validate_update_mode() {
  local mode="$1"
  case "$mode" in
    quick|redeploy|full-install)
      ;;
    *)
      echo "invalid update mode: $mode" >&2
      exit 2
      ;;
  esac
}

schedule_update() {
  local mode="${1:-quick}"
  local pull_latest="${2:-1}"
  local source_dir role status_path log_path started_at

  validate_update_mode "$mode"
  role="$(service_role)"
  source_dir="$(source_project_dir)"
  if ! is_project_dir "$source_dir"; then
    echo "automatic update source directory is invalid: $source_dir" >&2
    exit 2
  fi
  if [[ "$pull_latest" == "1" ]]; then
    if ! command -v git >/dev/null 2>&1; then
      echo "git is not installed on this node" >&2
      exit 2
    fi
    if ! git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "source directory is not a git repository: $source_dir" >&2
      exit 2
    fi
  fi

  status_path="$(update_status_path)"
  log_path="$(update_log_path)"
  started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  write_update_status_json "scheduled" "$mode" "$pull_latest" "$started_at" "" "update scheduled" "$log_path"
  : >"$log_path"

  nohup /bin/bash -lc "
set -euo pipefail
status_path=$(printf '%q' "$status_path")
log_path=$(printf '%q' "$log_path")
source_dir=$(printf '%q' "$source_dir")
mode=$(printf '%q' "$mode")
pull_latest=$(printf '%q' "$pull_latest")
global_command=$(printf '%q' "$GLOBAL_COMMAND_PATH")
helper_script=$(printf '%q' "$0")
started_at=\$(date -u +\"%Y-%m-%dT%H:%M:%SZ\")
python3 - \"\$status_path\" running \"\$mode\" \"\$pull_latest\" \"\$started_at\" \"\" \"update running\" \"\$log_path\" <<'PY'
import json
import sys
from pathlib import Path

status_path = Path(sys.argv[1])
payload = {
    'status': sys.argv[2],
    'mode': sys.argv[3] or None,
    'pull_latest': sys.argv[4] == '1',
    'started_at': sys.argv[5] or None,
    'finished_at': sys.argv[6] or None,
    'message': sys.argv[7] or None,
    'log_path': sys.argv[8] or None,
}
status_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
PY
{
  echo \"[\$(date -u +\"%Y-%m-%dT%H:%M:%SZ\")] starting automatic update (\$mode)\"
  if [[ \"\$pull_latest\" == \"1\" ]]; then
    echo \"[\$(date -u +\"%Y-%m-%dT%H:%M:%SZ\")] git pull --ff-only in \$source_dir\"
    git -C \"\$source_dir\" pull --ff-only
  else
    echo \"[\$(date -u +\"%Y-%m-%dT%H:%M:%SZ\")] skip git pull\"
  fi
  echo \"[\$(date -u +\"%Y-%m-%dT%H:%M:%SZ\")] invoking \$global_command \$mode\"
  FILE_PANEL_SOURCE_DIR=\"\$source_dir\" \"\$global_command\" \"\$mode\"
} >>\"\$log_path\" 2>&1
exit_code=\$?
finished_at=\$(date -u +\"%Y-%m-%dT%H:%M:%SZ\")
if [[ \$exit_code -eq 0 ]]; then
  python3 - \"\$status_path\" succeeded \"\$mode\" \"\$pull_latest\" \"\$started_at\" \"\$finished_at\" \"update completed\" \"\$log_path\" <<'PY'
import json
import sys
from pathlib import Path

status_path = Path(sys.argv[1])
payload = {
    'status': sys.argv[2],
    'mode': sys.argv[3] or None,
    'pull_latest': sys.argv[4] == '1',
    'started_at': sys.argv[5] or None,
    'finished_at': sys.argv[6] or None,
    'message': sys.argv[7] or None,
    'log_path': sys.argv[8] or None,
}
status_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
PY
else
  python3 - \"\$status_path\" failed \"\$mode\" \"\$pull_latest\" \"\$started_at\" \"\$finished_at\" \"update failed; inspect update.log\" \"\$log_path\" <<'PY'
import json
import sys
from pathlib import Path

status_path = Path(sys.argv[1])
payload = {
    'status': sys.argv[2],
    'mode': sys.argv[3] or None,
    'pull_latest': sys.argv[4] == '1',
    'started_at': sys.argv[5] or None,
    'finished_at': sys.argv[6] or None,
    'message': sys.argv[7] or None,
    'log_path': sys.argv[8] or None,
}
status_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
PY
fi
" >/dev/null 2>&1 &
}

DOMAIN_RE='^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
SERVICE_RE='^[A-Za-z0-9@._-]+$'
WG_IFACE_RE='^[A-Za-z0-9_.-]+$'
SENSITIVE_DIRS=(".ssh" ".gnupg" ".pki" ".aws" ".kube")
SENSITIVE_FILES=("id_rsa" "id_ed25519" "id_dsa" "id_ecdsa" "authorized_keys" "known_hosts")

require_domain() {
  local domain="$1"
  if [[ ! "$domain" =~ $DOMAIN_RE ]]; then
    echo "invalid domain: $domain" >&2
    exit 2
  fi
}

site_slug() {
  local domain="$1"
  printf '%s\n' "${domain//./-}"
}

site_paths() {
  local domain="$1"
  local file_name
  file_name="files-agent-$(site_slug "$domain").conf"
  SITE_PATH="${NGINX_SITES_AVAILABLE_DIR}/${file_name}"
  ENABLED_PATH="${NGINX_SITES_ENABLED_DIR}/${file_name}"
}

render_nginx_site() {
  local domain="$1"
  local upstream_port="$2"
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    client_max_body_size 2g;

    location / {
        proxy_pass http://127.0.0.1:${upstream_port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
}

ensure_dir() {
  install -d -m 755 "$1"
}

require_existing_path() {
  local target="$1"
  if [[ -z "$target" ]]; then
    echo "path is required" >&2
    exit 2
  fi
  if [[ ! -e "$target" ]]; then
    echo "path not found: $target" >&2
    exit 2
  fi
}

validate_grant_target() {
  local target="$1"
  case "$target" in
    /|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/etc|/etc/*|/boot|/boot/*|/run|/run/*|/var/run|/var/run/*|/root|/root/*)
      echo "refusing to grant access to protected path: $target" >&2
      exit 2
      ;;
  esac

  local component
  IFS='/' read -r -a parts <<<"$target"
  for component in "${parts[@]}"; do
    for sensitive_dir in "${SENSITIVE_DIRS[@]}"; do
      if [[ "$component" == "$sensitive_dir" ]]; then
        echo "refusing to grant access to sensitive path: $target" >&2
        exit 2
      fi
    done
  done

  local base_name
  base_name="$(basename "$target")"
  for sensitive_file in "${SENSITIVE_FILES[@]}"; do
    if [[ "$base_name" == "$sensitive_file" ]]; then
      echo "refusing to grant access to sensitive file: $target" >&2
      exit 2
    fi
  done
}

readonly_roots_raw() {
  local configured
  configured="$(read_setting_value SYSTEM_READONLY_PATHS)"
  if [[ -n "$configured" ]]; then
    printf '%s\n' "$configured"
    return
  fi
  printf '%s\n' "/root,/etc,/opt,/var/log"
}

validate_readonly_target() {
  local target="$1"
  local allowed_raw
  local allowed_root
  local resolved_allowed

  allowed_raw="$(readonly_roots_raw)"
  IFS=',' read -r -a readonly_parts <<<"$allowed_raw"
  for allowed_root in "${readonly_parts[@]}"; do
    allowed_root="$(echo "$allowed_root" | xargs)"
    [[ -z "$allowed_root" ]] && continue
    resolved_allowed="$(realpath -m "$allowed_root")"
    if [[ "$target" == "$resolved_allowed" || "$target" == "$resolved_allowed/"* ]]; then
      return
    fi
  done

  echo "path is outside configured readonly system roots: $target" >&2
  exit 2
}

grant_parent_traverse() {
  local target="$1"
  local current
  current="$(dirname "$target")"
  while [[ -n "$current" && "$current" != "/" && "$current" != "." ]]; do
    setfacl -m "u:${SERVICE_USER}:x" "$current"
    current="$(dirname "$current")"
  done
}

grant_directory_tree_access() {
  local target="$1"
  find "$target" \
    \( -type d \( -name .ssh -o -name .gnupg -o -name .pki -o -name .aws -o -name .kube \) -prune \) \
    -o -type d -print0 | xargs -0 -r setfacl -m "u:${SERVICE_USER}:rwx" -m "d:u:${SERVICE_USER}:rwx"

  find "$target" \
    \( -type d \( -name .ssh -o -name .gnupg -o -name .pki -o -name .aws -o -name .kube \) -prune \) \
    -o \( -type f \( -name id_rsa -o -name id_ed25519 -o -name id_dsa -o -name id_ecdsa -o -name authorized_keys -o -name known_hosts \) -prune \) \
    -o -type f -print0 | xargs -0 -r setfacl -m "u:${SERVICE_USER}:rw"
}

grant_path_access() {
  local target_raw="$1"
  local target
  require_existing_path "$target_raw"
  if ! command -v setfacl >/dev/null 2>&1; then
    echo "setfacl is not installed; install acl first" >&2
    exit 2
  fi

  target="$(realpath "$target_raw")"
  validate_grant_target "$target"
  grant_parent_traverse "$target"

  if [[ -d "$target" ]]; then
    grant_directory_tree_access "$target"
    return
  fi

  setfacl -m "u:${SERVICE_USER}:rw" "$target"
}

revoke_path_access() {
  local target_raw="$1"
  local target
  require_existing_path "$target_raw"
  if ! command -v setfacl >/dev/null 2>&1; then
    echo "setfacl is not installed; install acl first" >&2
    exit 2
  fi

  target="$(realpath "$target_raw")"
  if [[ -d "$target" ]]; then
    while IFS= read -r -d '' directory; do
      setfacl -x "u:${SERVICE_USER}" "$directory" 2>/dev/null || true
      setfacl -x "d:u:${SERVICE_USER}" "$directory" 2>/dev/null || true
    done < <(find "$target" -type d -print0)

    while IFS= read -r -d '' file_path; do
      setfacl -x "u:${SERVICE_USER}" "$file_path" 2>/dev/null || true
    done < <(find "$target" -type f -print0)

    setfacl -x "u:${SERVICE_USER}" "$target" 2>/dev/null || true
    setfacl -x "d:u:${SERVICE_USER}" "$target" 2>/dev/null || true
    return
  fi

  setfacl -x "u:${SERVICE_USER}" "$target" 2>/dev/null || true
}

write_nginx_site() {
  local domain="$1"
  local upstream_port="$2"
  require_domain "$domain"
  if [[ ! "$upstream_port" =~ ^[0-9]+$ ]]; then
    echo "invalid upstream port: $upstream_port" >&2
    exit 2
  fi

  ensure_dir "$NGINX_SITES_AVAILABLE_DIR"
  ensure_dir "$NGINX_SITES_ENABLED_DIR"
  site_paths "$domain"
  render_nginx_site "$domain" "$upstream_port" >"$SITE_PATH"
  ln -sfn "$SITE_PATH" "$ENABLED_PATH"
}

replace_nginx_site_stdin() {
  local domain="$1"
  require_domain "$domain"
  ensure_dir "$NGINX_SITES_AVAILABLE_DIR"
  ensure_dir "$NGINX_SITES_ENABLED_DIR"
  site_paths "$domain"
  cat >"$SITE_PATH"
  ln -sfn "$SITE_PATH" "$ENABLED_PATH"
}

read_nginx_site() {
  local domain="$1"
  require_domain "$domain"
  site_paths "$domain"
  if [[ ! -f "$SITE_PATH" ]]; then
    exit 4
  fi
  cat "$SITE_PATH"
}

remove_nginx_site() {
  local domain="$1"
  require_domain "$domain"
  site_paths "$domain"
  rm -f "$ENABLED_PATH" "$SITE_PATH"
}

validate_nginx() {
  nginx -t
}

enable_nginx() {
  if [[ ! "$NGINX_SERVICE_NAME" =~ $SERVICE_RE ]]; then
    echo "invalid nginx service name: $NGINX_SERVICE_NAME" >&2
    exit 2
  fi
  systemctl enable --now "$NGINX_SERVICE_NAME"
}

reload_nginx() {
  if [[ ! "$NGINX_SERVICE_NAME" =~ $SERVICE_RE ]]; then
    echo "invalid nginx service name: $NGINX_SERVICE_NAME" >&2
    exit 2
  fi
  systemctl reload "$NGINX_SERVICE_NAME"
}

restart_agent() {
  if [[ ! "$AGENT_SERVICE_NAME" =~ $SERVICE_RE ]]; then
    echo "invalid agent service name: $AGENT_SERVICE_NAME" >&2
    exit 2
  fi
  systemctl restart "$AGENT_SERVICE_NAME"
}

require_wireguard_interface() {
  local interface_name="$1"
  if [[ ! "$interface_name" =~ $WG_IFACE_RE ]]; then
    echo "invalid wireguard interface: $interface_name" >&2
    exit 2
  fi
}

wireguard_status() {
  local interface_name="${1:-wg0}"
  require_wireguard_interface "$interface_name"
  if ! command -v wg >/dev/null 2>&1 || ! command -v ip >/dev/null 2>&1; then
    echo "wireguard-tools is not installed" >&2
    exit 2
  fi

  local public_key listen_port address
  public_key="$(wg show "$interface_name" public-key 2>/dev/null || true)"
  if [[ -z "$public_key" ]]; then
    exit 4
  fi

  listen_port="$(wg show "$interface_name" listen-port 2>/dev/null || true)"
  address="$(ip -4 -o addr show "$interface_name" 2>/dev/null | awk '{print $4}' | head -n 1)"
  printf '{"interface":"%s","public_key":"%s","listen_port":%s,"address":"%s"}\n' \
    "$interface_name" \
    "$public_key" \
    "${listen_port:-0}" \
    "$address"
}

replace_wireguard_config_stdin() {
  local interface_name="${1:-wg0}"
  require_wireguard_interface "$interface_name"
  install -d -m 700 /etc/wireguard
  cat >"/etc/wireguard/${interface_name}.conf"
  chmod 600 "/etc/wireguard/${interface_name}.conf"
}

enable_wireguard() {
  local interface_name="${1:-wg0}"
  require_wireguard_interface "$interface_name"
  systemctl enable --now "wg-quick@${interface_name}"
}

wireguard_add_peer() {
  local interface_name="${1:-wg0}"
  local public_key="${2:-}"
  local allowed_ip="${3:-}"
  local keepalive="${4:-25}"
  require_wireguard_interface "$interface_name"
  if [[ -z "$public_key" || -z "$allowed_ip" ]]; then
    echo "wireguard peer public key and allowed IP are required" >&2
    exit 2
  fi
  if ! command -v wg >/dev/null 2>&1; then
    echo "wireguard-tools is not installed" >&2
    exit 2
  fi

  wg set "$interface_name" peer "$public_key" allowed-ips "$allowed_ip" persistent-keepalive "$keepalive"
  if command -v wg-quick >/dev/null 2>&1; then
    wg-quick save "$interface_name" >/dev/null 2>&1 || true
  fi
}

readonly_list_json() {
  local target_raw="${1:-}"
  local show_hidden="${2:-false}"
  local target
  require_existing_path "$target_raw"
  target="$(realpath "$target_raw")"
  validate_readonly_target "$target"
  python3 "$READONLY_HELPER_SCRIPT" list "$target" "$show_hidden"
}

readonly_read_file() {
  local target_raw="${1:-}"
  local target
  require_existing_path "$target_raw"
  target="$(realpath "$target_raw")"
  validate_readonly_target "$target"
  python3 "$READONLY_HELPER_SCRIPT" read "$target"
}

issue_cert() {
  local domain="$1"
  local email="${2:-}"
  require_domain "$domain"
  local args=(
    --nginx
    -d "$domain"
    --non-interactive
    --agree-tos
    --redirect
    --keep-until-expiring
  )
  if [[ -n "$email" ]]; then
    args+=(-m "$email")
  else
    args+=(--register-unsafely-without-email)
  fi
  certbot "${args[@]}"
}

NGINX_SITES_AVAILABLE_DIR="$(read_env_value NGINX_SITES_AVAILABLE_DIR)"
NGINX_SITES_ENABLED_DIR="$(read_env_value NGINX_SITES_ENABLED_DIR)"
NGINX_SERVICE_NAME="$(read_env_value NGINX_SERVICE_NAME)"
AGENT_SERVICE_NAME="$(read_env_value AGENT_SERVICE_NAME)"

if [[ -z "$NGINX_SITES_AVAILABLE_DIR" ]]; then
  NGINX_SITES_AVAILABLE_DIR="/etc/nginx/sites-available"
fi
if [[ -z "$NGINX_SITES_ENABLED_DIR" ]]; then
  NGINX_SITES_ENABLED_DIR="/etc/nginx/sites-enabled"
fi
if [[ -z "$NGINX_SERVICE_NAME" ]]; then
  NGINX_SERVICE_NAME="nginx"
fi
if [[ -z "$AGENT_SERVICE_NAME" ]]; then
  AGENT_SERVICE_NAME="files-agent"
fi

command="${1:-}"
shift || true

case "$command" in
  write-nginx-site)
    write_nginx_site "$1" "$2"
    ;;
  replace-nginx-site-stdin)
    replace_nginx_site_stdin "$1"
    ;;
  read-nginx-site)
    read_nginx_site "$1"
    ;;
  remove-nginx-site)
    remove_nginx_site "$1"
    ;;
  validate-nginx)
    validate_nginx
    ;;
  enable-nginx)
    enable_nginx
    ;;
  reload-nginx)
    reload_nginx
    ;;
  restart-agent)
    restart_agent
    ;;
  wireguard-status)
    wireguard_status "${1:-wg0}"
    ;;
  replace-wireguard-config-stdin)
    replace_wireguard_config_stdin "${1:-wg0}"
    ;;
  enable-wireguard)
    enable_wireguard "${1:-wg0}"
    ;;
  wireguard-add-peer)
    wireguard_add_peer "${1:-wg0}" "${2:-}" "${3:-}" "${4:-25}"
    ;;
  readonly-list-json)
    readonly_list_json "${1:-}" "${2:-false}"
    ;;
  readonly-read-file)
    readonly_read_file "${1:-}"
    ;;
  issue-cert)
    issue_cert "${1:-}" "${2:-}"
    ;;
  schedule-update)
    schedule_update "${1:-quick}" "${2:-1}"
    ;;
  grant-path-access)
    grant_path_access "${1:-}"
    ;;
  revoke-path-access)
    revoke_path_access "${1:-}"
    ;;
  *)
    echo "unknown helper command: ${command}" >&2
    exit 2
    ;;
esac
