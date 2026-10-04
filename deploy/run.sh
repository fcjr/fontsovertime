#!/usr/bin/env bash
# Runs one scheduled job on the crawl server: weekly, daily, hn or backfill.
set -euo pipefail

kind="${1:?usage: run.sh weekly|daily|hn|backfill}"
case "$kind" in
  weekly | daily | hn) dir="$HOME/crawl" ;;
  backfill) dir="$HOME/backfill" ;;
  *) echo "unknown job: $kind" >&2; exit 2 ;;
esac
cd "$dir"

exec 9>"/tmp/fontsovertime-$(basename "$dir").lock"
if ! flock -n 9; then
  echo "another job is using $dir; skipping $kind"
  exit 0
fi

hc_var="HC_$(echo "$kind" | tr '[:lower:]' '[:upper:]')"
hc() { if [ -n "${!hc_var:-}" ]; then curl -fsS -m 10 --retry 3 "${!hc_var}$1" >/dev/null || true; fi; }
hc /start
trap 'hc /fail' ERR

# The server can't push to main. Each run goes to its own crawl/ branch, which promote-data.yml
# checks and copies onto main. Data that fails to push stays uncommitted for the next run to retry.
push_data() {
  git commit -q -m "$1"
  local branch
  branch="crawl/$(date -u +%Y%m%dT%H%M%SZ)-$kind"
  for attempt in 1 2 3 4 5; do
    git push -q origin "HEAD:refs/heads/$branch" && return 0
    sleep $((attempt * 20))
  done
  git reset -q --soft HEAD~1
  return 1
}

# A stopped job may have left data behind; send it on before resetting to main.
if [ -n "$(git status --porcelain -- data)" ]; then
  git add data
  push_data "Save data from an interrupted $kind run"
fi
git fetch -q origin main
git reset -q --hard origin/main
pnpm install --frozen-lockfile --silent

today="$(date -u +%F)"
case "$kind" in
  weekly)
    node crawler/crawl.ts sites --out out/weekly.jsonl --concurrency "${CRAWL_CONCURRENCY:-6}"
    node pipeline/merge.ts --kind weekly out/weekly.jsonl
    node pipeline/aggregate.ts
    mkdir -p data/runs && cp out/weekly.summary.json "data/runs/weekly-$today.json"
    paths=(data/snapshots/weekly data/exports data/runs)
    message="Crawl: weekly $today"
    ;;
  daily)
    node crawler/crawl.ts sites --only sites/marquee.txt --out out/daily.jsonl --concurrency 4
    node pipeline/merge.ts --kind daily out/daily.jsonl
    node pipeline/aggregate.ts
    mkdir -p data/runs && cp out/daily.summary.json "data/runs/daily-$today.json"
    paths=(data/snapshots/daily data/exports data/runs)
    message="Crawl: daily $today"
    ;;
  hn)
    week="$(node pipeline/hn.ts --out out/hn-list.json)"
    node crawler/crawl.ts --list out/hn-list.json --out out/hn.jsonl --concurrency "${CRAWL_CONCURRENCY:-6}"
    node pipeline/merge.ts --kind hn --id "$week" out/hn.jsonl
    node pipeline/aggregate.ts
    mkdir -p data/runs && cp out/hn.summary.json "data/runs/hn-$week.json"
    paths=(data/snapshots/hn data/exports data/runs)
    message="Crawl: Hacker News $week"
    ;;
  backfill)
    nice -n 10 node pipeline/wayback.ts --redo-old --years "${BACKFILL_YEARS:-10}" --concurrency 3 --rpm "${BACKFILL_RPM:-15}" --max-rpm "${BACKFILL_MAX_RPM:-30}" --budget 350 --status data/runs/backfill-status.json
    paths=(data/snapshots/wayback data/runs/backfill-status.json)
    message="Wayback backfill $today"
    ;;
esac

git add "${paths[@]}"
git diff --cached --quiet || push_data "$message"
hc ""
