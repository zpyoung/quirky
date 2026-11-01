# m2-source-control-core tech spec

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Decisions:
[m2-source-control-core.md](../../../loop/decisions/m2-source-control-core.md).

Paths are relative to the repo root. `QG/` = `plugins/quirky.git/`, `PG/` = `packages/git/src/`.

## Architecture

Three layers, each with one job ([logic: Data flow](logic.md#data-flow)):

1. **`@quirky/git` (`PG/`)** spawns git and parses its output. It knows nothing about worktree
   selectors, plugins or RPC. New modules: `status.ts`, `upstream.ts`, `remote.ts`,
   `remote-error.ts`, `failure.ts`, `discard.ts`, `compare.ts`, `history.ts`, `diffs.ts`,
   `conflicts.ts`, `huge.ts`, all re-exported from `PG/index.ts` so `gitApi()` and `FakeGit`
   (`PG/testing.ts`, which spreads the real module) see them.
2. **The daemon half of `quirky.git`** (`QG/main.ts` plus a new `QG/src/daemon/`) resolves the
   worktree (`quirky.worktree/resolve`), takes the per-worktree lock, calls `@quirky/git`, turns
   failures into reasoned plugin errors, emits `quirky.git/changed`, and owns the effective base and
   the opened-conflict set.
3. **The window half** (`QG/src/`, bundled to `QG/dist/ui.js` by `packages/ui/build.ts`) provides
   the `panel:quirky.git/source-control` panel, the `view:quirky.git/diff` view and the commands.
   Pure decision modules (ladder, menu, messages, sections, tree, selection, filter) are separate
   files with their own tests; React components only render them.

Libraries: `@codemirror/merge` (`MergeView`, `unifiedMergeView`, `goToNextChunk`,
`goToPreviousChunk`), `@codemirror/view` decorations for conflict markers, React 19 from the shell
(external in the bundle).

Small kernel growths this item needs (the API is unstable until M7, roadmap "Plugin API growth"):
- `UiPluginContext.setPanelBadge(panelId, count, title?)` gains an optional tooltip
  (`packages/protocol/src/ui.ts:208`, `packages/ui/src/plugins/host.ts:691`,
  `packages/ui/src/plugins/PanelToggles.tsx:20`, which today hard-codes "`N waiting`" and keeps it
  as the default).
- The CLI's `--json` error document gains `data` beside `reason` (`packages/cli/src/main.ts`
  ~125-190, `errorReason` ~154), so commit and push failure summaries reach scripts
  ([D38](../../../loop/decisions/m2-source-control-core.md)).
- `quirky.worktree/set` gains `baseRef` ([D20](../../../loop/decisions/m2-source-control-core.md)).

## Code references

### Protocol (`packages/protocol/src/model.ts:189-217`)
Extend `GitStatus` and `GitDiff` additively; add the types in [Data models](#data-models). Keep
`GitFileStatus` and every v1 field unchanged: `plugins/quirky.worktree/src/DeleteDialog.tsx:20`
reads `files`.

### `@quirky/git`
- `PG/run.ts:12-17` `runGit(cwd, args, {timeoutMs?})`: add to the env `GIT_SSH_COMMAND`
  (`ssh -o BatchMode=yes`) unless the caller's env has `GIT_SSH_COMMAND` or `core.sshCommand` is
  how the user configured ssh, `GIT_ASKPASS=''`, `SSH_ASKPASS=''`, and `GIT_OPTIONAL_LOCKS=0` for
  reads (an option, `readOnly?: true`). Add an `input?: Uint8Array` option for
  `--pathspec-from-file=-`. Keep "never throws on non-zero exit".
- `PG/run.ts` `git(cwd, args)`: add an optional options argument passed through to `runGit`.
- `PG/index.ts` `status` (v1, porcelain v1) stays for `files`; the new `statusV2` builds the full
  snapshot and also fills `files` from the same porcelain-v2 records, so one git process serves
  both. `diff` (v1) delegates to `diffs.ts` with source `staged`/`unstaged`.
- `PG/ops.ts:134` `fetchRemote` stays as is (m1-worktrees' base fetch uses it); remote operations
  get their own functions in `remote.ts` that report why they failed.
- `PG/ops.ts` `detectDefaultBase`, `resolveBaseRef`, `listRemotes`, `upstreamOf`, `getConfig`
  are reused by `compare.ts`, `upstream.ts` and `remote.ts`.

### `quirky.git` daemon
- `QG/main.ts`: today 85 lines registering five methods through `inWorktree`. It becomes the
  registration table; handlers move to `QG/src/daemon/methods.ts`. Keep `resolve`'s folder refusal
  text and `data.reason: 'folder-workspace'` exactly (`QG/main.ts:24-31`; m1-worktrees, D37).
- `QG/src/daemon/lock.ts`: per-worktree-id lock (in memory) for `GitBusyOp`.
- `QG/src/daemon/opened.ts`: per-worktree-id set of conflict paths read through `conflictFile`,
  tagged with the operation and its head (`MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` oid) so a
  new operation starts empty.
- `QG/src/daemon/base.ts`: effective base and `setBase`, calling `quirky.worktree/resolve`,
  `quirky.repo/show` and `quirky.repo/set`, `quirky.worktree/set`.
- `QG/src/daemon/errors.ts`: `reasoned(kind, reason, message, extra?)` built on
  `context.error` + `Object.assign(…, {data})` (pattern: `plugins/quirky.worktree/main.ts:63-64`).
- `QG/src/shared/discard-text.ts`: Orca's discard dialog text, imported by both the daemon's
  `describeDiscard` and the window's dialog so the ask and the dialog can't differ.
- `QG/quirky-plugin.json`: new methods, `describe*` methods, commands, keybindings, settings and
  the `diff` view. Method ids are camelCase like the rest of the repo (`deleteBranch`).

### `quirky.worktree` and `quirky.repo`
- `plugins/quirky.worktree/src/daemon/set.ts:17-26,51-56`: `SetParams.baseRef?: string | null`;
  `assign('base_ref', …)`, with `null` or `''` clearing. Manifest `set` params
  (`plugins/quirky.worktree/quirky-plugin.json:413-454`) gain `"baseRef": {"description": …}` with
  no `type` (the schema subset has no unions, `packages/protocol/src/schema.ts:200`); the handler
  checks string-or-null. No CLI flag is added to `wt set`.
- `quirky.repo/show` (`plugins/quirky.repo/src/settings.ts` ~40-46) returns
  `RepoDetails.settings.defaultBase` and `RepoDetails.hooks.sharedDirectories`
  (`packages/protocol/src/model.ts:70-93`); `quirky.repo/set {repo, defaultBase}` with `''`
  clearing (`settings.ts` ~65-80). Both are used unchanged.

### Window
- `QG/src/ui.tsx`: provides the panel, the view and every command.
- `QG/src/SourceControl.tsx` (179 lines today) is split into `QG/src/panel/` components; v1's
  in-panel diff (`scm-diff`, `DiffView`) is removed because diffs open in the view
  ([D23](../../../loop/decisions/m2-source-control-core.md)).
- `QG/src/DiffView.tsx` becomes `QG/src/view/merge.ts` (shared CodeMirror setup) plus the view
  components; `QG/src/language.ts`, `QG/src/diffText.ts` and `QG/src/diffRefresh.ts` are kept
  (the last for the view's poll).
- `packages/ui/src/styles.css:574-703` holds the `.scm*`, `.file-group`, `.commit-box` and
  `.diff-host` rules; all new classes go there, using only the theme tokens of
  `useThemeVariables.ts` (`--bg --bg-raised --bg-hover --bg-active --border --text --muted
  --accent --amber --green --grey --dim --danger`). Status-letter colours are new `--git-*`
  variables defined in `styles.css` with Orca's light and dark values.
- Dialogs are the plugin's own (a copy of `plugins/quirky.worktree/src/Dialog.tsx`, which stacks
  Escape) because `context.confirm` can't style a destructive button
  (`packages/ui/src/components/ConfirmHost.tsx` ~28 drops `danger`).

## Contracts & interfaces

Every method below takes `worktree?: string` (selector; default the caller's), resolves it as
`QG/main.ts:18-31` does, and refuses folder workspaces with the m1-worktrees refusal. Every
mutation emits `quirky.git/changed {worktreeId}` once on success and never on failure. Every git
failure that isn't given a reason below is `failed`, with git's stderr as the message
([logic: SC-* by section](logic.md#behavior--scenarios)).

### Errors
`CONTRACT:` plugin errors use `context.error(kind)` codes: `invalid-params` (-32602),
`not-found` (-32004), `conflict` (-32009). `data.reason` is one of:

| reason | kind | when |
|---|---|---|
| `folder-workspace` | invalid-params | unchanged from v1 |
| `busy` | conflict | another locked operation runs in the worktree (SC-30) |
| `non-fast-forward`, `stale-lease`, `auth`, `network`, `no-upstream`, `detached`, `divergent-policy`, `local-changes`, `untracked-overwrite`, `conflicts`, `hook`, `lint`, `failed` | conflict | remote, commit, continue (D18, D19) |
| `not-stageable`, `not-discardable`, `outside-worktree`, `invalid-base`, `not-allowed` | invalid-params | eligibility (SC-13, SC-22, SC-39, SC-59) |
| `changed-on-disk` | conflict | `save` precondition failed (SC-61) |
| `nothing-to-continue`, `unresolved` | conflict | `continue` (SC-42) |

`hook`/`lint` errors also carry `data.summary` and `data.output` (output capped at 64 KiB, ANSI
stripped). Every message and `data` field passes through `redactCredentials` (`remote-error.ts`),
which rewrites `scheme://user:pass@` and `scheme://token@` to `scheme://***@` (SC-37).

### Locking
`CONTRACT:` `withLock(worktreeId, op: GitBusyOp, run)` — rejects at once with
`conflict`/`busy` and message `A <op label> is already running in this worktree.` (labels:
push, force push, pull, fast-forward, fetch, sync, rebase, continue, abort) when the worktree
holds a lock; releases in `finally`. `status` reports the held op as `busy` without waiting. The
lock covers `push`, `forcePush`, `pull`, `fastForward`, `fetch`, `sync`, `rebaseFromBase`,
`continue` and `abort`; stage, unstage, discard, commit and save don't take it.

### Status (`statusV2`)
- `COMMAND:` `git -c core.quotePath=false status --porcelain=v2 -z --branch --untracked-files=all`
  with `GIT_OPTIONAL_LOCKS=0`; stdout is parsed incrementally and the process killed once more
  than `limit` (1,000) entries have been read; `capped` is then true.
- Records `1`/`2`: a staged entry when X ≠ `.`, an unstaged entry when Y ≠ `.`; `T` maps to
  `modified`; `2` gives `oldPath`. `?` untracked. `u` → area `conflicts`, `conflict.state`
  `unresolved`, kind by the table in [logic SC-3](logic.md#status-and-sections); submodule
  conflicts are skipped (Orca). Submodule field `S<c><m><u>` → `submodule` flags. `# branch.oid`
  (`(initial)` → unborn), `# branch.head` (`(detached)` → detached), `# branch.upstream`,
  `# branch.ab`. Unknown `#` headers are ignored.
- `files` (v1) is derived from the same records with v1's letters.
- Line counts (skipped when capped): `COMMAND:` `git -c core.quotePath=false -c diff.autoRefreshIndex=false diff -z --numstat -M [--cached]`;
  untracked files count `\n` bytes (+1 without a trailing newline) for regular files ≤ 2 MiB with
  no NUL in the first 8 KiB; symlinks count 1; others none.
- Operation: from `git rev-parse --absolute-git-dir` (cached per path): `rebase-merge/` or
  `rebase-apply/` → rebase, `MERGE_HEAD` → merge, `CHERRY_PICK_HEAD` → cherry-pick, else none.
  No other git process.
- Resolved locally: the daemon adds `conflicts`-area entries with `state: 'resolved_locally'` for
  paths in `opened.ts` whose operation and head still match and that porcelain no longer lists as
  `u`; such a path also keeps its normal staged/unstaged entry. A capped status never clears the
  opened set.
- Shared symlinks: untracked entries whose path is one of `RepoDetails.hooks.sharedDirectories`
  and is a symlink on disk are dropped, and `stage` scope `all` excludes them (SC-6).
- Upstream: `upstream.ts` `effectiveUpstream(cwd, branch, porcelainUpstream)` — porcelain's when
  present and named `<remote>/<branch>`; else `rev-parse --abbrev-ref <branch>@{upstream}`; else
  `refs/remotes/<remote>/<branch>` for `branch.<b>.remote` or `origin`. `sha` is
  `rev-parse <upstream>`. Counts: `rev-list --left-right --count HEAD...<upstream>`.
  `behindPatchEquivalent` only when ahead > 0 and behind > 0: `COMMAND:` `git log --no-show-signature --no-color --oneline --cherry-mark --right-only HEAD...<upstream> --`,
  true when every line starts with `=`. Skipped when capped (null).

### Staging and discard
- `stage {paths?, scope?: 'all' | 'tracked'}`: exactly one of `paths` (non-empty) or `scope`.
  Paths are refused (`not-stageable`) if any is a submodule root ("Stage inside submodule") or an
  unresolved conflict whose working file still holds a conflict marker line (`^<<<<<<< `,
  `^=======$`, `^>>>>>>> ` or `^||||||| `, checked with `conflictBlocks` from
  `QG/src/view/conflict-markers.ts`; message "Resolve the conflict markers in <path> before staging
  it."). An unresolved conflict with no markers is staged with `add`; one whose working file is
  missing is staged as a deletion (`rm --cached --quiet -- :(literal)<p>`). Binary conflicts with
  no text markers stage as they are.
  Paths go as NUL-joined `:(literal)<p>` on stdin to `add --pathspec-from-file=- --pathspec-file-nul`.
  Scope as Orca's `S/git-stage-worktree-scope.ts` (`add --all -- .` / `add --update -- .`, or the
  per-file path when unmerged paths exist), excluding shared symlinks.
- `unstage {paths}` as v1 (`restore --staged`, `rm --cached` on an unborn HEAD). The daemon reads
  the staged entries first and adds the `oldPath` of every staged rename whose new path was given,
  so every caller resets both sides (SC-12).
- `discard {paths?, area?: 'staged' | 'unstaged' | 'untracked'}`, destructive, `describe:
  describeDiscard`: exactly one of `paths` or `area`. Every path is checked to resolve inside the
  worktree (`outside-worktree`), and refused when an unresolved or resolved-locally conflict or a
  submodule root (`not-discardable`). `area: 'staged'` unstages every staged path (renames with
  both paths) then discards them; staged additions are deleted. Tracked paths:
  `restore --worktree --pathspec-from-file=- --pathspec-file-nul` (a deleted tracked file is
  restored from the index); untracked: `clean -ffdx -- <paths>` per chunk. Per-path failures are
  collected; the call fails with `failed`, message `Failed to discard N file(s)` and
  `data.failures: [{path, message}]` when any failed, after discarding the rest.
- `describeDiscard` returns `<Title> <Body>` from `QG/src/shared/discard-text.ts`, whose cases
  match the [logic SC-23](logic.md#discarding) table exactly.

### Commit
- `commit {message}` (v1) — trimmed empty → `invalid-params` "Commit message is required". Hooks
  run. On failure, `failure.ts` `classifyCommitFailure(output)`: strip ANSI and control
  characters, scan the first 64 KiB; `/\b(eslint|oxlint|lint-staged|lint)\b/i` → `lint`
  "Lint failed during commit."; `/\b(pre-commit|precommit|husky|lint-staged)\b/i` → `hook`
  "Pre-commit hook failed."; else `failed` with the first meaningful line (dropping npm
  warn/notice and husky deprecation lines when a signal line exists), fallback "Commit failed.".
  The error message is the summary.

### Remote operations (`remote.ts`, `remote-error.ts`)
Network calls run with `timeoutMs: 120_000`; a timeout is `network`. Every one first refuses a
detached HEAD (`detached`, "Check out a branch first.").

- `pushTarget(cwd, branch)`: remote = `branch.<b>.pushRemote` ?? `remote.pushDefault` ??
  `branch.<b>.remote` ?? `origin`; destination branch = the upstream's branch name when the
  upstream is on that remote, else `<b>`.
- `push {}` → `COMMAND:` `git push --set-upstream <remote> HEAD:refs/heads/<dest>`. Result
  `{remote, branch, upstream}`.
- `forcePush {expected?: string}`, destructive, `describe: describeForcePush` ("Force push <b> to
  <remote>? This replaces the remote branch with your local commits.") →
  `COMMAND:` `git push --set-upstream --force-with-lease=refs/heads/<dest>:<expected> <remote> HEAD:refs/heads/<dest>`
  where `expected` is the param (40-hex, else `invalid-params`) or the remote-tracking ref's sha
  read without fetching; with no remote-tracking ref the lease is `refs/heads/<dest>:` (expect
  absent). A "stale info" rejection → `stale-lease`.
- `pull {}` → `git pull`; on the divergent-policy error retry `git pull --no-rebase`. No upstream →
  `no-upstream` before running git.
- `fastForward {}` → `git pull --ff-only`, no retry; failure message "Fast-forward failed. <detail>"
  (detail ≤ 200 chars).
- `fetch {}` → `git fetch --prune`.
- `sync {}` → one lock for: fetch; recompute upstream; if `ahead > 0 && behind > 0 &&
  behindPatchEquivalent` force-push with `expected` = the just-read upstream sha; else if
  behind > 0 pull (as above); recompute; push if ahead > 0. Result `{steps: string[]}` (e.g.
  `['fetch','pull','push']`).
- `rebaseFromBase {base?}`: base = param ?? effective base (never the upstream); must be
  `<remote>/<branch>` with `<remote>` in `git remote` and a valid branch name
  (`check-ref-format --branch`), else `invalid-base` "Rebase needs a remote base branch (like
  origin/main).". Steps as Orca's `M/git/remote-rebase.ts`: fork point
  `merge-base --fork-point refs/remotes/<r>/<b> HEAD` (may be empty); `fetch --no-write-fetch-head
  <r> +refs/heads/<b>:refs/quirky/rebase/<uuid> +refs/heads/<b>:refs/remotes/<r>/<b>`; `rebase
  --onto <tmp> <forkPoint>` or `rebase <tmp>`, or `merge --ff-only <tmp>` on an unborn HEAD;
  always `update-ref -d <tmp>` in `finally`. A stop on conflicts → `conflicts`.
- `normalizeRemoteError(action, stderr, stdout)` → `{reason, message}` following Orca's
  `S/git-remote-error.ts` order: credentials stripped; submodule push detail; non-fast-forward
  ("Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.");
  stale lease; pre-push hook (`isPushHookFailure`, which excludes auth, non-fast-forward,
  protected branch, network and submodule errors) → `hook`/`lint` with
  `classifyPushFailure` summaries ("Pre-push hook failed.", "Lint failed during push.", "Push
  failed."); auth (`Authentication failed`, `Permission denied`, `could not read Username`,
  `Host key verification failed`) → "Authentication failed. Check your remote credentials.";
  network (`Could not resolve host`, `Connection refused`, `Connection timed out`, `unable to
  access`, `Network is unreachable`) → "Network error. Check your connection."; no upstream →
  "Branch has no upstream. Publish the branch first."; divergent policy; local changes ("Pull
  would overwrite local changes. Commit, stash, or discard them before pulling."); untracked
  overwrite ("Pull would overwrite untracked files. Move, remove, or add them before pulling.");
  merge or rebase conflicts → `conflicts`; else the last `fatal:`/`error:` block, `failed`.

### Conflicts (`conflicts.ts`)
- `conflictFile {path}` → `{path, kind, state, content: string | null, hash: string | null,
  operation}`; content is the working file (null when missing; binary → refused
  `not-allowed`). Records the path in `opened.ts` for the current operation.
  The panel tracks `not-allowed` reads separately from readable marker-free files and allows
  row and bulk Stage for those unreadable modify/delete conflicts.
- `acceptConflictDeletion {path, expected: string | null}` → `{ok: true}`: only a live unresolved
  modify/delete conflict is eligible. Within the same absolute-path queue as `save`, recheck
  containment, refuse submodules/directories, compare the working-file hash with `expected`,
  unlink the file if present, then stage the path. A mismatched hash returns `changed-on-disk`;
  only a successful mutation emits `changed`.
- `continue {}`: no operation → `nothing-to-continue` "Nothing to continue."; any unresolved
  entry → `unresolved` "Resolve every conflict before continuing.". Then
  `COMMAND:` `GIT_EDITOR=true git -c core.editor=true <merge|rebase|cherry-pick> --continue`
  (rebase also `GIT_SEQUENCE_EDITOR=true`). Result `{finished: boolean, operation}`; a rebase or
  cherry-pick that stops again returns `finished: false` (not an error). A hook failure during a
  merge commit is classified like `commit`.
- `abort {}`, destructive, `describe: describeAbort` → "Abort merge? This cancels the merge in
  progress and can discard conflict resolutions made during this merge." (merge→rebase for a
  rebase); a cherry-pick or no operation → `nothing-to-continue`-style refusal `not-allowed`
  "Nothing to abort.". `git merge --abort` / `git rebase --abort`. Clears the opened set.

### Compare, base and history
- `effectiveBase(worktree)`: `Worktree.baseRef` (source `worktree`) ?? `RepoDetails.settings.defaultBase`
  (`project`) ?? `detectDefaultBase(repoPath)` (`detected`) ?? none. With setting
  `compareBase = 'branch-upstream'`, compare uses the worktree's own `baseRef` when it has one, else
  the upstream when there is one (`upstream`), else the project and detected bases as above
  (Orca's `use-base-refs.ts`); `rebaseFromBase` never uses the upstream.
- `compare {base?}` → `GitCompare` ([Data models](#data-models)): `rev-parse --verify --quiet
  --end-of-options <base>^{commit}` (missing → `invalid-base`, message per logic SC-48); unborn
  HEAD → `unborn-head`; `merge-base <baseOid> <headOid>` empty → `no-merge-base`; counts
  `rev-list --left-right --count <baseOid>...<headOid>`; entries from `COMMAND:`
  `git diff --raw --numstat -z -M -C <mergeBase> <headOid> --`; totals summed from numstat
  (binary counts nothing). Not-ready statuses are results, not errors.
- `setBase {base?, clear?}` → exactly one; validates `base` resolves to a commit (`invalid-base`);
  writes `quirky.worktree/set {worktree, baseRef}` when the worktree has a `baseRef`, else
  `quirky.repo/set {repo, defaultBase}` (`''` to clear). Result `{target: 'worktree' | 'project',
  base: string | null}`. Emits `quirky.git/changed`.
- `branches {query?}` → `{refs: {name, kind: 'local' | 'remote'}[], current: string | null}` from
  `for-each-ref --format=%(refname) refs/heads refs/remotes` (dropping `*/HEAD`), case-insensitive
  substring filter, sorted locals first then by name, at most 200.
- `history {limit?}` → `limit` default 50, clamped to [1, 200]; `log --no-show-signature
  --no-color --topo-order --decorate=full -z -n<limit+1> --format=<fields> HEAD`; `hasMore` when
  limit+1 came back. Unborn HEAD → `{commits: [], hasMore: false}`. Times in ms. Refs shortened
  (`refs/heads/`, `refs/remotes/`, `refs/tags/` → `tag: `), `HEAD -> <b>` kept.
- `commitFiles {commit}` → `{commit, parent, entries}`; `commit` must resolve to a commit; the
  first parent's diff as compare's, root commits via `diff-tree --root --no-commit-id -r --raw
  --numstat -z -M -C <oid> --`.

### Diff content (`diffs.ts`)
- `diff {path, source?, staged?, oldPath?, mergeBase?, head?, commit?, parent?}`: `source`
  defaults to `staged ? 'staged' : 'unstaged'`. Sides (Orca's `file-diff.ts` table):
  staged `HEAD:<p>` → `:<p>`; unstaged `:<p>` (else `HEAD:<p>`) → working file; untracked empty →
  working file; branch `<mergeBase>:<oldPath ?? p>` → `<head>:<p>` (oids default to the current
  compare's); commit `<parent>:<oldPath ?? p>` (empty for a root) → `<commit>:<p>`. Oids must be
  40-hex (`invalid-params`).
- Blob reads: `git show --end-of-options <spec>` with a 10 MiB stdout cap (kill past it →
  binary). A missing blob (`does not exist`, `exists on disk, but not in`, `invalid object name`
  for the path) is an empty side; any other git failure **throws** with git's message (SC-57).
- Kind: an image extension (`.png .jpg .jpeg .gif .svg .webp .bmp .ico .pdf`) → `image` with
  base64 sides and a mime type; else NUL in either side or a side over 10 MiB → `binary`; else
  `text`. Render limit for text: `original.length + modified.length > 6_000_000` → `tooLarge`
  reason `characters`; else either side over 120,000 lines → reason `lines`; bodies then empty.
- Unstaged results carry `modifiedHash` = sha-256 hex of the working file's bytes (null when
  missing); a missing working file sets `modifiedDeleted`.
- `save {path, content, expected?}`: path inside the worktree (`outside-worktree`); with
  `expected`, refuse `changed-on-disk` when the file's current sha-256 differs (a missing file
  hashes as null); write atomically (temp file in the same folder, rename); result `{hash}`.
  Emits `quirky.git/changed`.

### Huge repos and misc
- `hugeFolders {}` → `{folders}`: of `node_modules .next dist build target vendor`, those that are
  directories at the worktree root and not ignored (`check-ignore`).
- `ignoreFolder {folder}` → only those six names (`not-allowed` otherwise); appends `<folder>/`
  on its own line to `<worktree>/.gitignore` (adding a newline first if the file doesn't end with
  one); idempotent.
- `submoduleStatus {path}` → `statusV2` run inside `<worktree>/<path>` (must be a submodule
  entry of the worktree's status), entries only.
- `reveal {path}` → `open -R <absolute>` (macOS, D34); path inside the worktree.

### Window: panel
- Status hook: polls `quirky.git/status` every 3,000 ms while mounted, plus on
  `quirky.git/changed` for its worktree id, and after each action; identical results don't
  re-render (`QG/src/diffRefresh.ts` pattern). Compare hook: on mount, every 30,000 ms, when
  `status.head` or the upstream sha changes, after any action, and on "Refresh branch compare".
- `QG/src/panel/ladder.ts` `primaryAction(state) → {kind, label, enabled, title}` and
  `menuItems(state) → MenuItem[]` are pure and implement [logic SC-28](logic.md#the-primary-button-and-its-menu)
  and SC-29 exactly, including the in-flight row 3 rules (an in-flight force push shows
  "Force Push"; a busy op that differs from the pick shows that op's label; else
  "Remote operation in progress…"). `state` is `{status, compareReady, staged, message,
  committing}`.
- `QG/src/panel/remote-messages.ts` `toastFor(action, reason, message) → {title, body}` with Orca's
  renderer strings (`src/renderer/src/lib/source-control-remote-error.ts` list in
  source-control.md "Remote actions"), changing only the conflict pull text to "…then continue the
  merge." (D17).
- `QG/src/panel/sections.ts` (group, order by `groupOrder`, Orca's sort with
  `Intl.Collator('en', {numeric: true})`), `tree.ts` (per-section trees, compacted single-child
  chains, folders first), `selection.ts` (reducer: click → clear + open; mod-click → toggle +
  anchor; shift-click → range from anchor; context-click on unselected → only it; escape → clear;
  view-mode/worktree change → clear), `filter.ts` (case-insensitive substring; > 2048 UTF-8 bytes
  → too large).
- Commit box: Mod+Enter on the panel root runs commit only when the primary is an enabled
  Commit; draft per worktree in memory.
- Discard dialogs: the plugin's own `Dialog` with Orca's text from `discard-text.ts`, confirm
  autofocused (`button.danger`), then the method with `yes: true`.
- Badge: `setPanelBadge('panel:quirky.git/source-control', count, title)` with count = entries
  (minus resolved-locally duplicates), title `Source Control — 1 uncommitted change` /
  `— N uncommitted changes` / `— N+ uncommitted changes` when capped; `null` when 0.
- Notices (`QG/src/panel/Notices.tsx`, the pattern of `plugins/quirky.worktree/src/Notices.tsx`,
  because `context.toast` carries no actions or ids): a list keyed by id at the bottom of the
  panel; showing a notice with an existing id replaces it. Row failures use id
  `source-control-entry-mutation` with a Retry button for 10,000 ms (then only Dismiss), and gain
  " in <worktree>" and lose Retry when the panel has moved to another worktree; bulk failures use
  id `source-control-bulk`. Plain outcome messages (remote toasts of `remote-messages.ts`, "Abort
  merge failed") use `context.toast`.
- Huge-folder offer: once per worktree id per window session, on the first capped status, if
  `hugeFolders` returns any, a notice with an "Add to .gitignore" button for the first.
- `report(state)`: `{worktree, branch, base, ahead, behind, operation, busy, capped, sections:
  [{id, count}], primary: {label, enabled, title}, selection: string[], filter, viewMode,
  historyOpen}` (≤ 64 KiB; sections list counts, not rows).

### Window: the `diff` view
- `view:quirky.git/diff` mount input `SCHEMA:`
  `{worktree: string, mode: 'file' | 'combined' | 'conflicts' | 'conflict-file', source?, path?, oldPath?, area?: 'staged' | 'unstaged' | 'untracked' | 'branch' | 'all', commit?, title?}`.
  The host remounts on new input (`PluginSlot.tsx` ~28), so each mount reads fresh.
- `QG/src/view/merge.ts` `createMerge(parent, {original, modified, path, sideBySide, wrap,
  showWhitespace, collapseUnchanged, editable, onSave?}) → {destroy, nextChange, previousChange,
  currentChange, getModified}`: `MergeView` (side-by-side) or an `EditorView` with
  `unifiedMergeView({original})` (inline); `collapseUnchanged: {margin: 3, minSize: 4}` when on;
  "show whitespace" off means `diffConfig` ignores trim whitespace in highlighting (CodeMirror has
  no exact `ignoreTrimWhitespace`; highlight trailing whitespace with `highlightTrailingWhitespace`
  when on). Mod+S in the modified editor calls `onSave`. Theme follows the shell tokens, not
  `oneDark`.
- Single file: scroll to the first chunk on first load; "Previous change"/"Next change" and
  F7/Shift+F7 (`command:quirky.git/next-change` / `previous-change`, which act on the active view
  through a module-level registry; every view command does the same and fails with "No diff view
  is open." when none is) use `goToNextChunk`/`goToPreviousChunk`; disabled with no chunks.
  Editable diffs get Revert Block: `revertControls: 'a-to-b'` on the side-by-side `MergeView`, and
  `mergeControls` showing only the reject (revert) button in the inline view; `revert-change`
  reverts the chunk holding the cursor (the current change). Reverting edits the buffer only.
- Live render limit: editable views recount after each document change (debounced 300 ms); once
  the draft passes 6,000,000 combined characters or 120,000 lines a side, the editor is replaced by
  the large-diff fallback plus "This draft crossed the safe display limit, but it can still be
  saved." and a Save button, holding the draft in memory until saved or closed. Editable only for source `unstaged` (and untracked); saves pass `expected` =
  `modifiedHash` of the last load; `changed-on-disk` shows the banner of SC-61; Overwrite saves
  without `expected`; Reload reloads.
- Combined: entries from status (area filter, unresolved conflicts excluded with the notice),
  compare (branch) or `commitFiles` (commit); `all` = uncommitted then branch. First six sections
  load at once, the rest when within one viewport (IntersectionObserver), at concurrency 1; a
  section with `added + removed > 10_000` or unknown counts (not binary, not submodule) shows
  "Load diff". Toolbar toggles write the settings through `setting.set`. Unstaged sections editable
  with a per-section stale bar "This file changed on disk since this section loaded." with
  Reload from Disk and Overwrite.
- Conflict review: snapshot of status' conflict entries at open; Refresh re-reads; badges
  Unresolved / Resolved / Gone (path no longer in conflicts and not on disk).
- Conflict file: `conflictFile` content in an editable `EditorView` with `QG/src/view/conflict-markers.ts`:
  a pure parser `conflictBlocks(text) → {start, base?, separator, end}[]` (line numbers of
  `<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`) and a decoration extension adding line classes
  `qg-conflict-current|base|incoming|marker` and the trailing labels "Current change", "Common
  ancestor", "Incoming change", "End conflict"; banner, counter and wrap-around navigation;
  Mod+S saves with `expected` = the read hash.
  Unresolved modify/delete conflicts offer Keep file (guarded save, then stage) and Accept
  deletion (`acceptConflictDeletion` with the latest read/saved hash). Missing working files
  disable Keep; pending actions disable both choices and editing. Successful resolution reloads
  the file and removes the choices. Panel row and bulk staging exclude these conflict kinds.
- Close: reopens `view:quirky.session/worktree` with `{worktree}`.
- `report(state)`: `{mode, source, path, area, commit, changes: number, currentChange: number |
  null, dirty: boolean, stale: boolean, tooLarge: boolean, sections?: number, loadedSections?:
  string[], collapsed?: boolean, conflicts?: number, currentConflict?: number | null}`.

### Commands, keybindings, settings
`CONFIG:` manifest contributions (ids short; full ids `command:quirky.git/<id>`, `setting:quirky.git/<id>`):

| kind | id | details |
|---|---|---|
| command | `show` | "Show Source Control"; opens the panel |
| command | `open-diff` | args `{path, source?, area?, commit?, oldPath?, worktree?}`; `source: 'conflict'` opens the conflict file view |
| command | `open-changes` | args `{area?, worktree?}` (View all) |
| command | `open-branch-changes` | args `{worktree?}` |
| command | `open-commit` | args `{commit, worktree?}` |
| command | `review-conflicts` | args `{worktree?}` |
| command | `next-change`, `previous-change` | "Go to Next Change", "Go to Previous Change" |
| command | `next-conflict`, `previous-conflict` | conflict file view's Next / Previous conflict |
| command | `revert-change` | reverts the current change in an editable diff (Revert Block) |
| command | `save`, `reload-from-disk`, `overwrite` | the open view's save and stale-banner buttons |
| command | `collapse-all` | args `{collapsed?}` (toggles without args) |
| command | `load-diff` | args `{path}` — a combined section's "Load diff" |
| command | `refresh-compare` | "Refresh branch compare" |
| command | `set-filter` | args `{query}` (`''` closes) |
| command | `select` | args `{paths}` |
| command | `toggle-history` | args `{open?}` |
| keybinding | `show` | `mod+shift+g` |
| keybinding | `next-change` / `previous-change` | `f7` / `shift+f7` |
| setting | `groupOrder` | enum `changes-first` (default), `staged-first`, `untracked-first` — "Source Control Group Order" |
| setting | `compareBase` | enum `repository-default` (default), `branch-upstream` — "Default Compare Base" |
| setting | `viewMode` | enum `list` (default), `tree` |
| setting | `diffDefaultView` | enum `inline` (default), `side-by-side` — "Default Diff View" |
| setting | `diffWordWrap` | boolean false — "Diff Word Wrap" |
| setting | `diffShowWhitespace` | boolean false — "Diff Show Whitespace" |
| setting | `diffCollapseUnchanged` | boolean false — "Collapse Unchanged Regions" |
| setting | `combinedDiffFileTree` | enum `hidden` (default), `shown` — "Default Diff File Tree" |
| view | `diff` | "Diff" |

Keybinding handlers receive `undefined` args (`packages/ui/src/plugins/host.ts:251`); every
command handler tolerates it and defaults the worktree to the open view's (`worktreeOf`,
`QG/src/scm.ts`). The window learns of setting changes from `setting.changed` events.

## Data models

`SCHEMA:` (`packages/protocol/src/model.ts`; new names exported from `@quirky/protocol`)

```
GitArea = 'conflicts' | 'staged' | 'unstaged' | 'untracked'
GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'
GitConflictKind = 'both_modified' | 'both_added' | 'both_deleted' | 'added_by_us' | 'added_by_them' | 'deleted_by_us' | 'deleted_by_them'
GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'none'
GitBusyOp = 'push' | 'force-push' | 'pull' | 'fast-forward' | 'fetch' | 'sync' | 'rebase' | 'continue' | 'abort'
GitStatusEntry = { path: string; oldPath?: string; area: GitArea; status: GitChangeStatus;
  conflict?: { kind: GitConflictKind; state: 'unresolved' | 'resolved_locally' };
  added?: number; removed?: number; binary?: boolean;
  submodule?: { commitChanged: boolean; trackedChanges: boolean; untrackedChanges: boolean } }
GitUpstreamStatus = { hasUpstream: boolean; name: string | null; sha: string | null;
  ahead: number; behind: number; behindPatchEquivalent: boolean | null }
GitStatus = { branch; upstream; ahead; behind; files;            // v1, unchanged
  head: string | null; detached: boolean; unborn: boolean;
  entries: GitStatusEntry[]; operation: GitOperation; capped: boolean;
  upstreamStatus: GitUpstreamStatus; busy: GitBusyOp | null }
GitChange = { path: string; oldPath?: string; status: GitChangeStatus; added: number | null; removed: number | null; binary: boolean }
GitCompare = { status: 'ready' | 'invalid-base' | 'unborn-head' | 'no-merge-base';
  base: string | null; baseSource: 'worktree' | 'project' | 'detected' | 'upstream' | 'param' | null;
  message: string | null; baseOid: string | null; headOid: string | null; mergeBase: string | null;
  ahead: number; behind: number; entries: GitChange[]; added: number; removed: number }
GitCommit = { oid: string; parents: string[]; author: string; email: string;
  authoredAt: number; committedAt: number; subject: string; body: string; refs: string[] }
GitHistory = { commits: GitCommit[]; hasMore: boolean }
GitDiffSource = 'unstaged' | 'staged' | 'branch' | 'commit'
GitDiff = { path; staged; original; modified; binary;               // v1, unchanged meaning
  source: GitDiffSource; oldPath?: string; kind: 'text' | 'binary' | 'image';
  mime?: string; modifiedHash?: string | null; modifiedDeleted?: boolean;
  tooLarge?: { originalLines: number; modifiedLines: number; characters: number; reason: 'lines' | 'characters' } }
```

For `kind: 'image'`, `original`/`modified` hold base64 and `binary` is true (v1 readers see a
binary file). Untracked rows have `status: 'untracked'` and area `untracked`; a staged addition is
`added`.

Manifest method params and results declare these shapes in the flat schema subset; object
fields with unions (`string | null`) are declared without `type`, as the existing result schemas
do (`QG/quirky-plugin.json` `branch`, `upstream`).

## DO-NOT-CHANGE fences

- `packages/daemon/src/plugins/dispatch.ts` and `confirm.ts`: the confirmation flow is kernel and
  shared by every destructive method; this item only declares methods that use it.
- `GitStatus.branch/upstream/ahead/behind/files` and `GitDiff.path/staged/original/modified/binary`
  meanings: `plugins/quirky.worktree/src/DeleteDialog.tsx:20` and v1 tests read them.
- `quirky.git/changed` data `{worktreeId}`: `apps/desktop/test/events.test.ts:77` and the window
  rely on it.
- The folder-workspace refusal (`QG/main.ts:24-31`): text and `data.reason` are m1-worktrees'.
- `PG/ops.ts` `fetchRemote` and the worktree create/remove pipelines
  (`plugins/quirky.worktree/src/daemon/create.ts`, `remove.ts`): m1-worktrees behaviour.
- `docs/loop/LOOP.md`, `scripts/build-loop/`, `docs/loop/queue.json`, `docs/loop/DECISIONS.md`:
  protected loop files.

## Always / Ask / Never

- **Always:** pass git paths as `:(literal)` pathspecs or after `--`; use `--end-of-options` before
  user-supplied revs; run every git through `runGit`/`git` (so the env guards apply and tests can
  fake it via `gitApi()`); check every user path resolves inside the worktree before touching
  disk; redact credentials before any message leaves `remote-error.ts`.
- **Always:** keep v1 tests passing unless the logic spec changes their behaviour (the in-panel
  diff moves to the view); update those tests rather than deleting their intent.
- **Ask (decide and record as a decision):** component file splits, CSS class names, the exact
  `IntersectionObserver` margins, how the view registry for F7 is shaped.
- **Never:** pass `--no-verify`; run `git stash`, `reset --hard` or `checkout .` anywhere; let git
  inherit a TTY prompt (no `stdin: 'inherit'`); fetch on a timer; write outside the worktree
  except git's own files; touch the real `~/.quirky`, `~/.claude`, `~/.codex` or the user's git
  config in tests.

## Cross-cutting

- **Security:** credentials stripped from every remote error; `ignoreFolder` is allowlisted.
  Path containment (`QG/src/daemon/paths.ts` `containedPath(worktreePath, rel)`), used by `save`,
  `discard`, `reveal`, `conflictFile`, `diff` and `submoduleStatus`: reject absolute paths and any
  `..` segment after normalising; `realpath` the parent directory and require it inside the
  worktree's `realpath` (`outside-worktree`); then `lstat` the leaf. Working-tree reads never follow
  a leaf symlink: `diff` returns the link's target text (what git stores for a symlink), and `save`
  and `conflictFile` refuse a symlink leaf (`not-allowed`). `discard` hands paths to git, which
  doesn't follow leaf links (SC-67).
- **Observability:** `context.log` one line per remote op: `<op> <worktreeId> ok|<reason> <ms>`.
- **Migration:** none; no store tables are added (the lock and opened set are in memory and reset
  on restart).
- **Platform:** `open -R`, `ssh -o BatchMode=yes` and `Mod` = Cmd are macOS-only (D34).

## Testing strategy

All tests run real git in temp dirs with `GIT_CONFIG_GLOBAL=/dev/null` and an identity in env
(`isolateGitConfig()`, `plugins/quirky.repo/test/git-fixtures.ts:8`), temp `QUIRKY_HOME`, and
remove what they create.

- `packages/git/test/`: per module — `status-v2.test.ts` (records, conflicts, submodule,
  detached, unborn, cap kill), `upstream.test.ts` (effective upstream, patch equivalence),
  `remote.test.ts` (bare `origin` + `peer` clone: push, publish, pushRemote, non-fast-forward,
  pull + divergent retry, ff-only, fetch prune, force push lease and stale lease, rebase from base,
  network and fake-ssh auth with no hang), `remote-error.test.ts` and `failure.test.ts` (pure
  tables, credential redaction), `discard.test.ts`, `compare.test.ts`, `history.test.ts`,
  `diffs.test.ts` (sources, kinds, limits, missing vs failing blobs), `conflicts.test.ts`
  (operation detection in a linked worktree, continue, abort).
- `plugins/quirky.git/test/scenarios/`: one `test('SC-n: …')` per API/CLI scenario in the logic
  spec, against a real daemon with the real `quirky.repo`, `quirky.worktree` and `quirky.git`
  (`startPluginHarness({plugins: ['quirky.repo', 'quirky.worktree', 'quirky.git'], realGit: true,
  fakeAsk: true})`, `plugins/quirky.repo/test/harness.ts`) and, for "(CLI)" scenarios, the real
  CLI (`runCli`, `packages/cli/test/fixtures/fake-daemon.ts:541`). Destructive scenarios cover the
  ask path and `--yes`.
- `plugins/quirky.git/test/ui/`: happy-dom tests of the panel and the view with the fake context of
  `QG/test/ui.test.ts` grown to record `openView`, `setPanelBadge`, settings and dialogs: one test
  per "(UI)" scenario's observable rules, plus pure tests of `ladder.ts` (every row of SC-28),
  `menuItems`, `remote-messages.ts`, `sections.ts`, `tree.ts`, `selection.ts` (SC-15, the Orca
  defect), `filter.ts`, `discard-text.ts` and `conflict-markers.ts`.
- Existing tests: `QG/test/*.test.ts` keep passing, with the in-panel-diff test
  (`ui.test.ts:316`) moved to the view; `git.test.ts`'s manifest assertions list the new
  contributions.
- Acceptance bar: every logic scenario has a named test; `bun run test`, `bun test scripts` and
  `bun run typecheck` pass; the UI scenarios pass in the web window (LOOP.md step 6).

## Non-goals

This spec doesn't cover diff notes, AI actions or hosted review (logic
[Scope & non-goals](logic.md#scope--non-goals)); file watching (D30); editor tabs; persisting the
opened-conflict set or the lock across daemon restarts; Linux or Windows behaviour.
