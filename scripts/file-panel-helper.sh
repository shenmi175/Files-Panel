#!/usr/bin/env bash

set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/files-agent/files-agent.env}"

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d "=" -f 2- || true
}

DOMAIN_RE='^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
SERVICE_RE='^[A-Za-z0-9@._-]+$'

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
  issue-cert)
    issue_cert "${1:-}" "${2:-}"
    ;;
  *)
    echo "unknown helper command: ${command}" >&2
    exit 2
    ;;
esac
