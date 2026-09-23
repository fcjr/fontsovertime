#!/usr/bin/env bash
# One-time setup for the crawl server (Ubuntu 24.04, run as root). Safe to rerun.
set -euo pipefail

REPO="${REPO:-git@github.com:fcjr/fontsovertime.git}"
USER_NAME=crawler
HOME_DIR="/home/$USER_NAME"
PNPM_VERSION=10.28.0

if [ "$(id -u)" != 0 ]; then echo "run as root" >&2; exit 1; fi

apt-get update -q
apt-get install -y -q git curl ca-certificates jq

if ! command -v node >/dev/null || ! node -v | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi
npm install -g -s "pnpm@$PNPM_VERSION"

if [ ! -f /swapfile ]; then
  if fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    rm -f /swapfile
    echo "could not enable swap; continuing without it"
  fi
fi

id "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USER_NAME"
as_user() { runuser -u "$USER_NAME" -- bash -lc "$1"; }

as_user 'mkdir -p ~/.ssh && chmod 700 ~/.ssh
  [ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C "fontsovertime crawler" -f ~/.ssh/id_ed25519
  ssh-keyscan -q github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts'

if ! as_user "git ls-remote -q $REPO HEAD >/dev/null 2>&1"; then
  echo
  echo "Add this deploy key to the repository with write access"
  echo "(GitHub: Settings > Deploy keys > Add deploy key, tick 'Allow write access'), then rerun this script:"
  echo
  cat "$HOME_DIR/.ssh/id_ed25519.pub"
  exit 1
fi

for dir in crawl backfill; do
  as_user "[ -d ~/$dir/.git ] || git clone -q $REPO ~/$dir
    cd ~/$dir
    git config user.name fontsovertime-bot
    git config user.email crawler@fontsovertime.com
    pnpm install --frozen-lockfile --silent"
done

npx -y playwright@"$(as_user 'cd ~/crawl && node -p "require(\"playwright/package.json\").version"')" install-deps chromium
as_user 'cd ~/crawl && pnpm exec playwright install chromium'

if [ ! -f /etc/fontsovertime.env ]; then
  cat > /etc/fontsovertime.env <<'ENV'
# Residential proxy used only to retry sites that block the server, e.g.
# PROXY_URL=http://USER:PASSWORD@gate.example.com:7000
PROXY_URL=
# Skip the proxy for sites whose robots.txt disallows all crawlers (1 = yes).
PROXY_RESPECT_ROBOTS=1
# Stop using the proxy after this many megabytes in one run.
PROXY_MAX_MB=2000
CRAWL_CONCURRENCY=6
BACKFILL_RPM=30
# Optional healthchecks.io ping URLs.
HC_WEEKLY=
HC_DAILY=
HC_BACKFILL=
ENV
fi
chown root:"$USER_NAME" /etc/fontsovertime.env
chmod 640 /etc/fontsovertime.env

cp "$HOME_DIR/crawl/deploy/systemd/"* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fontsovertime-weekly.timer fontsovertime-daily.timer fontsovertime-backfill.timer

echo
echo "Done. Edit /etc/fontsovertime.env to add the proxy and health check URLs."
echo "Timers:"
systemctl list-timers 'fontsovertime-*' --no-pager
