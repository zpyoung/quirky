# m1-worktrees tech spec

**Status:** Draft for build. **Logic spec:** [logic.md](logic.md). **Decisions:** [m1-worktrees.md](../../../loop/decisions/m1-worktrees.md).

All paths are relative to the repo root (`/Users/zpyoung/orca/workspaces/quirky/build-lane-3`).
Line numbers are as of commit `3235eb1`.

## Architecture

Back-link: [Conceptual model](logic.md#conceptual-model), [Data flow](logic.md#data-flow).

Five layers change. Each later layer depends only on the contracts of the earlier ones.

1. **Protocol** (`packages/protocol/src/model.ts`): `Repo` and `Worktree` grow; new `ProjectGroup`,
   `RepoDetails`, `EffectiveHooks`, `WorktreeCreateResult`, `WorktreeRemoveResult` types.
2. **Git** (`packages/git/src`): new git primitives (registrations with lock and prunable state,
   default base, refs, fetch, config, ref-format, dirty count, branch cleanup with a merge-tree
   check, `git show` at a ref, ignored-file listing, `--git-path`, init, clone, username). Every one
   spawns `git` through `run.ts`; no git library.
3. **`quirky.repo`** (`plugins/quirky.repo`): project kinds, clone, create, scan, import, groups,
   project settings, hooks loading and trust. The daemon module splits into `src/` files.
4. **`quirky.worktree`** (`plugins/quirky.worktree`): the metadata store, naming, base resolution,
   the create pipeline, setup and archive runners, carried files, set, remove with branch cleanup,
   folder workspaces, generated names, and the CLI. The daemon module splits into `src/daemon/`.
   **`quirky.session`** grows `title` and `command` on `create`. **`quirky.git`** refuses folder
   workspaces.
5. **Window** (`plugins/quirky.worktree/src/*.tsx`, `packages/ui/src/styles.css`): the sidebar tree,
   card and project menus, and the add-project, create, update, delete, trust, parent, group,
   project-settings and remove-project dialogs. **CLI** (`packages/cli/src/main.ts`): JSON errors
   carry `reason`.

No new dependencies. YAML is parsed with `Bun.YAML.parse` (Bun 1.4.0, verified). Git ≥ 2.38 is
required for `git merge-tree --write-tree` (the dev machine has 2.53.0).

## Code references

Back-link: [Key decisions](logic.md#key-decisions).

### Protocol

- `packages/protocol/src/model.ts:3-9` `Repo`, `:11-22` `Worktree`: grow per [Data models](#data-models).
  Consumers that read `Worktree.name` (`plugins/quirky.agent-status/main.ts:162-165`,
  `plugins/quirky.structured/main.ts:144`, `plugins/quirky.session/src/window/model.ts:188`,
  `src/window/WorktreeView.tsx:46`) keep working; `name` keeps its type and gains the display-name
  meaning ([D8](../../../loop/decisions/m1-worktrees.md)).
- `plugins/quirky.session/test/fakes/quirky.worktree/main.ts:5` and
  `plugins/quirky.worktree/test/ui.test.ts:34` build `Worktree` literals; add the new fields there.

### Git (`packages/git/src/index.ts`)

- Keep `listWorktrees` (:73) and its prunable-skipping behaviour for existing callers, and add
  `locked: string | null` to `GitWorktreeInfo` (:46).
- Replace `addWorktree` (:103-126) callers in `quirky.worktree` with the new `addNewBranchWorktree`
  and `addExistingBranchWorktree`; keep `addWorktree` exported (the fake and old tests use it).
- `removeWorktree` (:128) stays.
- `packages/git/src/testing.ts:13` `createFakeGit` spreads the real module, so new functions run
  real git against fake paths. Tests of create, remove and set move to real git (see
  [Testing strategy](#testing-strategy)); the fake stays for `quirky.git`, `repo add` and selector tests.

### `quirky.repo`

- `plugins/quirky.repo/main.ts:43-58` store migrations: append migration 2 (never edit migration 1).
- `:72-139` handlers: `add` (:97) grows `folder`; `remove` (:131) also tells `quirky.worktree` to drop
  metadata through the existing `quirky.repo/changed` prune (`plugins/quirky.worktree/main.ts:248-255`).
- New files: `src/store.ts` (migrations, row mapping), `src/projects.ts` (add, clone, create,
  remove), `src/scan.ts` (scan and import), `src/groups.ts`, `src/settings.ts` (set, show),
  `src/hooks.ts` (hooks file loading, merge, trust). `main.ts` keeps `activate` and the `provide` wiring.
- `plugins/quirky.repo/cli.ts`: add commands; `selector.ts` unchanged except `displayName` also
  matches `name:` ([Selectors](#selectors)).
- `plugins/quirky.repo/quirky-plugin.json`: new methods, events data, CLI commands.

### `quirky.worktree`

- `plugins/quirky.worktree/main.ts:44-58` store: append migration 2. `:97-114` `repoWorktrees`
  becomes the join of git registrations and metadata (`src/daemon/list.ts`). `:170-200` `create`
  moves to `src/daemon/create.ts`. `:202-227` `remove` moves to `src/daemon/remove.ts`. `:79-84`
  `identityOf`, `:131-152` `findWorktree` and `:248-255` `pruneRemovedRepos` keep their contracts.
- New files under `plugins/quirky.worktree/src/daemon/`: `store.ts`, `list.ts`, `naming.ts`
  (sanitise, prefix, suffix walk), `names.ts` (the marine-creature pool and retirement), `base.ts`,
  `create.ts`, `carry.ts` (`.worktreeinclude`, shared directories), `hooks-run.ts` (runner script,
  terminal or in-daemon run, archive), `remove.ts`, `branches.ts`, `set.ts`, `queue.ts` (per-repo
  create queue, delete join).
- `plugins/quirky.worktree/selector.ts:41-55`: `name:` also matches the folder name
  ([Selectors](#selectors)).
- `plugins/quirky.worktree/cli.ts`: rewrite the commands ([CLI](#cli)).
- `plugins/quirky.worktree/quirky-plugin.json`: grown methods, settings, commands.

### `quirky.session`

- `plugins/quirky.session/quirky-plugin.json:184-216` `create` params: add `title` and `command`.
- `plugins/quirky.session/src/sessions.ts:47-93` `create`: use `title` as the base title (still
  numbered by `titleFor`, :192-198), and for `agent: 'shell'` with `command` spawn
  `context.launch.commandArgv(command)` instead of `shellArgv()` (:66-69). `command` with any other
  agent is `invalid-params`.

### `quirky.git`

- `plugins/quirky.git/main.ts:19-38` `resolve`/`inWorktree`: a worktree of kind folder throws
  `invalid-params` "Opened as folder. Git features are unavailable for this workspace." before
  any git call. `src/SourceControl.tsx:137` already shows `error` in `.scm-error`; no UI change
  beyond that text.

### Window

- `plugins/quirky.worktree/src/`: replace `WorktreesSection.tsx`, `NewWorktreeDialog.tsx`,
  `AddRepoForm.tsx`; extend `actions.ts`, `report.ts`; keep `Dialog.tsx`, `status.ts`, `StatusDot.tsx`,
  `ui.tsx`. New: `Tree.tsx` (groups, projects, rows, nesting, pinned), `Menu.tsx` (cursor-positioned
  context menu, `role="menu"`), `CreateDialog.tsx`, `UpdateDialog.tsx`, `DeleteDialog.tsx`,
  `TrustDialog.tsx`, `ParentDialog.tsx`, `AddProjectDialog.tsx` (path, Open as Folder, import),
  `ProjectSettingsDialog.tsx`, `RemoveProjectDialog.tsx`, `GroupDialogs.tsx`, `Notices.tsx` (kept-branch
  and base-fallback notices with actions, rendered inside the section), `useTree.ts`.
- `packages/ui/src/styles.css`: new classes for the menu, badges, chips, group headers, pinned
  section, pending and deleting rows and notices, using the theme tokens at `:1-14`. Existing
  classes `.overlay`, `.dialog`, `.dialog-actions`, `.form`, `.check-row`, `.menu` are reused.
- Plugin toasts have no actions (`packages/ui/src/plugins/host.ts:689-690`), so action notices live
  in the section ([D38](../../../loop/decisions/m1-worktrees.md) "Delete branch").
- `context.confirm` has no checkbox (`packages/ui/src/components/ConfirmHost.tsx`), so the delete
  dialog is the plugin's own `Dialog`.

### CLI kernel

- `packages/cli/src/main.ts:142-171` JSON error output: add `reason` when the error's `data.reason`
  is a string. Text mode prints the message unchanged.

## Contracts & interfaces

Back-link: [Behavior & scenarios](logic.md#behavior--scenarios).

### Errors

Plugin error kinds are `invalid-params`, `not-found`, `conflict` only
(`packages/protocol/src/plugins.ts:154`). A distinct outcome is a `conflict` or `invalid-params`
error with `data.reason` set:

`SCHEMA:` error reasons (`data.reason`) and extra data

| reason | kind | data |
|---|---|---|
| `setup-decision-required` | conflict | `{ repo }` |
| `hooks-untrusted` | conflict | `{ repo, kind: 'setup'\|'archive', source, script, hash, changed: boolean, ref? }` (`ref`: the commit a create read the script at; absent for archive) |
| `no-base` | conflict | `{}` |
| `base-unreachable` | conflict | `{ ref, remote }` |
| `no-commits` | conflict | `{ repo }` |
| `branch-exists` | conflict | `{ branch }` |
| `branch-checked-out` | conflict | `{ branch, path }` |
| `invalid-name` | invalid-params | `{}` |
| `invalid-prefix` | invalid-params | `{ prefix }` |
| `dirty` | conflict | `{ count }` |
| `submodules` | conflict | `{}` |
| `locked` | conflict | `{ reason }` |
| `primary` | conflict | `{}` |
| `has-descendants` | conflict | `{ descendants: string[] }` |
| `orphaned` | conflict | `{ path }` |
| `unregistered` | conflict | `{ path }` |
| `archive-hook-failed` | conflict | `{ exitCode, output }` |
| `deletion-in-progress` | conflict | `{}` |
| `branch-moved` | conflict | `{ branch, head }` |
| `parent-cycle` | invalid-params | `{}` |
| `folder-workspace` | invalid-params | `{}` |
| `destination-exists` | conflict | `{ path }` |
| `not-a-repository` | invalid-params | `{ path }` |

Messages are the logic spec's exact sentences. The CLI's JSON error object becomes
`{ code, message, reason? }`.

### `quirky.repo` methods

All take a repo selector `repo` where named. `readOnly` methods are marked (R).

`CONTRACT:`
- `list() → Repo[]` (R): ordered by `addedAt`, then id.
- `add({ path, folder? }) → Repo`: a git path resolves to its toplevel as today; a non-git
  directory with `folder: true` adds kind folder at its real path; without `folder`, `not-a-repository`
  with the logic spec's message. Idempotent by real path.
- `clone({ url, location?, name? }) → Repo`: destination `<location ?? worktreesRoot>/<name ?? basename(url) minus .git>`;
  `destination-exists` if present. `worktreesRoot` is read from `quirky.worktree`'s setting through
  `setting.get` (`setting:quirky.worktree/worktreesRoot`), expanded like
  `plugins/quirky.worktree/paths.ts:6` `expandHome`.
- `create({ name, location? }) → Repo`: `mkdir`, `git init` (no `-b`), add. `destination-exists`
  if the folder exists and is non-empty.
- `scan({ path, maxDepth? = 3 (1-8), maxRepos? = 100 (1-500) }) → { repos: { path, name }[], truncated: boolean }` (R).
- `import({ path, group?, maxDepth?, maxRepos? }) → { results: { path, status: 'imported'|'already-known'|'failed', repoId?, error? }[], imported, alreadyKnown, failed, groupId? }`.
- `remove({ repo }) → { ok: true }`: as today (`main.ts:131-137`), plus removes the repo from its group.
- `resolve({ selector }) → Repo` (R).
- `show({ repo }) → RepoDetails` (R).
- `set({ repo, displayName?, defaultBase?, worktreeLocation?, setupPolicy?, agentStartup?, commandSource?, setupScript?, archiveScript? }) → RepoDetails`:
  an empty string clears a string field; enums are validated by schema.
- `hooks({ repo, ref? }) → EffectiveHooks` (R): the hooks file read at `ref` (default: the repo's
  `HEAD`), merged with local scripts by the command-source policy, with trust per script.
- `trustHooks({ repo, kind? = 'all', ref? }) → RepoDetails`: stores the current shared scripts' hashes
  as read at `ref` (default `HEAD`), validated like `hooks`' `ref`.
- `groupList() → ProjectGroup[]` (R); `groupCreate({ name, parentPath? })`; `groupRename({ group, name })`;
  `groupDelete({ group }) → { ok }`; `groupAdd({ group, repo })`; `groupRemove({ group, repo })`;
  `groupCollapse({ group, collapsed? = true })`. Group selectors are an ID or an exact name;
  ambiguity is `conflict` as for repos.
- Every mutation emits `quirky.repo/changed` with `{ repoId? , groupId? }`.

### Hooks loading (`quirky.repo/src/hooks.ts`)

Back-link: [SC-32](logic.md#setup-and-archive-hooks), [SC-34](logic.md#setup-and-archive-hooks), [SC-35](logic.md#setup-and-archive-hooks).

- The shared file is `quirky.yaml` at `ref`, else `orca.yaml` at `ref`, read with
  `git show <ref>:<file>` (`showFile`); a missing file is no shared hooks. A file that fails to
  parse yields a warning and no shared hooks.
- Recognised keys: `scripts.setup`, `scripts.archive` (strings), `setupAgentStartupPolicy`
  (`start-immediately` | `wait-for-setup`), `worktree.sharedDirectories` (string list). Known but
  unsupported: `issueCommand`, `defaultTabs`, `environmentRecipes`. Anything else top-level: an
  unrecognised-key warning.
- Command-source policy: `shared-only`, `local-only`, `run-both`; unset means `local-only` when the
  project has a local script of that kind, else `shared-only`. `run-both` joins shared then local
  with a newline.
- Trust: `hash = sha256(script.trim())` hex; a shared script is trusted when the project's stored
  hash for that kind equals it. Local scripts are always trusted. `changed` is true when a stored
  hash exists and differs.
- The effective agent startup policy is the project setting, else the file's
  `setupAgentStartupPolicy`, else `start-immediately`.

### `quirky.worktree` methods

`CONTRACT:`
- `list({ repo?, group? }) → Worktree[]` (R): the join ([List and reconcile](#list-and-reconcile)).
- `create(CreateParams) → WorktreeCreateResult` ([Create pipeline](#create-pipeline)).
- `suggestName({ repo }) → { name }` (R): the generated name a blank create would use now, without
  retiring it (the window's placeholder, SC-28).
- `set({ worktree, displayName?, comment?, status?, pinned?, unread?, parent?, noParent? }) → Worktree`:
  `status ∈ todo|in-progress|in-review|done`; `parent` is a worktree selector; a cycle is
  `parent-cycle`; `parent` with `noParent` is `invalid-params`. Emits `changed`.
- `show({ worktree }) → Worktree & { children: string[] }` (R).
- `remove(RemoveParams) → WorktreeRemoveResult`, destructive, with `describe: describeRemove`
  ([Remove pipeline](#remove-pipeline)).
- `describeRemove(RemoveParams) → string` (R): names the target, its descendants when
  `withDescendants`, and "discarding uncommitted changes" when `force`.
- `deleteBranch({ repo, branch, head }) → { ok: true }`, destructive (`confirm: "Delete branch {branch}?"`):
  deletes `refs/heads/<branch>` only if it is at `head` (`git update-ref -d refs/heads/<b> <head>`),
  else `branch-moved`.
- `resolve`, `ownedIds`: unchanged contracts.

`SCHEMA:` `CreateParams`
- `repo?` selector; `group?` group selector (folder workspace on its parent folder); one of them is
  required unless the caller has a worktree identity, in which case the caller's project is used.
- `name?` string (blank or absent → generated); `branch?` an existing local or `origin/<b>` branch to
  check out; `branchName?` explicit new-branch name; `base?` ref; `displayName?`; `comment?`;
  `parent?` selector; `noParent?` boolean; `setup?` `run|skip|inherit` (default inherit);
  `trustSetup?` boolean; `agent?` agent kind except shell; `prompt?`; `allowLocalBaseFallback?`
  boolean (default true); `activate?` boolean; `createdBy?` `window|cli|api` (the window and the CLI
  pass theirs; default api).

`SCHEMA:` `RemoveParams`
- `worktree` selector; `force?`; `withDescendants?`; `skipArchive?`; `allowFailedArchiveHook?`.

### List and reconcile

Back-link: [SC-45](logic.md#metadata), [D6](../../../loop/decisions/m1-worktrees.md).

- For each git project, `listRegistrations(repo.path)` gives every registration including prunable
  and locked ones. Prunable registrations and missing folders are excluded from `list` but kept
  for `remove` ([Remove pipeline](#remove-pipeline)).
- For each listed worktree, metadata is looked up by ID. A row whose stored `birthtime` differs from
  the folder's current birth time (`statSync(path).birthtimeMs`, rounded to ms) is deleted and the
  worktree is shown with defaults. A worktree with no row gets one on first sight with defaults
  (`createdBy: 'external'`, status `in-progress`, `createdAt` the folder's birth time).
- After a successful `listRegistrations` of a repo, a row of that repo is deleted only when its ID
  isn't registered at all and its folder doesn't exist (and it isn't a folder workspace). An
  unregistered row whose folder exists is kept as an orphan (hidden from `list`, found by
  `remove`); a prunable registration keeps its row. A failed git call deletes nothing.
- Folder projects: the primary is synthesised from the repo (`worktreeIdForPath(repo.path)`, kind
  folder, branch null, head ''); extra folder workspaces are rows of kind folder. Group folder
  workspaces are rows with `group_id`, `repoId: 'group:<groupId>'`.
- `name` = `displayName` ?? (isMain ? branch ?? basename(path) : basename(path)); for folder
  workspaces other than the primary it is the name given at create.
- `removing` is true while a remove of that ID is in flight in this daemon.
- Order: primary first, then `createdAt` ascending, then ID.

### Create pipeline

Back-link: [Create](logic.md#create), [Data flow](logic.md#data-flow).

Steps run in this order; any refusal before step 6 leaves git and the disk untouched.

1. Resolve the project (`repo`, else `group`, else the caller's worktree's project via
   `identityOf`, `main.ts:79-84`; none → `invalid-params` "name a project with --repo"). Folder
   projects and groups skip to [Folder create](#folder-create).
2. Enter the repo's create queue (`queue.ts`; one create at a time per repo ID).
3. `hasCommits` false → `no-commits`.
4. Resolve the base ([Base resolution](#base-resolution)) unless `branch` is given (its tip is the
   start point).
5. Resolve the base or branch to a commit id once; the hooks gate and step 7 both use that commit, so a background fetch cannot split them. Hooks gate: `quirky.repo/hooks { repo, ref: <commit> }`. If there is an
   effective setup script: decision = `setup` unless inherit, else the policy
   (`run-by-default` → run, `skip-by-default` → skip, `ask` → `setup-decision-required`). If the
   decision is run and the setup has an untrusted shared part and not `trustSetup` →
   `hooks-untrusted`.
6. Name and branch: `name` sanitised ([Naming](#naming)); else, with `branch`, the branch's short name (minus a remote prefix) sanitised; else generated (`names.ts`). With `branch` (or a reused `branchName`) the branch is fixed and only the folder takes the suffix walk; folder =
   `<root>/<repoDir>/<name>` (nested) or `<root>/<name>`, where root is the project's
   `worktreeLocation` (relative → against `repo.path`) else `worktreesRoot`, and `repoDir` is
   `worktreeDirName` (`main.ts:117-120`); `ensureInside(root, folder)` or `invalid-name`. Walk
   suffixes to 100 ([Naming](#naming)).
7. `git worktree add`: new branch `git worktree add --no-track -b <branch> <path> <commit>`;
   existing branch `git worktree add <path> <branch>` (a remote-only `origin/<b>` first creates
   local `<b>` at `<commit>` with `origin/<b>` as its upstream); refusal when checked out elsewhere →
   `branch-checked-out`.
8. Best-effort git config: `branch.<branch>.base = <fullBase>`; `push.autoSetupRemote true` unless
   `git config --get push.autoSetupRemote` returns anything; upstream when the branch name equals the
   remote base's branch name.
9. Metadata row: `birthtime`, `created_root` (the root from step 6), `createdAt = now`, `createdBy`, `baseRef` (the short form of the base),
   `keepBranch` (true for `branch`), `displayName`, `comment`, `parentId` (explicit, else caller's
   worktree, else the worktree containing the caller's cwd, unless `noParent` or `createdBy: window`),
   `status: in-progress`. A generated name is retired here, and also on a failure after step 6.
10. Carry files ([Carried files](#carried-files)); warnings only.
11. Leave the queue. Emit `changed { repoId, worktreeId }`.
12. Setup ([Setup run](#setup-run)) when the decision is run; else if a script exists and the
    caller didn't pass `setup: 'skip'` (an inherited skip-by-default counts), warn `setup hook skipped for <path>; pass --setup run to run it.`
13. Agent: `quirky.session/create { worktree: id, agent, prompt }` now, or on the Setup session's
    exit when the agent startup policy is `wait-for-setup` and setup ran in a terminal. The result
    carries `agentSessionId` when started now, else `agentPending: true`; create never waits for
    the agent. The pending agent's session is visible later only through `quirky.session/list` and
    `quirky.session/changed`.
14. `activate`: `context.call('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: id } })`
    when true; nothing otherwise.

`WorktreeCreateResult = { worktree, warnings: string[], baseFallback?: { requestedRef, localRef, message }, setup: { ran: 'terminal'|'daemon'|'none'|'skipped', sessionId?, exitCode?, timedOut? }, agentSessionId?, agentPending? }`.

### Base resolution

Back-link: [SC-19](logic.md#create), [SC-20](logic.md#create).

1. Requested `base` → use it.
2. Else detect default: `git for-each-ref --format=%(refname)%00%(symref) refs/remotes/origin/HEAD refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master`;
   `origin/HEAD`'s target wins, else the first existing in that order.
3. Saved `defaultBase`: equal to detected → use; no detected → use if it resolves; differs → use if
   it resolves, else detected. Nothing → `no-base`.
4. Full ref: a name with `/` tries `refs/remotes/<name>` then `refs/heads/<name>`; otherwise
   `refs/heads/<name>`, then a commit-ish (`git rev-parse --verify <name>^{commit}`).
5. Remote form (`<remote>/<b>` where `<remote>` is a configured remote): if `refs/remotes/<remote>/<b>`
   exists, use it and start `git fetch <remote> <b>` in the background (errors logged only).
   Missing: if a local branch named exactly `<name>` exists, use it with no notice; else
   `git fetch <remote>` (timeout 30 s). Fetch failed: `allowLocalBaseFallback` and
   `refs/heads/<b>` exists → use it with `baseFallback`; else `base-unreachable`. Fetch ok but still
   missing → `base-unreachable` with "Base ref "<base>" was not found after fetching."

### Naming

Back-link: [SC-15](logic.md#create), [SC-16](logic.md#create), [SC-17](logic.md#create).

- Sanitise: NFC; replace every run of characters outside `\p{L}\p{N}._-` with `-`; collapse
  `-{2,}` to `-` and `\.{2,}` to `.`; trim leading and trailing `.` and `-`; if the input had
  emoji (`\p{Extended_Pictographic}`) and the result is empty → `workspace`; empty, `.` or `..` →
  `invalid-name`.

`REGEX:` `/[^\p{L}\p{N}._-]+/gu` (replaced with `-`)

- Prefix: `branchPrefix` setting `git-username` | `custom` | `none`. git-username resolution order:
  `git config --get github.user`, `git config --get user.username`, `gh api user -q .login` only when
  a remote URL contains `github.com` (2.5 s per try, one try, a timeout or failure skips it and is
  cached for 5 minutes), `git config --get user.name` if `git check-ref-format --branch <it>/x`
  passes; else none. Normalise: trim, strip leading and trailing `/`, collapse `//`. A custom prefix
  failing `check-ref-format --branch <prefix>/x` → `invalid-prefix` with the logic spec's text.
- Branch = `<prefix>/<name>` or `<name>`; `branchName` overrides and must pass
  `git check-ref-format --branch` and not start with `-` (`invalid-name`).
- Suffix walk (no `branchName`, no `branch`): `name`, `name-2` … `name-100`; skip when
  `refs/heads/<branch>` exists, any `refs/remotes/*/<branch>` exists, or the folder exists. 100
  misses → `branch-exists` "Branch \"X\" already exists locally|on a remote." or
  "Could not find an available worktree path".
- `branchName` existing: reused only if it points at the base commit and isn't checked out in any
  worktree, and then checked out with the existing-branch form of step 7 (no `-b`), `keepBranch`
  false; else `branch-exists` "Branch <b> already exists".

### Generated names

Back-link: [SC-21](logic.md#create), [SC-28](logic.md#create).

- `names.ts` holds a fixed array of at least 200 lowercase, hyphen-free marine-creature names.
- Pick uniformly at random among names neither used by a listed worktree of the repo nor in
  `retired_names` for the repo; when none is left, the same with `-2`, then `-3`, … appended.
- Retire on create success and on create failure after the name was picked. Typed names are never
  stored. The collision walk still applies after picking.

### Folder create

- Folder project: a row of kind folder, random ID `wt_<12 hex>`, path = repo path, name = sanitised
  `name` or generated; no git, no carry; setup runs if the project's local setup exists (shared
  hooks need git, so none). Group: requires the group's `parentPath` (else
  `invalid-params` "group <name> has no parent folder"); path = `parentPath`; `repoId: group:<id>`.

### Carried files

Back-link: [SC-39](logic.md#setup-and-archive-hooks).

- `.worktreeinclude` at the primary checkout's root, read only if ≤ 256 KiB; patterns are gitignore
  syntax. Candidates = `git ls-files --others --ignored --exclude-standard -z` in the primary,
  intersected with `git ls-files --others --ignored -z --exclude-from=<.worktreeinclude>`; drop
  any path under `.git/`; at most 1000 entries; copy files preserving mode, skipping a destination
  that exists; budget 500 MiB total, then stop with a warning naming how many were skipped.
- `sharedDirectories`: at most 100 entries; drop absolute, `..`-containing and `.git` entries with a
  warning; link `<new>/<entry>` → `<primary>/<entry>` only when the source exists and
  `git check-ignore -q <entry>` succeeds in the primary; else warn.
- Never throws; every failure is a warning in the result.

### Setup run

Back-link: [SC-29](logic.md#setup-and-archive-hooks)–[SC-38](logic.md#setup-and-archive-hooks).

- Runner path: `git -C <worktree> rev-parse --git-path quirky/setup-runner.sh` (absolute against the
  worktree), mode 0755; folder workspaces use `<pluginDataDir>/runners/<worktreeId>/setup-runner.sh`.
- Runner content: `#!/bin/bash`, `set -e` is not used, `cd <worktree>`, exports, then the script
  text verbatim, so the script's exit status is the runner's.

`CONFIG:` hook environment (setup and archive)
- `QUIRKY_ROOT_PATH` = primary checkout (or folder); `QUIRKY_WORKTREE_PATH` = worktree path;
  `QUIRKY_WORKSPACE_NAME` = `basename(worktree path)`; `ORCA_ROOT_PATH`, `ORCA_WORKTREE_PATH`,
  `ORCA_WORKSPACE_NAME`, `CONDUCTOR_ROOT_PATH`, `CONDUCTOR_WORKSPACE_PATH`, `CONDUCTOR_WORKSPACE_NAME`,
  `GHOSTX_ROOT_PATH` mirror them.

- Terminal: `quirky.session/create { worktree: id, agent: 'shell', title: 'Setup', command: "/bin/bash '<runner>'" }`
  (single-quoted path). The view is not changed. `setup.ran = 'terminal'`, `sessionId`.
- Daemon (when `quirky.session/create` fails with MethodNotFound): `Bun.spawn(['/bin/bash', runner])`
  with cwd the worktree, the hook environment, stdin ignored, a detached process group, 2-minute
  timeout (SIGTERM to the group, then SIGKILL after 5 s), output capped at 10 MiB; the create waits
  for it. `setup.ran = 'daemon'`, `exitCode`, `timedOut`.
- Wait-for-setup: subscribe to `quirky.session/changed` and `quirky.session/removed` before calling
  `quirky.session/create` for Setup, buffer events for the not-yet-known ID, then after create
  returns check the returned session (and `quirky.session/get`) for `exited`; the first of these to
  show the Setup session exited (any code) or removed starts the agent, guarded by a once-flag. The
  subscription is dropped after it fires and on daemon stop. A pending agent is lost on a daemon
  restart (logged).

### Remove pipeline

Back-link: [Delete](logic.md#delete), [D42](../../../loop/decisions/m1-worktrees.md).

1. Join: an in-flight remove of the same ID with equal options (`force`, `withDescendants`,
   `skipArchive`, `allowFailedArchiveHook`) returns the same promise; different options →
   `deletion-in-progress`.
2. Resolve the target among listed worktrees and, for this step only, known rows whose folder is
   missing or whose registration is prunable or gone.
3. `isMain` → `primary` ("the primary worktree cannot be deleted; remove the project instead").
4. Descendants (rows whose `parentId` chain reaches the target): any, without `withDescendants` →
   `has-descendants`; with it, remove each deepest first through this same pipeline, stopping at
   the first failure (the error names what was removed in `data.removed`).
5. Folder workspace: close its sessions, delete the row, done. Its folder is never touched.
6. Orphans: row known and folder missing → `git worktree prune`, branch cleanup (step 11), drop row,
   done (no archive). Registered and prunable → same. Not registered but folder present →
   `orphaned` unless `force`, in which case `rm -rf` the folder only if the row exists, its
   `created_root` is set, and the folder is inside `created_root` (after `resolveRealPath`); a row
   without `created_root` (external or v1) → `unregistered`; a path with no row → `unregistered`.
7. `locked` from the registration → `locked` with the logic spec's message (force doesn't help).
8. Unless `force`: `git status --porcelain -z --untracked-files=all --ignore-submodules=none` in the
   worktree; entries that are only the symlinked shared directories are ignored; any other →
   `dirty` "Worktree has uncommitted or untracked changes."; a populated submodule (`git submodule status`
   lines not starting with `-`) → `submodules`.
9. Archive hook unless `skipArchive`: effective archive script at the worktree's `HEAD`; untrusted
   shared part → `hooks-untrusted` (kind archive); run in the daemon (as in [Setup run](#setup-run),
   2 minutes, 10 MiB); a non-zero exit or timeout → `archive-hook-failed` unless
   `allowFailedArchiveHook`.
10. Close sessions (`main.ts:155-168` `closeSessions`); any failure stops the remove unless `force`.
    Remove shared-directory symlinks. `git worktree remove [--force] <path>` (no timeout); a git
    refusal → `conflict` with git's message.
11. Branch cleanup, serialised per repo (`branches.ts`): `keepBranch` → keep, report nothing.
    Else `git branch -d -- <b>`; "checked out" in its error → `git worktree prune` and retry once.
    Refused: the branch is merged by tree into any target (below) → `git update-ref -d refs/heads/<b> <head>`;
    else keep and report `keptBranch { name, head }`.
12. Drop the row and any retired-name bookkeeping that isn't needed (retired names stay). Emit
    `changed { repoId, worktreeId }`.

`WorktreeRemoveResult = { ok: true, removed: string[], keptBranch?: { name, head }, sessionErrors?: string[] }`.

Merged-by-tree targets: the row's `baseRef`, the branch's upstream (`<b>@{upstream}`), and the
detected default base, each refreshed with nothing (no fetch). A branch is merged into target `T`
when merging it changes nothing:

`PSEUDOCODE (justified, ≤3 lines):` prose can't pin which tree is compared to which
- `tree = git merge-tree --write-tree <T> <b>` (exit 0, first line)
- merged ⇔ `tree == git rev-parse <T>^{tree}`

### Selectors

- Worktree `name:` and bare names match `name` (display name or folder name) and also the folder
  basename; repo `name:` matches `name` and `displayName`. Everything else in
  `plugins/quirky.worktree/selector.ts` is unchanged.

### CLI

Back-link: [SC-14](logic.md#create), [SC-40](logic.md#metadata), [SC-61](logic.md#project-settings-and-the-plugin-surface).

`CONFIG:` `quirky.worktree` CLI commands (group `worktree`, alias `wt`)
- `list [--repo S] [--group G]`: table `ID NAME BRANCH STATUS PATH`.
- `create [<repo>] [<name>] [--repo S] [--name N] [--group G] [--base R] [--branch B] [--branch-name B] [--display-name N] [--comment T] [--parent-worktree S] [--no-parent] [--setup run|skip|inherit] [--trust-setup] [--agent K] [--prompt T] [--no-fallback] [--activate]`:
  two positionals = repo, name; one = name in the caller's project (or `--repo`); prints the
  worktree record, then each warning, the base-fallback message and setup outcome on its own line.
  Passes `createdBy: 'cli'`.
- `set <worktree> [--display-name N] [--comment T] [--workspace-status S] [--pin] [--unpin] [--unread] [--read] [--parent-worktree S] [--no-parent]`.
- `show <worktree>`: the record as `key: value` lines plus `children`.
- `rm <worktree> [--force] [--with-descendants] [--skip-archive] [--allow-failed-archive-hook]`:
  prints `removed <name>` and, when a branch was kept, `kept branch <b> at <head> (not merged); delete it with: quirky wt delete-branch <repo> <b> --head <head>`.
- `delete-branch <repo> <branch> --head H`.

`CONFIG:` `quirky.repo` CLI commands (group `repo`)
- `add <path> [--folder]`, `list`, `rm <repo>` (unchanged words), `clone <url> [--location P] [--name N]`,
  `create <name> [--location P]`, `scan <path> [--max-depth N] [--max-repos N]`,
  `import <path> [--group N] [--max-depth N] [--max-repos N]`, `show <repo>`,
  `set <repo> [--display-name] [--default-base] [--worktree-location] [--setup-policy ask|run-by-default|skip-by-default] [--agent-startup start-immediately|wait-for-setup] [--command-source shared-only|local-only|run-both] [--setup-script] [--archive-script]`,
  `trust-hooks <repo> [--kind setup|archive|all] [--ref <ref>]`,
  `group list|create <name> [--parent-path P]|rename <group> <name>|delete <group>|add <group> <repo>|remove <group> <repo>|collapse <group> [--expand]`
  (cli-command `words` such as `"group create"`).

A module command that needs `data.reason` in text mode catches the `RpcError` itself; JSON mode
relies on the kernel change.

### Window commands

`CONFIG:` `quirky.worktree` UI contributions
- `command` `new-worktree` with `args` `{ type: object, properties: { repo: { type: string } } }`:
  opens the create dialog with `repo` selected, else the open worktree's project, else the first.
- `keybinding` `new-worktree` on `mod+n`.
- The section's report carries `dialog: { kind: 'create', repoId } | null` while a dialog is open
  (SC-62).

### Settings

`CONFIG:` `quirky.worktree` settings (`contributes.setting`)
- `worktreesRoot` string, default `~/quirky/workspaces` (unchanged).
- `nestWorkspaces` boolean, default true.
- `branchPrefix` enum `git-username|custom|none`, default `git-username`.
- `branchPrefixCustom` string, default `""`.
- `confirmDelete` boolean, default true.

### Window

Back-link: [SC-3](logic.md#projects), [SC-25](logic.md#create)–[SC-28](logic.md#create), [SC-31](logic.md#setup-and-archive-hooks), [SC-33](logic.md#setup-and-archive-hooks), [SC-42](logic.md#metadata)–[SC-44](logic.md#metadata), [SC-53](logic.md#delete), [SC-57](logic.md#delete)–[SC-59](logic.md#delete).

- Every window mutation calls the same methods as the CLI, with `createdBy: 'window'` on create
  and `yes: true` on destructive calls after the window's own dialog.
- Create: on submit, add a pending row (local state) under the project; remember
  `JSON.stringify(context.getLayout().view)`; on success, if the current view's JSON equals it,
  `openView(SESSION_VIEW, { worktree })`, else toast "Created <name>"; show `baseFallback` in a
  "Workspace created from a local base" dialog with Got it. A `hooks-untrusted` error opens the
  trust dialog; Run hooks retries with `trustSetup: true`, Always trust calls `quirky.repo/trustHooks`
  with the error's `ref` then retries, Don't run retries with `setup: 'skip'`.
- The setup choice shows when `quirky.repo/hooks` for the project reports a setup script and the
  policy is ask; Create is disabled until chosen; the source badge is `quirky.yaml`, `orca.yaml`,
  `local settings`, or the joined form for run-both.
- Name placeholder: `quirky.worktree/suggestName`, refreshed when the dialog opens and after each
  create.
- Delete: when `confirmDelete` is on, the plugin's own dialog with the change count (from
  `quirky.git/status` file count; absent for folder workspaces) and the checkbox; Don't ask again
  calls `setting.set` for `confirmDelete` false and toasts the logic spec's sentence. The call
  passes `force: true` (the dialog warned). A refusal toasts "Failed to delete workspace <name>"
  with the message. A `keptBranch` adds a section notice with Delete branch, which calls
  `deleteBranch` with `yes: true`.
- Opening a worktree (row click) calls `set { unread: false }` when it is unread.
- Report (`report.ts`): `{ pinned: string[], groups: { id, name, collapsed, worktrees: WorkspaceReport[], projects: ProjectReport[] }[], projects: ProjectReport[] }`
  with `ProjectReport = { id, name, kind, worktrees: { id, name, branch, kind, primary, status, workspaceStatus, pinned, unread, parentId, depth, pending, removing, selected }[] }`;
  workspaces in tree order with `depth`; a group's `worktrees` are the folder workspaces of the group itself (repoId `group:<id>`), shaped like a project's. Pending rows appear with `pending: true` and no `id`
  beyond `pending:<name>`.

## Data models

Back-link: [Glossary](logic.md#glossary).

`SCHEMA:` protocol types (`packages/protocol/src/model.ts`)
- `Repo = { id, name, path, addedAt, kind: 'git'|'folder', displayName: string|null, groupId: string|null }`;
  `name` stays the folder basename.
- `Worktree = { id, repoId, path, branch: string|null, head, isMain, name, kind: 'git'|'folder', displayName: string|null, comment: string, status: 'todo'|'in-progress'|'in-review'|'done', pinned: boolean, unread: boolean, parentId: string|null, createdAt: number, createdBy: 'window'|'cli'|'api'|'external', baseRef: string|null, keepBranch: boolean, removing: boolean, groupId: string|null }`.
- `ProjectGroup = { id, name, parentPath: string|null, collapsed: boolean, order: number, createdFrom: 'manual'|'folder-scan', repoIds: string[] }`.
- `ProjectSettings = { defaultBase: string|null, worktreeLocation: string|null, setupPolicy: 'ask'|'run-by-default'|'skip-by-default', agentStartup: 'start-immediately'|'wait-for-setup'|null, commandSource: 'shared-only'|'local-only'|'run-both'|null, setupScript: string, archiveScript: string }`.
- `EffectiveHooks = { file: 'quirky.yaml'|'orca.yaml'|null, setup: HookScript|null, archive: HookScript|null, agentStartup, sharedDirectories: string[], warnings: string[] }`,
  `HookScript = { text, source: 'shared'|'local'|'both', badge: string, shared: { text, hash, trusted, changed }|null }`.
- `RepoDetails = { repo: Repo, settings: ProjectSettings, hooks: EffectiveHooks }`.

`SCHEMA:` `quirky.repo` store, migration 2 (`plugins/quirky.repo`)
- `ALTER TABLE repos ADD COLUMN kind TEXT NOT NULL DEFAULT 'git'`; `display_name TEXT`;
  `group_id TEXT`; `settings TEXT NOT NULL DEFAULT '{}'` (JSON of `ProjectSettings` minus defaults).
- `CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_path TEXT, collapsed INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL, created_from TEXT NOT NULL, created_at INTEGER NOT NULL)`.
- `CREATE TABLE trusted_hooks (repo_id TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (repo_id, kind))`.

`SCHEMA:` `quirky.worktree` store, migration 2
- `worktrees` gains `kind TEXT NOT NULL DEFAULT 'git'`, `path TEXT`, `name TEXT`, `display_name TEXT`,
  `comment TEXT NOT NULL DEFAULT ''`, `status TEXT NOT NULL DEFAULT 'in-progress'`,
  `pinned INTEGER NOT NULL DEFAULT 0`, `unread INTEGER NOT NULL DEFAULT 0`, `parent_id TEXT`,
  `created_at INTEGER`, `created_by TEXT NOT NULL DEFAULT 'external'`, `base_ref TEXT`,
  `keep_branch INTEGER NOT NULL DEFAULT 0`, `birthtime INTEGER`, `group_id TEXT`, `created_root TEXT`
  (the resolved root the folder was created under; null for rows Quirky didn't create).
- `CREATE TABLE retired_names (repo_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (repo_id, name))`.
- v1 rows (id, repo_id only) keep defaults and get `birthtime` on first sight.

## DO-NOT-CHANGE fences

- **Existing store migrations** (`plugins/quirky.repo/main.ts:43-58`, `plugins/quirky.worktree/main.ts:44-58`):
  append only. Stores migrate forward by an ordered list and refuse a downgrade (m0-daemon-api D10);
  editing migration 1 breaks every existing home.
- **Worktree ID scheme** (`plugins/quirky.worktree/paths.ts:26-28`): sessions, layout and confirmations
  store these IDs ([D7](../../../loop/decisions/m1-worktrees.md)).
- **v1 import** (`readV1Rows` in both plugins, `importV1Root`): v1 homes must still import (m0-core D14).
- **Kernel dispatch, confirmation and request IDs** (`packages/daemon/src/plugins/dispatch.ts`,
  `confirm.ts`, `requests.ts`): locked by m0-core D19, D20; this item uses them as they are.
- **`plugins/test/imports.test.ts`**: the public-API fence; plugins import only `@quirky/protocol`,
  runtime builtins and their own declared dependencies. Don't widen it.
- **`quirky.session` launch and records** beyond `create`'s two params: m1-providers (lane 1) is
  reshaping agent launch in parallel; touch only `create`'s title and argv choice and the manifest's
  two properties.
- **`packages/git/src/index.ts` existing function signatures**: `quirky.git` and tests depend on them;
  add, don't change (`listWorktrees` only gains a field).

## Always / Ask / Never

**Always**
- Route every create and remove, from any surface, through `quirky.worktree/create` and `remove`.
- Refuse before any git mutation for every create refusal in steps 1-5.
- Spawn git with an args array through `packages/git/src/run.ts`; never a shell string.
- Single-quote paths put into a shell command (`command` for the Setup session), with `'` escaped.
- Keep every new method's params schema in the manifest within the schema subset
  (`packages/protocol/src/schema.ts:20-31`: no `oneOf`, no nullable types; leave a nullable field untyped).
- Mark read methods `readOnly: true`.
- Use real git in tests of create, remove, set, list and hooks.

**Ask** (record a decision; the loop answers itself)
- Changing a logic-spec message text.
- Any change to a kernel file other than `packages/cli/src/main.ts` JSON errors and
  `packages/ui/src/styles.css`.

**Never**
- Delete a folder Quirky can't show it created (no row, or outside its root).
- Run a shared script whose hash isn't trusted without `trustSetup`.
- Use `git branch -D`, or delete a branch without the expected-head guard.
- Edit `~/.gitconfig` or any global config; only repo-local config, as listed in step 8.
- Read or write the real `~/.quirky`, `~/.claude`, `~/.codex` in tests.

## Cross-cutting

- **Security:** shared hooks are trusted by content hash per project and kind; local scripts are the
  user's own. Hook processes get no stdin and a process group that is killed on timeout. Paths are
  confined to the worktrees root by `ensureInside` (resolve both with `resolveRealPath`, then
  `contains`, `paths.ts:31-33`).
- **Concurrency:** creates are queued per repo; removes join per worktree; branch cleanup is
  serialised per repo. The queue is in memory, so a daemon restart drops queued creates (their
  callers see a lost connection and retry with the same request ID, which the kernel records only
  for completed calls).
- **Observability:** `context.log` on background fetch failures, metadata rows discarded by the
  birth-time check, and carried-file warnings.
- **Migration:** both stores add migration 2 with defaults; no data is rewritten.
- **Rollback:** reverting the code leaves migration-2 columns that migration 1 code ignores, but the
  store refuses to open at a lower version; a rollback needs a fresh home. Recorded, not mitigated.
- **Platform:** macOS only ([D52](../../../loop/decisions/m1-worktrees.md)); `birthtimeMs` and
  `/bin/bash` are macOS assumptions.

## Testing strategy

Back-link: [Behavior & scenarios](logic.md#behavior--scenarios).

- **Fixtures:** `plugins/quirky.worktree/test/fixtures/repos.ts`: `makeOrigin()`, `makeProject({ origin?, files?, ignored? })`,
  `git(cwd, ...args)`, `gitEnv({ githubUser? })` writing a temp `GIT_CONFIG_GLOBAL` file (never the
  real one) with `GIT_CONFIG_NOSYSTEM=1`. Reuse `startPluginHarness` (`plugins/quirky.repo/test/harness.ts`)
  with `realGit: true`; with the real `quirky.session` and fake PTY host where a scenario needs
  Setup sessions (`plugins/quirky.session/test/support.ts` shows the set-up).
- **Scenario files**, each test named with its `SC-n`:
  - `plugins/quirky.repo/test/projects.test.ts` (SC-1 to SC-9, SC-34, SC-35, SC-60 CLI half)
  - `plugins/quirky.repo/test/groups.test.ts` (SC-10, SC-11)
  - `plugins/quirky.worktree/test/folder.test.ts` (SC-12, SC-13)
  - `plugins/quirky.worktree/test/create.test.ts` (SC-14 to SC-24, SC-27 API half)
  - `plugins/quirky.worktree/test/setup.test.ts` (SC-29, SC-30, SC-32, SC-35 to SC-39)
  - `plugins/quirky.worktree/test/metadata.test.ts` (SC-40, SC-41, SC-45)
  - `plugins/quirky.worktree/test/delete.test.ts` (SC-46 to SC-56, SC-59 API half)
  - `plugins/quirky.worktree/test/cli-scenarios.test.ts`: CLI-labelled scenarios through
    `spawnCli` (`packages/cli/test/fixtures/fake-daemon.ts:554`) against a real daemon, or
    `testCliContext` (`plugins/quirky.repo/test/harness.ts`) where a subprocess adds nothing.
  - `plugins/quirky.worktree/test/window.test.ts`: the UI scenarios (SC-3, SC-8, SC-25 to SC-28,
    SC-31, SC-33, SC-42 to SC-44, SC-53, SC-57 to SC-59, SC-60 UI half) through
    `packages/ui/test/fixtures/headless-window.ts` `startHeadlessWindow` against a real daemon with
    the real plugins, asserting DOM and `ui.state` reports.
  - `packages/daemon/test/plugins/cli-catalog.test.ts` or a new file for SC-61.
- **Unit tests:** `naming.ts` (sanitise table, prefix normalisation), `names.ts` (pool exhaustion
  tiers), `base.ts` (resolution order), `hooks.ts` (policy, merge, trust, warnings), `branches.ts`
  (merge-tree check) with real git; `report.ts` with the grown shape.
- **Existing tests to update** (intended behaviour changes, not regressions):
  `plugins/quirky.worktree/test/worktree.test.ts` (create's name regex → sanitiser; `addWorktree`
  args; remove order now preflight-then-close, which replaces "git decides first"),
  `lifecycle.test.ts`, `cli.test.ts`, `ui.test.ts`, `ui-report.test.ts`, `selectors.test.ts`
  where they assert `name === branch` or v1 output. Each changed assertion cites the decision
  (D8, D10, D14, D42) in the test name or a why-comment.
- **Orca defects** ([D51](../../../loop/decisions/m1-worktrees.md)): SC-2, SC-20/SC-27, SC-28, SC-30,
  SC-32, SC-56 carry "Orca defect" in their test names.
- **Bar:** `bun run test`, `bun test scripts`, `bun run typecheck` pass; every SC-n has a named test;
  UI scenarios pass `quirk:using-apps-like-a-user` against a built UI.

## Non-goals

- Everything in the logic spec's [Scope & non-goals](logic.md#scope--non-goals).
- A file-dialog API in the desktop shell, toast actions or confirm checkboxes in the kernel's UI API
  (the plugin renders its own dialogs and notices).
- Background fetch scheduling, the prepared-checkout pool, and persistence of in-flight creates or
  removes across a daemon restart.
- Changes to `quirky.session` beyond `create`'s `title` and `command`.
