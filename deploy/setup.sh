#!/usr/bin/env bash
#
# One-shot install for a fresh Debian/Ubuntu droplet.
#
#   sudo bash deploy/setup.sh tesla.example.com you@example.com
#
# Point the hostname's DNS A record at this droplet BEFORE running this —
# certbot proves control of the name over HTTP and will fail otherwise.
#
# Safe to re-run: every step checks for its own result first.

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR="/opt/teslos"
APP_USER="teslos"
CONF="/etc/default/teslos-setup"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/setup.sh <domain> <email>" >&2
  exit 1
fi

# Re-runs are the normal case — a firewall or DNS fix between attempts — and
# retyping the arguments on a phone keyboard is its own small punishment.
if [[ -z "$DOMAIN" || -z "$EMAIL" ]] && [[ -f "$CONF" ]]; then
  # shellcheck disable=SC1090
  source "$CONF"
  DOMAIN="${DOMAIN:-${TESLOS_DOMAIN:-}}"
  EMAIL="${EMAIL:-${TESLOS_EMAIL:-}}"
  echo "Reusing saved settings: $DOMAIN <$EMAIL>"
fi

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "Usage: sudo bash deploy/setup.sh tesla.example.com you@example.com" >&2
  echo "(after the first run both are remembered, so no arguments are needed)" >&2
  exit 1
fi

printf 'TESLOS_DOMAIN=%s\nTESLOS_EMAIL=%s\n' "$DOMAIN" "$EMAIL" > "$CONF"

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script targets Debian/Ubuntu. Follow the README manually instead." >&2
  exit 1
fi

step() { printf '\n=== %s\n' "$1"; }

# ---------------------------------------------------------------- packages
step "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ffmpeg nginx certbot python3-certbot-nginx

# Ubuntu LTS still ships a Node too old for this; NodeSource is the least
# surprising fix and leaves apt in charge of upgrades.
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$NODE_MAJOR" -ge 18 ]] && NEED_NODE=0
fi
if [[ "$NEED_NODE" -eq 1 ]]; then
  step "Installing Node.js 20"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
echo "node $(node --version)"

# The standalone binary avoids PEP 668 pip breakage and self-updates with
# `yt-dlp -U`, which matters because YouTube changes break it regularly.
step "Installing yt-dlp"
if ! command -v yt-dlp >/dev/null 2>&1; then
  curl -fsSL -o /usr/local/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
  chmod 0755 /usr/local/bin/yt-dlp
fi
echo "yt-dlp $(yt-dlp --version)"

# ---------------------------------------------------------------- app
step "Setting up $APP_DIR"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$APP_USER"

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "Expected the repo to already be cloned at $APP_DIR." >&2
  echo "Run: git clone -b claude/tesla-video-playback-7tkyzo https://github.com/renkliorjinal/teslos $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
[[ -f .env ]] || cp .env.example .env

# The cookie upload page is useless without a token and unsafe as an open
# endpoint, so mint one rather than leaving the choice to be forgotten.
if ! grep -q '^SETUP_TOKEN=' .env; then
  printf 'SETUP_TOKEN=%s\n' "$(head -c 18 /dev/urandom | base64 | tr -d '/+=')" >> .env
fi
SETUP_TOKEN_VALUE="$(grep '^SETUP_TOKEN=' .env | tail -1 | cut -d= -f2-)"

# So `npm run doctor` can print a working setup link rather than a placeholder.
sed -i '/^TESLOS_DOMAIN=/d' .env
printf 'TESLOS_DOMAIN=%s\n' "$DOMAIN" >> .env
# Nothing writable is created here on purpose: the unit runs the install
# read-only and keeps its state in /var/lib/teslos, which systemd creates.
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------------------------------------------------------------- nginx
step "Configuring nginx for $DOMAIN"

# Deliberately HTTP-only here. certbot's nginx plugin adds the TLS server
# block itself, copying these location blocks across; shipping cert paths for
# a certificate that does not exist yet would stop nginx from starting at all.
cat > /etc/nginx/sites-available/teslos <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # A long video is one long response. Do not let nginx cut it.
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;

    location / {
        proxy_pass         http://127.0.0.1:8742;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;

        # Without this nginx accumulates the transport stream and adds seconds
        # of latency that never drain.
        proxy_buffering    off;
        proxy_cache        off;
    }

    location /ws/ {
        proxy_pass         http://127.0.0.1:8742;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;

        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/teslos /etc/nginx/sites-enabled/teslos
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# DigitalOcean's 1-Click images ship with UFW closed to everything but SSH.
# Certbot proves control of the name over port 80, so a closed firewall looks
# exactly like a DNS mistake in the error output.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  step "Opening ports 80 and 443"
  ufw allow 80/tcp
  ufw allow 443/tcp
fi

# ---------------------------------------------------------------- service
step "Installing systemd service"
# Pin ExecStart to whichever node this box actually has, rather than trusting
# the unit's /usr/bin/node default.
NODE_BIN="$(command -v node)"
sed "s|^ExecStart=.*|ExecStart=$NODE_BIN server/index.js|" \
  deploy/teslos.service > /etc/systemd/system/teslos.service
systemctl daemon-reload
systemctl enable --now teslos
sleep 2
systemctl is-active --quiet teslos && echo "teslos is running" || {
  echo "teslos failed to start:" >&2
  journalctl -u teslos -n 30 --no-pager >&2
  exit 1
}

# ---------------------------------------------------------------- tls
step "Requesting a certificate for $DOMAIN"

# Check the name actually points here first. Certbot's failure for a
# misdirected record is a 404 on the challenge URL, which reads like a server
# bug rather than a DNS one and sends people looking in the wrong place.
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
RESOLVED="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)"
if [[ -n "$PUBLIC_IP" && -n "$RESOLVED" && "$PUBLIC_IP" != "$RESOLVED" ]]; then
  cat >&2 <<MISMATCH

  $DOMAIN resolves to $RESOLVED, but this droplet is $PUBLIC_IP.

  Point the A record at $PUBLIC_IP and re-run this script. If you created the
  subdomain through a hosting control panel, it most likely aimed the record at
  the hosting server by default.

MISMATCH
  exit 1
fi

if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  echo "Certificate already present, skipping."
else
  # --cert-name pins this request to its own lineage. Without it, certbot can
  # decide to fold the request into an unrelated certificate that already
  # exists on the box (a droplet reused from another project often has one
  # named after its IP) and then refuse over a key-type mismatch.
  certbot --nginx -d "$DOMAIN" --cert-name "$DOMAIN" \
    --non-interactive --agree-tos -m "$EMAIL" --redirect
fi

# ---------------------------------------------------------------- verify
step "Pre-flight check"
sudo -u "$APP_USER" env HOME=/tmp npm run --silent doctor || true

cat <<DONE

=== Done

  Open on the car's screen:  https://$DOMAIN/

  The player is on the bare hostname. /probe/ measures what this firmware
  allows; /setup/ takes a pasted YouTube cookie jar.

  YouTube sign-in:  https://$DOMAIN/setup/?k=$SETUP_TOKEN_VALUE
  Open that on a computer and pick the cookies.txt your browser extension made.

  Logs:     journalctl -u teslos -f
  Restart:  systemctl restart teslos

DONE
