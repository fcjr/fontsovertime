#!/usr/bin/env bash
# Copies the crawl server's crawl/* branches onto main, accepting only new or changed data files.
set -euo pipefail

# Rebasing rewrites this file in the working tree, so bash must read all of it before running any.
{
url="https://x-access-token:$TOKEN@github.com/$GITHUB_REPOSITORY.git"
git config user.name fontsovertime-bot
git config user.email crawler@fontsovertime.com
git fetch -q origin 'refs/heads/crawl/*:refs/remotes/origin/crawl/*'
branches="$(git for-each-ref --sort=refname --format='%(refname:strip=3)' refs/remotes/origin/crawl/)"
[ -n "$branches" ] || { echo "nothing to promote"; exit 0; }

git checkout -q --detach origin/main
promoted=()
rejected=()
for b in $branches; do
  ref="origin/$b"
  if ! base="$(git merge-base origin/main "$ref")"; then
    rejected+=("$b: no history in common with main")
    continue
  fi
  outside="$(git diff --name-only --no-renames "$base" "$ref" | grep -v '^data/' || true)"
  deleted="$(git diff --name-only --no-renames --diff-filter=D "$base" "$ref")"
  special="$(git diff --raw --no-renames "$base" "$ref" | awk '$2 != "100644"')"
  merges="$(git rev-list --merges "$base..$ref")"
  if [ -n "$outside$deleted$special$merges" ]; then
    rejected+=("$b: changes something other than regular files under data/")
    continue
  fi
  before="$(git rev-parse HEAD)"
  # Leaves HEAD detached at the replayed commits; ones already on main are dropped.
  if ! git rebase -q --onto "$before" "$base" "$ref" >/dev/null 2>&1; then
    git rebase --abort 2>/dev/null || true
    git checkout -q --detach "$before"
    rejected+=("$b: conflicts with main")
    continue
  fi
  mapfile -t files < <(git diff --name-only "$before" HEAD)
  if [ "${#files[@]}" -gt 0 ] && ! node pipeline/check-data.ts "${files[@]}"; then
    git reset -q --hard "$before"
    rejected+=("$b: invalid data")
    continue
  fi
  promoted+=("$b")
  echo "promoting $b (${#files[@]} files)"
done

if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git push -q "$url" HEAD:refs/heads/main
fi
for b in "${promoted[@]}"; do git push -q "$url" --delete "$b"; done

for r in "${rejected[@]}"; do echo "::error::$r"; done
[ "${#rejected[@]}" -eq 0 ]
exit
}
