#!/usr/bin/env bash
# Gives the fixture goals that need extra state something to act on.
set -euo pipefail

quirky() { $REDESIGN_QUIRKY "$@"; }
fixture_dir="$(dirname "$REDESIGN_FIXTURE_JSON")"

# g9: a disposable worktree to delete
quirky worktree create ui-review-fixture spike-delete-me --no-parent

# g11: a worktree archived eight days ago, past the seven-day cleanup threshold
quirky worktree create harbor-api old-experiment --no-parent
archived_at=$(( ($(date +%s) - 8 * 86400) * 1000 ))
quirky api call quirky.worktree/archive --worktree name:old-experiment --archived-at "$archived_at"

# g10: a git repo that is not yet a project; its path is typed into Add project
new_repo="$fixture_dir/inbox-service"
git init -q -b main "$new_repo"
printf '# inbox-service\n' > "$new_repo/README.md"
git -C "$new_repo" add README.md
git -C "$new_repo" commit -qm "Initial commit"
printf '%s\n' "$new_repo" > "$fixture_dir/add-project-path.txt"
