# Source Control AI recipes

The Git plugin stores independent recipes for commit messages, fix/review actions, branch names, and conversation names. `aiRecipe` resolves each field from the repository recipe, then the global recipe, then the default, and reports each field's source. `setAiRecipe` saves or resets a recipe at repository or global scope.

## Name candidates

`aiName({ action: 'branchName' })` returns a branch-name candidate from the exact worktree's checked-out branch, resolved base comparison, committed changed paths, and staged/unstaged paths. An optional `session` adds user/assistant messages from that exact structured session as captured work-prompt context. The returned branch name must pass Git's `check-ref-format --branch` validation.

`aiName({ action: 'conversationName', session })` requires an exact structured session in the selected worktree. It reads the captured user/assistant messages through the public structured-session API and returns a bounded title candidate.

Both actions use their own `branchName` or `conversationName` recipe. The one-shot generator must support the selected provider. Raw provider arguments are passed through the one-shot resolver, so singleton flags in raw arguments take precedence over structured model/option picks, which take precedence over inherited picks. `providerSource` identifies the provider plugin and recipe/request source for the chosen launch settings.

Names are drafts only. Generating a candidate does not create or rename a Git branch, rename a conversation, or otherwise mutate either owner. A failed generation leaves the UI's current candidate draft intact. The generated CLI method is `orca git aiName --action branchName` or `orca git aiName --action conversationName --session <session-id>`; add `--json` for the full provenance result.

## Provider model snapshots

`quirky.agents/options` and `discoverModels` take an exact host identity. `local` means the current runtime; a paired host is its saved peer ID. The Source Control settings and automation editor target their captured local owner explicitly. A successful nonempty provider snapshot retires only structured model picks tagged for that provider on that host; valid options common to the refreshed default catalog are retained. Empty, malformed, unavailable, or unsupported probes do not retire picks. Raw CLI arguments are not rewritten by model snapshot retirement.
