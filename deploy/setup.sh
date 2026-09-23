#!/usr/bin/env bash
# One-time setup for the crawl server (Ubuntu 24.04 or newer, run as root). Safe to rerun.
# DEPLOY_PUBKEY: public key GitHub Actions uses to deploy; it can only run the deploy script.
set -euo pipefail

REPO="${REPO:-git@github.com:fcjr/fontsovertime.git}"
USER_NAME=crawler
HOME_DIR="/home/$USER_NAME"
PNPM_VERSION=10.28.0

if [ "$(id -u)" != 0 ]; then echo "run as root" >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q git curl ca-certificates jq xz-utils gnupg

if ! command -v node >/dev/null || ! node -v | grep -qE '^v2[4-9]'; then
  if ! { curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y -q nodejs; }; then
    arch="$(dpkg --print-architecture | sed 's/amd64/x64/')"
    version="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.version | startswith("v24."))][0].version')"
    curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-$arch.tar.xz" | tar -xJ -C /usr/local --strip-components=1
  fi
fi
npm install -g -s "pnpm@$PNPM_VERSION"

# Genuine Google Chrome where it exists (x86-64); Playwright's Chromium otherwise.
channel=chromium
if [ "$(dpkg --print-architecture)" = amd64 ]; then
  if ! dpkg -s google-chrome-stable >/dev/null 2>&1; then
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /usr/share/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
    apt-get update -q
    apt-get install -y -q google-chrome-stable
  fi
  channel=chrome
fi

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

for dir in crawl backfill release; do
  as_user "[ -d ~/$dir/.git ] || git clone -q $REPO ~/$dir
    cd ~/$dir
    git config user.name fontsovertime-bot
    git config user.email crawler@fontsovertime.com
    pnpm install --frozen-lockfile --silent"
done

as_user 'cd ~/release && pnpm exec playwright install chromium >/dev/null'
if [ "$channel" = chromium ]; then
  playwright_version="$(as_user 'cd ~/release && node -p "require(\"playwright/package.json\").version"')"
  npx -y "playwright@$playwright_version" install-deps chromium || echo "playwright install-deps failed; Chromium may be missing system libraries"
fi

cores="$(nproc)"
mem_gb="$(awk '/MemTotal/ {print int($2 / 1048576)}' /proc/meminfo)"
concurrency=$((cores * 2 < mem_gb - 1 ? cores * 2 : mem_gb - 1))
[ "$concurrency" -lt 2 ] && concurrency=2

if [ ! -f /etc/fontsovertime.env ]; then
  cat > /etc/fontsovertime.env <<ENV
# Browser: chrome (Google Chrome, x86-64 only) or chromium.
BROWSER_CHANNEL=$channel
# Parallel browsers for the weekly crawl; sized from $cores cores and ${mem_gb} GB RAM.
CRAWL_CONCURRENCY=$concurrency
# Residential proxy used only to retry sites that block the server. {session} is replaced per site
# for providers that keep one exit IP per session, e.g.
# PROXY_URL=http://USER-session-{session}:PASSWORD@gate.example.com:7000
PROXY_URL=
# Skip the proxy for sites whose robots.txt disallows all crawlers (1 = yes).
PROXY_RESPECT_ROBOTS=1
# Stop using the proxy after this many megabytes in one run.
PROXY_MAX_MB=2000
# Internet Archive request rate: start, and ceiling it may climb to while there are no 429s.
BACKFILL_RPM=15
BACKFILL_MAX_RPM=30
# How far back the archive backfill goes.
BACKFILL_YEARS=10
# Optional healthchecks.io ping URLs.
HC_WEEKLY=
HC_DAILY=
HC_BACKFILL=
ENV
fi
chown root:"$USER_NAME" /etc/fontsovertime.env
chmod 640 /etc/fontsovertime.env

# Deploy access for GitHub Actions: a user whose key can only run the deploy script.
install -m 755 "$HOME_DIR/release/deploy/deploy.sh" /usr/local/sbin/fontsovertime-deploy
id deploy >/dev/null 2>&1 || useradd -m -s /bin/sh deploy
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/fontsovertime-deploy' > /etc/sudoers.d/fontsovertime-deploy
chmod 440 /etc/sudoers.d/fontsovertime-deploy
visudo -cq
if [ -n "${DEPLOY_PUBKEY:-}" ]; then
  install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
  echo "restrict,command=\"sudo -n /usr/local/sbin/fontsovertime-deploy\" $DEPLOY_PUBKEY" > /home/deploy/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys
  chmod 600 /home/deploy/.ssh/authorized_keys
fi

cp "$HOME_DIR/release/deploy/systemd/"* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fontsovertime-weekly.timer fontsovertime-daily.timer fontsovertime-backfill.timer

echo
echo "Done. Settings live in /etc/fontsovertime.env."
systemctl list-timers 'fontsovertime-*' --no-pager
