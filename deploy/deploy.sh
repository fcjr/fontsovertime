#!/usr/bin/env bash
# Runs as root on the crawl server when GitHub Actions deploys (installed as
# /usr/local/sbin/fontsovertime-deploy; the deploy SSH key can run nothing else).
set -euo pipefail

exec 8>/run/fontsovertime-deploy.lock
flock 8

as_crawler() { runuser -u crawler -- bash -lc "$1"; }
echo "deploying ${SSH_ORIGINAL_COMMAND:-manually}"

as_crawler 'cd ~/release && git fetch -q origin main && git reset -q --hard origin/main'
release=/home/crawler/release
echo "release: $(as_crawler 'cd ~/release && git log -1 --format="%h %s"')"

for dir in crawl backfill; do
  result="$(as_crawler "exec 9>/tmp/fontsovertime-$dir.lock
    flock -n 9 || { echo busy; exit; }
    cd ~/$dir
    [ -z \"\$(git status --porcelain -- data)\" ] || { echo unsaved; exit; }
    git pull -q --rebase origin main && pnpm install --frozen-lockfile --silent && echo updated || echo failed")"
  case "$result" in
    *updated) echo "$dir: updated to $(as_crawler "cd ~/$dir && git rev-parse --short HEAD")" ;;
    *busy) echo "$dir: a job is running; it picks up the new code when it next starts" ;;
    *unsaved) echo "$dir: has data from an interrupted run; the next job saves it and updates" ;;
    *) echo "$dir: update failed" ;;
  esac
done

as_crawler 'cd ~/release && pnpm install --frozen-lockfile --silent && pnpm exec playwright install chromium >/dev/null'
if dpkg -s google-chrome-stable >/dev/null 2>&1; then
  apt-get install -y -q --only-upgrade google-chrome-stable >/dev/null
  echo "chrome: $(google-chrome-stable --version)"
fi

changed=0
for unit in "$release"/deploy/systemd/*; do
  target="/etc/systemd/system/$(basename "$unit")"
  if ! cmp -s "$unit" "$target"; then
    install -m 644 "$unit" "$target"
    changed=1
  fi
done
if [ "$changed" = 1 ]; then
  systemctl daemon-reload
  echo "systemd units updated"
fi
systemctl enable --now fontsovertime-weekly.timer fontsovertime-daily.timer fontsovertime-backfill.timer >/dev/null 2>&1

install -m 755 "$release/deploy/deploy.sh" /usr/local/sbin/fontsovertime-deploy
systemctl list-timers 'fontsovertime-*' --no-pager
