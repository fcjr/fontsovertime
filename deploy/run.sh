#!/usr/bin/env bash
# Runs one scheduled job on the crawl server: weekly, daily or backfill.
set -euo pipefail

kind="${1:?usage: run.sh weekly|daily|backfill}"
case "$kind" in
  weekly | daily) dir="$HOME/crawl" ;;
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

git pull -q --rebase origin main
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
  backfill)
    nice -n 10 node pipeline/wayback.ts --redo-old --years "${BACKFILL_YEARS:-10}" --concurrency 3 --rpm "${BACKFILL_RPM:-30}" --max-rpm "${BACKFILL_MAX_RPM:-60}" --budget 350 --status data/runs/backfill-status.json
    paths=(data/snapshots/wayback data/runs/backfill-status.json)
    message="Wayback backfill $today"
    ;;
esac

git add "${paths[@]}"
if ! git diff --cached --quiet; then
  git commit -q -m "$message"
  for attempt in 1 2 3 4 5; do
    if git pull -q --rebase origin main && git push -q origin HEAD:main; then break; fi
    [ "$attempt" = 5 ] && exit 1
    sleep $((attempt * 20))
  done
fi
hc ""
