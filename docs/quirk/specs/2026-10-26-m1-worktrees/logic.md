# Worktrees: metadata, create and delete, setup scripts, folder workspaces, project groups

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m1-worktrees.md](../../../loop/decisions/m1-worktrees.md)). Tech spec: requested; authored as [tech.md](tech.md) (gate: requested, crosses subsystems).

**Amendments:**
- 2026-10-26, before build: Codex adversarial review. A create naming a project but no name uses `--repo` (one positional is always the name; SC-18, SC-21); a create from an existing branch with no name takes its folder from the branch (SC-18); an explicit `--setup skip` gives no warning, only an inherited skip does (SC-30); a wait-for-setup create returns with the agent pending (SC-38); an orphan stays deletable after a list, and Force deletes only inside the folder it was created under (SC-54); Mod+N opens the create dialog, also through the API (SC-62).
- 2026-10-30: Deleting a workspace also removes its bound view tabs from shared, per-window and auxiliary layouts. Selection follows a surviving workspace-bound fallback or clears; global views and unrelated workspaces remain.
- 2026-10-31: Generated workspace names exclude `sperm`, the ambiguous truncation of “sperm whale”, from suggestions and blank-name creates, including numbered fallbacks. User-entered names and existing workspaces are unchanged.

## Conceptual model

Quirky organises work as **projects**, and each project holds **workspaces**. A project is a git
repository or a plain folder that Quirky knows about. A workspace in a git project is a
`git worktree` that Quirky creates, names, sets up, lists and later deletes. A workspace in a folder
project is a registration of that folder with no git behind it. Projects can sit in **groups**,
sidebar sections that hold several projects. This item brings that model from Orca
([worktrees.md](../../../../research/orca-features/worktrees.md))
onto the two built-in plugins v1 already moved into M0: `quirky.repo` owns projects, groups and
project settings, and `quirky.worktree` owns workspaces, their metadata, create, delete and the
setup and archive hooks ([D5](../../../loop/decisions/m1-worktrees.md)).

Three ideas carry it:

1. **Git says what exists, Quirky says what it means.** Which worktrees a repo has always comes from
   `git worktree list`. Quirky keeps what git can't: a display name, a note, a status (Todo, In
   progress, In review, Done), pinned and unread marks, a parent workspace, when and how it was
   made, its base, and whether its branch is the user's own. That metadata never attaches to a
   different worktree that later appears at the same path ([D6](../../../loop/decisions/m1-worktrees.md)).
2. **One create and one delete.** The window, the `quirky` CLI and any API client create through
   `quirky.worktree/create` and delete through `quirky.worktree/remove`, so naming, base fallback,
   setup and branch cleanup are the same everywhere. Orca keeps two create implementations that
   disagree on base fallback; Quirky has one.
3. **Scripts run only with consent.** A project's setup script runs when a workspace is made, and
   its archive script before one is deleted. A script that comes from the repo (`quirky.yaml`, or
   `orca.yaml` for repos set up for Orca) runs only when its exact content is trusted, from every
   surface, including the CLI ([D22](../../../loop/decisions/m1-worktrees.md)).

The roadmap requires that every flow can be scripted. Each flow below is a script against the
`quirky` CLI or the daemon API, and the window's dialogs call the same methods.

## Data flow

**Create.** A caller names a project (or lets the daemon infer it from its own worktree), a name
(or none, for a generated one), and optionally a base, an existing branch, a parent, a note, a setup
choice and an agent. The daemon resolves the project and its settings, then decides about setup
before touching git: it reads the hooks file at the commit the worktree will start from, merges it
with the project's local scripts, and refuses if the project's policy is "ask" and the caller gave
no choice, or if a shared script would run without being trusted. It resolves the base (requested,
the project's default, or the detected default branch), fetching a missing remote base and falling
back to the local branch with a notice when the fetch fails. It sanitises the name, adds a branch
prefix, and walks `name`, `name-2` and so on until a free branch and folder turn up. Creates in one
repo run one at a time. It runs `git worktree add`, records git config for the new branch, saves the
metadata, copies `.worktreeinclude` files and links shared directories, then starts setup in a
background "Setup" terminal and, if asked, an agent session (after setup, when the project says to
wait). It emits `quirky.worktree/changed` and returns the workspace with warnings, any base-fallback
notice and the IDs of the sessions it started.

**Delete.** A caller names a workspace. The kernel confirms through an ask unless the call passes
`yes` (the window asks with its own dialog and passes `yes`). The daemon refuses the primary
checkout, a locked worktree, a parent whose children weren't included, and, unless forced, one with
uncommitted or untracked changes. It runs the archive script, closes the workspace's sessions,
removes the worktree with git, deletes the branch only if git shows its work is merged (else keeps
it and reports it), drops the metadata and emits `quirky.worktree/changed`. After the row is dropped,
the daemon removes tabs bound to that workspace from the shared layout, each window override and
auxiliary routes. A removed active view falls back to the last remaining tab or none. If the layout
selected the deleted workspace, selection follows the fallback only when it belongs to another
workspace; otherwise selection clears. Unrelated workspaces and global views remain open. The call
returns when all of that is done.

**Edit.** `quirky.worktree/set` changes metadata and emits `quirky.worktree/changed`. Every list
joins git's worktrees with the stored metadata. The sidebar section re-reads on each event and
reports the tree it shows to `quirky ui state`.

**Projects and groups.** `quirky.repo` adds a git repo or a plain folder, clones a URL, initialises
a new repo, scans a folder for repos and imports them (optionally as a group), keeps groups and
project settings, and emits `quirky.repo/changed`. Removing a project closes its sessions and drops
its workspaces' metadata; the folder stays on disk.
In manual project order, new projects follow the existing ordered projects in registration order.
The sidebar refreshes that order when projects change, so the live order matches the restored order
after restart.

## Key decisions

- Extend `quirky.repo` and `quirky.worktree` rather than adding a plugin or storing metadata in git
  config ([D5](../../../loop/decisions/m1-worktrees.md)).
- Keep v1's `wt_` path-hash IDs ([D7](../../../loop/decisions/m1-worktrees.md)) and grow the worktree
  record additively ([D8](../../../loop/decisions/m1-worktrees.md)).
- Orca's naming, prefix, collision, base and fallback rules, with one fallback rule for every caller
  ([D9](../../../loop/decisions/m1-worktrees.md)–[D16](../../../loop/decisions/m1-worktrees.md)).
- Shared hooks from `quirky.yaml` or `orca.yaml`, trusted by content hash on every surface
  ([D19](../../../loop/decisions/m1-worktrees.md), [D22](../../../loop/decisions/m1-worktrees.md)).
- Setup in a "Setup" terminal through a small growth of `quirky.session/create`
  ([D23](../../../loop/decisions/m1-worktrees.md), [D24](../../../loop/decisions/m1-worktrees.md)).
- The archive hook runs on every delete unless skipped ([D37](../../../loop/decisions/m1-worktrees.md)),
  and deletes finish before returning ([D41](../../../loop/decisions/m1-worktrees.md)).

Success is the scenarios below passing as scripts against a real `quirkyd`, the window scenarios
passing when used like a user, and the six Orca defects of
[D51](../../../loop/decisions/m1-worktrees.md) each having a test showing Quirky doesn't have them.

## Behavior & scenarios

Fixtures are illustrative. Every scenario runs against a fresh temporary `QUIRKY_HOME` with a real
`quirkyd` and the built-in plugins from `plugins/`, driven through the `quirky` CLI or the daemon
API as it says. Repos are temporary git repositories with real git. "(UI)" scenarios are also run
in the window when used like a user.

Most scenarios use project **api** at `/tmp/w/api` (branch `main`), whose `origin` is a local bare
repository `/tmp/w/origin.git` with `main`; the worktrees folder `/tmp/w/ws`; and git config
`github.user = zoe`. The worktree **fix-login** is at `/tmp/w/ws/api/fix-login` on branch
`zoe/fix-login`.

### Projects

1. **SC-1: adding a git repo lists its primary workspace first** (CLI)
   - **Given** project **api** not yet added
   - **When** the agent runs `quirky repo add /tmp/w/api` then `quirky wt list --repo api --json`
   - **Then** the project is listed with kind git, and its only workspace is the primary checkout: `isMain` true, kind git, name `main` (its branch), status in-progress. Adding the same repo again returns the existing project.
   - **Data before:** **Projects**: none
   - **Walkthrough:**
     1. The agent adds `/tmp/w/api`
     2. The agent lists its workspaces
   - **Data after:** **Project api**: ✓ kind git; **Workspace main**: ✓ primary, path `/tmp/w/api`, branch `main`

2. **SC-2: the CLI adds a plain folder with `--folder` and says so when it is missing** (CLI; Orca defect)
   - **Given** a non-git folder `/tmp/w/notes` holding `notes.txt`
   - **When** the agent runs `quirky repo add /tmp/w/notes`, then `quirky repo add /tmp/w/notes --folder`
   - **Then** the first fails with "not a git repository: /tmp/w/notes; pass --folder to add it as a folder project" and exit 1; the second adds a folder project with one primary workspace on `/tmp/w/notes`, kind folder, branch null
   - **Data before:** **Projects**: none
   - **Walkthrough:**
     1. `repo add /tmp/w/notes` ✗ refused with the `--folder` hint
     2. `repo add /tmp/w/notes --folder`
   - **Data after:** **Project notes**: ✓ kind folder; **Workspace notes**: ✓ primary, kind folder; **/tmp/w/notes**: unchanged

3. **SC-3: adding a plain folder in the window offers Open as Folder** (UI)
   - **Given** the window open with no projects
   - **When** the person opens Add project, enters `/tmp/w/notes` and adds it
   - **Then** a dialog says "This folder isn't a Git repository. You'll have the editor, terminal, and search, but Git-based features won't be available." with Cancel and Open as Folder; Open as Folder adds the project with one workspace, and opening that workspace starts a shell in the folder

4. **SC-4: clone from a URL puts the repo in the worktrees folder and adds it** (CLI)
   - **Given** the bare repository `/tmp/w/origin.git`
   - **When** the agent runs `quirky repo clone /tmp/w/origin.git`, then runs it again
   - **Then** the first clones into `/tmp/w/ws/origin` and adds it as project **origin**; the second fails because `/tmp/w/ws/origin` exists, and nothing changes
   - **Data before:** **/tmp/w/ws/origin**: absent
   - **Walkthrough:**
     1. The agent clones `/tmp/w/origin.git`
     2. The agent clones it again ✗ refused, destination exists
   - **Data after:** **Project origin**: ✓ path `/tmp/w/ws/origin`, primary on `main`

5. **SC-5: create a new project initialises a repo, and a worktree in it says it has no commits** (CLI)
   - **Given** no folder `/tmp/w/ws/scratch`
   - **When** the agent runs `quirky repo create scratch`, then `quirky wt create scratch first`
   - **Then** `/tmp/w/ws/scratch` is a new git repository on git's default branch, added as project **scratch**; the worktree create fails with "scratch has no commits yet" and creates nothing

6. **SC-6: scanning a folder finds its repos within the depth and skip rules** (CLI)
   - **Given** `/tmp/w/apps` holding repos `web` and `cli`, a repo `deep` four levels down, a repo inside `node_modules/pkg`, and a repo `web/vendored` inside `web`
   - **When** the agent runs `quirky repo scan /tmp/w/apps --json`
   - **Then** it lists `web` and `cli` only: `deep` is past depth 3, `node_modules` is skipped, and the scan doesn't descend into `web`. With `--max-depth 4` it also lists `deep`.

7. **SC-7: importing a folder of repos as a group** (CLI)
   - **Given** `/tmp/w/apps` holding repos `web` and `cli`, with `cli` already added
   - **When** the agent runs `quirky repo import /tmp/w/apps --group apps --json`
   - **Then** the result reports `web` imported, `cli` already known, none failed, with counts; a group **apps** exists with parent folder `/tmp/w/apps` and holds both projects
   - **Data before:** **Projects**: cli; **Groups**: none
   - **Walkthrough:**
     1. The daemon scans `/tmp/w/apps` and finds `web`, `cli`
     2. It adds `web` ✓; `cli` already known
     3. It creates group **apps** and puts both in it
   - **Data after:** **Group apps**: ✓ parent `/tmp/w/apps`, projects web, cli; **Result**: imported 1, already known 1, failed 0

8. **SC-8: adding a folder of repos in the window offers to group them** (UI)
   - **Given** the window open, and `/tmp/w/apps` holding repos `web` and `cli`
   - **When** the person adds `/tmp/w/apps`
   - **Then** a dialog says "Found 2 repositories in /tmp/w/apps" and asks "Group these repositories?" with a Group name field, "Yes, import as group" and "No, import separately"; choosing the first shows a group section **apps** holding both projects, and the second shows them ungrouped

9. **SC-9: removing a project leaves its folder and closes its terminals** (API, UI)
   - **Given** project **api** with worktree **fix-login**, one shell session in each workspace, and a display name set on **fix-login**
   - **When** the person chooses Remove Project in the window, or an agent calls `quirky.repo/remove`
   - **Then** the window first says "This only removes api from Quirky. It is still on your disk. 2 open terminals in this project will be closed." with Cancel and Remove; after removal both sessions are closed, the project is gone from `repo list`, `/tmp/w/api` and `/tmp/w/ws/api/fix-login` are still on disk, and adding **api** again shows **fix-login** with no display name

### Groups

10. **SC-10: groups are created, filled, renamed, collapsed and deleted** (CLI, UI)
    - **Given** projects **api** and **web**, no groups
    - **When** the agent runs `quirky repo group create backend`, `group add backend api`, `group add backend web`, `group rename backend services`, `group collapse services`, `group remove services web`, then `group delete services`
    - **Then** after each step `quirky repo group list --json` shows it: a project is in at most one group, adding it to another moves it, and deleting the group leaves both projects ungrouped. The sidebar shows a collapsible section per group with its projects, and the section's report carries the same tree.
    - **Data before:** **Groups**: none
    - **Walkthrough:**
      1. Create **backend**; add api, web
      2. Rename it **services**; collapse it
      3. Take web out; delete **services**
    - **Data after:** **Groups**: none; **Projects api, web**: ✓ ungrouped, still added

11. **SC-11: a scanned group can hold a folder workspace on its parent folder** (CLI)
    - **Given** group **apps** from SC-7, with parent folder `/tmp/w/apps`
    - **When** the agent runs `quirky wt create --group apps apps-root`, opens a shell session in it, then deletes it with `--yes`
    - **Then** the workspace is kind folder on `/tmp/w/apps`, listed in group **apps**, and the shell starts in `/tmp/w/apps`; deleting it forgets it and leaves every file in `/tmp/w/apps`. A group without a parent folder refuses `--group`.

### Folder workspaces

12. **SC-12: a folder project's workspaces share the folder and delete without touching it** (CLI)
    - **Given** folder project **notes** from SC-2
    - **When** the agent runs `quirky wt create notes drafts`, opens a shell in **drafts**, then `quirky wt rm drafts --yes`
    - **Then** **drafts** is a second workspace of kind folder with its own ID and path `/tmp/w/notes`, no file or folder is created, the shell starts in `/tmp/w/notes`, and removing **drafts** forgets it and closes its shell while `/tmp/w/notes` keeps `notes.txt`. The primary folder workspace can't be removed.
    - **Data before:** **Workspaces of notes**: notes (primary)
    - **Walkthrough:**
      1. The agent creates **drafts** in **notes**
      2. The agent removes **drafts**
    - **Data after:** **Workspaces of notes**: notes (primary); **/tmp/w/notes**: ✓ unchanged

13. **SC-13: source control on a folder workspace says git is unavailable** (API, UI)
    - **Given** folder workspace **notes**
    - **When** an agent calls `quirky.git/status --worktree notes`, and the person opens the source control panel on **notes**
    - **Then** the call fails with InvalidParams "Opened as folder. Git features are unavailable for this workspace." and the panel shows the same sentence instead of an error

### Create

14. **SC-14: a create with just a name uses the defaults** (CLI)
    - **Given** project **api** with `origin/HEAD` pointing at `origin/main`, and no setup script
    - **When** the agent, outside any worktree, runs `quirky wt create api fix-login --json`
    - **Then** the worktree is at `/tmp/w/ws/api/fix-login` on a new branch `zoe/fix-login` cut from `origin/main` with no upstream; it is listed with name `fix-login`, status in-progress, created by cli, base `origin/main`, no parent; the repo's config has `branch.zoe/fix-login.base` set and `push.autoSetupRemote` true; and the window's open view is unchanged
    - **Data before:** **api worktrees**: main
    - **Walkthrough:**
      1. The daemon detects the base: `origin/HEAD` → `origin/main`
      2. Name `fix-login`, prefix `zoe` → branch `zoe/fix-login`
      3. Folder `/tmp/w/ws/api/fix-login`; `git worktree add --no-track -b zoe/fix-login`
    - **Data after:** **Worktree fix-login**: ✓ branch `zoe/fix-login`, base `origin/main`, status in-progress, created by cli

15. **SC-15: names are sanitised and can't leave the worktrees folder** (API)
    - **Given** project **api**
    - **When** an agent creates worktrees named `Fix Login: ünïcode!`, `../../etc`, `🦀🦀` and `...`
    - **Then** they get folders and branch names `Fix-Login-ünïcode`, `etc`, `workspace`; the last is refused with "Invalid worktree name" and creates nothing. Every folder is inside `/tmp/w/ws/api`.
    - **Data before:** **Names typed**: `Fix Login: ünïcode!`; `../../etc`; `🦀🦀`; `...`
    - **Walkthrough:**
      1. Runs of other characters become `-`, `--` and `..` collapse, ends are trimmed
      2. Only emoji → `workspace`; an empty result ✗ refused
    - **Data after:** **Folders**: ✓ `Fix-Login-ünïcode`; ✓ `etc`; ✓ `workspace`; ✗ `...` refused

16. **SC-16: taken names get the next free suffix** (API)
    - **Given** project **api** with branch `zoe/fix-login` existing on the remote only, and a folder `/tmp/w/ws/api/fix-login-2` already on disk
    - **When** an agent creates `fix-login`, then creates `other` with branch name `main` (`--branch-name main`)
    - **Then** the first gets folder `fix-login-3` and branch `zoe/fix-login-3`; the second fails with "Branch main already exists" because an explicit branch name is reused only when it points at the base and isn't checked out elsewhere, and `main` is checked out in the primary; nothing is created
    - **Data before:** **Branches**: `origin/zoe/fix-login`; **Folders**: `/tmp/w/ws/api/fix-login-2`
    - **Walkthrough:**
      1. `fix-login`: branch exists on a remote → skip
      2. `fix-login-2`: folder exists → skip
      3. `fix-login-3`: free ✓
    - **Data after:** **Worktree fix-login-3**: ✓ branch `zoe/fix-login-3`

17. **SC-17: the branch prefix follows the setting** (CLI)
    - **Given** project **api**
    - **When** the agent sets `branchPrefix` to none and creates `a`, sets it to custom with `team/` and creates `b`, then sets custom to `bad prefix` and creates `c`
    - **Then** `a` gets branch `a`, `b` gets `team/b`, and `c` fails with "Branch prefix \"bad prefix\" contains characters git rejects — update it in Settings" and creates nothing. With git-username and no `github.user`, `user.username` or branch-safe `user.name`, no prefix is applied.

18. **SC-18: creating from an existing branch checks it out and keeps it** (CLI)
    - **Given** project **api** with local branch `feat/passing`, remote-only branch `origin/feat/remote`, and `main` checked out in the primary
    - **When** the agent runs `quirky wt create --repo api --branch feat/passing`, `quirky wt create --repo api --branch feat/remote`, then `quirky wt create --repo api --branch main`
    - **Then** with no name given the folder comes from the branch, sanitised (`/` becomes `-`), and takes the next free suffix if taken: the first worktree is at `/tmp/w/ws/api/feat-passing` on `feat/passing`, marked to keep its branch, with name `feat-passing`; the second makes local `feat/remote` tracking `origin/feat/remote`; the third fails naming `/tmp/w/api` as where `main` is checked out
    - **Data after:** **Worktree feat-passing**: ✓ branch `feat/passing`, keeps branch; **Worktree feat-remote**: ✓ branch `feat/remote`, upstream `origin/feat/remote`

19. **SC-19: the base is requested, saved or detected, and its absence is an error before git runs** (CLI)
    - **Given** four repos: **a** with `origin/HEAD` → `origin/develop`; **b** with no remote and branch `main`; **c** with no remote and only branch `trunk`; **d** like **b** with the project default base set to `release`
    - **When** the agent creates a worktree in each without `--base`, then one in **c** with `--base trunk`
    - **Then** **a** branches from `origin/develop`, **b** from `main`, **d** from `release`; **c** fails with "Could not resolve a default base ref for this repo. Pass an explicit --base and try again." and creates nothing; with `--base trunk` it succeeds
    - **Data before:** **Repos**: a, b, c, d as above
    - **Walkthrough:**
      1. **a**: `origin/HEAD` target wins
      2. **b**: first of `origin/main`, `origin/master`, `main`, `master` that exists → `main`
      3. **c**: none exist ✗ refused
      4. **d**: the saved default `release` exists → used
    - **Data after:** **Bases**: ✓ a `origin/develop`; ✓ b `main`; ✗ c refused; ✓ d `release`

20. **SC-20: a remote base that can't be fetched falls back to the local branch with a notice** (CLI; Orca defect)
    - **Given** project **api** whose `origin` was repointed to a missing path after `origin/main` was deleted locally, with local `main` present
    - **When** the agent runs `quirky wt create api offline --base origin/main`, then `quirky wt create api offline2 --base origin/main --no-fallback`, and the window creates `offline3` the same way
    - **Then** the first is created from local `main` and prints "The remote-tracking ref origin/main was unavailable, so Quirky used local main instead. This workspace may not include the latest remote changes."; the second fails with "Could not refresh base ref \"origin/main\" from \"origin\". Check your network and try again." and creates nothing; the window's create falls back exactly as the first did and shows the notice in a "Workspace created from a local base" dialog with Got it
    - **Data before:** **origin/main**: absent locally; **origin**: unreachable; **main**: present
    - **Walkthrough:**
      1. `origin/main` missing → fetch `origin` ✗ fails
      2. Fallback allowed, local `main` exists → create from `main`, notice
      3. With `--no-fallback` ✗ error
    - **Data after:** **Worktree offline**: ✓ base `main`, notice; **Worktree offline2**: ✗ not created; **Worktree offline3**: ✓ base `main`, same notice

21. **SC-21: a blank name gets a generated name that is never reused** (CLI)
    - **Given** project **api**
    - **When** the agent runs `quirky wt create --repo api` twice, deletes the first worktree, then runs `quirky wt create --repo api` 30* more times
    - **Then** each worktree gets a different marine-creature name (such as `narwhal`*), and none of the later ones reuses the deleted worktree's name. A typed name that was used and deleted can be used again.

22. **SC-22: two creates of one name at once both succeed** (API)
    - **Given** project **api**
    - **When** two clients create `race` in **api** at the same moment
    - **Then** both succeed, one as `race` and one as `race-2`, and `git worktree list` shows both. A retry of either call with its request ID returns its first result.

23. **SC-23: inside a worktree, one positional is the name and the caller becomes the parent** (CLI)
    - **Given** a shell session in **fix-login** (so `QUIRKY_WORKTREE_ID` names it)
    - **When** the agent runs `quirky wt create child-a`, `quirky wt create child-b --no-parent`, and `quirky wt create`
    - **Then** all three are in project **api**; `child-a` and the generated one have parent **fix-login**, `child-b` has none; `quirky wt show fix-login` lists the two children

24. **SC-24: a CLI create opens the new worktree only with `--activate`** (CLI)
    - **Given** the window showing **main**
    - **When** the agent runs `quirky wt create api quiet`, then `quirky wt create api loud --activate`
    - **Then** after the first the window still shows **main**; after the second `quirky ui state` shows **loud**'s session view

25. **SC-25: a window create shows a pending row, then opens the result only if you stayed** (UI)
    - **Given** the window showing **main**, and project **big** whose checkout takes a few seconds* (many files)
    - **When** the person creates `slow` in **big** and waits, then creates `slow2` in **big** and opens **main** before it finishes
    - **Then** a pending row named `slow` shows under **big** while it runs, then **slow** opens; for `slow2` the window stays on **main** and a toast names **slow2**

26. **SC-26: Create more keeps the dialog open and resets it** (UI)
    - **Given** the create dialog with Create more on, a name typed, an agent chosen and the setup choice answered
    - **When** the person presses Create
    - **Then** the worktree is created, the dialog stays open with the name, agent and setup choice cleared, and Create more still on

27. **SC-27: the window and the CLI create the same worktree from the same input** (API, UI; Orca defect)
    - **Given** two identical copies of project **api**, **api1** and **api2**, both with an unreachable `origin`, local `main`, and setup policy run by default with a local script
    - **When** the person creates `same` in **api1** from the window, and the agent runs `quirky wt create api2 same` from outside any worktree
    - **Then** both get folder `same`, branch `zoe/same`, base `main` with the same fallback notice, the same status, and a Setup session; they differ only in created by (window, cli) and project

28. **SC-28: a blank name in the window still creates** (UI; Orca defect)
    - **Given** the create dialog open on **api** with the name left blank
    - **When** the person looks at Create and presses it
    - **Then** Create is enabled, the name field shows the generated name it will use as its placeholder, and pressing it creates a worktree with that name

### Setup and archive hooks

29. **SC-29: setup runs in a background Setup terminal with the hook environment** (CLI)
    - **Given** project **api** with policy run by default and the local setup script `echo "$QUIRKY_ROOT_PATH|$QUIRKY_WORKTREE_PATH|$QUIRKY_WORKSPACE_NAME|$ORCA_ROOT_PATH" > setup.txt`, and the window showing **main**
    - **When** the agent runs `quirky wt create api with-setup --json`
    - **Then** the result reports setup ran in a terminal with the Setup session's ID; a session titled "Setup" exists in **with-setup** and exits 0; `setup.txt` in the new worktree reads `/tmp/w/api|/tmp/w/ws/api/with-setup|with-setup|/tmp/w/api`; the window still shows **main**
    - **Data before:** **Project api**: setup policy run by default; local setup script as above
    - **Walkthrough:**
      1. The daemon creates the worktree
      2. It writes the runner script and starts a "Setup" shell session running it
    - **Data after:** **Session Setup**: ✓ in with-setup, exited 0; **setup.txt**: ✓ `/tmp/w/api|/tmp/w/ws/api/with-setup|with-setup|/tmp/w/api`

30. **SC-30: "ask" with no setup choice creates nothing and says how to answer** (CLI; Orca defect)
    - **Given** project **api** with policy ask and a local setup script
    - **When** the agent runs `quirky wt create api asked --json`, then `quirky wt create api asked --setup skip --json`
    - **Then** the first fails with a Conflict whose reason is `setup-decision-required` (the JSON error carries it, not a generic code) and whose message says "Setup decision required for this repository; pass --setup run or --setup skip", and no branch or folder exists; the second creates the worktree and runs nothing, with no warning since skipping was asked for. With the policy set to skip by default instead, `quirky wt create api skipped` creates it, runs nothing, and warns "setup hook skipped for /tmp/w/ws/api/skipped; pass --setup run to run it."

31. **SC-31: the window asks for the setup choice before it will create** (UI)
    - **Given** project **api** with policy ask and a local setup script
    - **When** the person opens the create dialog on **api** and expands Advanced
    - **Then** Advanced shows "Setup script" with the badge "local settings", "Wait for setup to complete before starting agent", and "Run setup now?" with Run setup now and Skip for now; Create stays disabled until one is chosen; after Run setup now and Create, a Setup tab appears in the new worktree

32. **SC-32: an untrusted shared script never runs from the CLI without consent** (CLI; Orca defect)
    - **Given** project **api** whose `quirky.yaml` on `main` has `scripts: { setup: "touch ran.txt" }`, never trusted
    - **When** the agent runs `quirky wt create api t1`, then `quirky wt create api t2 --trust-setup`, then `quirky wt create api t3`, then `quirky repo trust-hooks api` and `quirky wt create api t4`, then commits a changed setup to `main` and runs `quirky wt create api t5`
    - **Then** `t1` fails before any git work with an untrusted-hooks error that shows the script and names `--trust-setup` and `quirky repo trust-hooks`; `t2` is created and runs it; `t3` fails like `t1`; `t4` is created and runs it; `t5` fails again because the content changed
    - **Data before:** **Trusted hashes of api**: none
    - **Walkthrough:**
      1. `t1` ✗ untrusted; `t2` ✓ run once; `t3` ✗ untrusted
      2. `repo trust-hooks api` stores the hash; `t4` ✓
      3. The script changes; `t5` ✗ untrusted
    - **Data after:** **Worktrees**: ✓ t2, t4 with `ran.txt`; ✗ t1, t3, t5 absent

33. **SC-33: the window asks before running an untrusted shared script** (UI)
    - **Given** the project of SC-32, untrusted
    - **When** the person creates a worktree with Run setup now
    - **Then** a dialog asks "Run setup from api?" with Run hooks, Don't run and Always trust; Don't run creates it without setup; Always trust creates it, runs setup, and the next create asks nothing; after the script changes the dialog asks "api's setup changed — run the new version?"

34. **SC-34: `quirky.yaml` wins over `orca.yaml`, and `repo show` reports the hooks** (CLI)
    - **Given** project **api** with only `orca.yaml` (`scripts.setup`, plus `issueCommand` and an unknown key `colour`), then with a `quirky.yaml` added beside it
    - **When** the agent runs `quirky repo show api --json` each time
    - **Then** the first reports the setup from `orca.yaml`, `issueCommand` as recognised but not supported yet, and `colour` as unrecognised; the second reports the setup from `quirky.yaml` and ignores `orca.yaml`

35. **SC-35: the command-source policy picks shared, local or both** (CLI)
    - **Given** project **api** with a trusted shared setup `echo shared >> order.txt` and a local setup `echo local >> order.txt`
    - **When** the agent creates a worktree with the policy unset, then with shared-only, then run-both
    - **Then** `order.txt` reads `local` (a local script exists, so unset means local-only), then `shared`, then `shared` and `local` in that order

36. **SC-36: a failing setup leaves the worktree in place** (CLI)
    - **Given** project **api** with local setup `exit 3`
    - **When** the agent creates `broken`
    - **Then** **broken** is created and listed, and its Setup session exits with code 3

37. **SC-37: with sessions off, setup runs in the daemon** (API)
    - **Given** `quirky.session` disabled, and project **api** with local setup `echo hi > hi.txt`
    - **When** an agent creates `headless`
    - **Then** the result reports setup ran in the daemon with exit code 0, and `hi.txt` exists in the new worktree. A setup that runs past 2 minutes is stopped and reported as timed out.

38. **SC-38: a create can start an agent, after setup when the project says to wait** (API)
    - **Given** project **api** with a local setup that sleeps 2* seconds, and agent startup policy wait for setup
    - **When** an agent creates `agented` with agent claude and prompt "fix the tests"
    - **Then** the create returns at once with the Setup session's ID and the agent marked pending; an agent session is created in **agented**, with that prompt, only after the Setup session exits (seen in `quirky session list` and a `quirky.session/changed` event), exactly once even if Setup exited before the create returned. With policy start immediately, the result names both sessions.

39. **SC-39: `.worktreeinclude` copies gitignored files and shared directories are linked** (CLI)
    - **Given** project **api** ignoring `.env*` and `cache/`, with `.env`, `.env.local` and `cache/` present in the primary, a tracked `README.md`, and `.worktreeinclude` listing `.env*`, `README.md` and `.git`; and `quirky.yaml` with `worktree.sharedDirectories: [cache, docs, ../out]`
    - **When** the agent creates `carried`
    - **Then** the new worktree has copies of `.env` and `.env.local`, its `README.md` is git's checkout and not a copy, nothing of `.git` is copied, `cache` is a symlink to the primary's `cache`, `docs` (not ignored) and `../out` (outside) are skipped with warnings, and the create succeeds
    - **Data before:** **Primary**: `.env`, `.env.local`, `cache/` (ignored); `README.md` (tracked)
    - **Walkthrough:**
      1. Patterns `.env*` → `.env`, `.env.local` ✓ copied; `README.md` ✗ not ignored; `.git` ✗ never
      2. Shared `cache` ✓ linked; `docs` ✗ not ignored; `../out` ✗ outside
    - **Data after:** **Worktree carried**: ✓ `.env`, `.env.local` copied; ✓ `cache` → primary `cache`; **Warnings**: docs, ../out

### Metadata

40. **SC-40: display name, note, status, pin and unread are set and listed** (CLI)
    - **Given** worktree **fix-login**
    - **When** the agent runs `quirky wt set fix-login --display-name "Login fix" --comment "see the auth bug" --workspace-status in-review --pin --unread`, then `quirky wt set "Login fix" --display-name ""`, then `--workspace-status shipped`
    - **Then** after the first `wt list --json` shows name "Login fix", the comment, status in-review, pinned and unread, with branch and folder unchanged; the second clears the display name so the name is `fix-login` again; the third fails with InvalidParams listing the four statuses
    - **Data before:** **Worktree fix-login**: name `fix-login`, status in-progress
    - **Walkthrough:**
      1. Set display name, comment, status, pin, unread
      2. Clear the display name
      3. Unknown status ✗ refused
    - **Data after:** **Worktree fix-login**: ✓ name `fix-login`, comment "see the auth bug", status in-review, pinned, unread; branch `zoe/fix-login`

41. **SC-41: parents are set and cleared, and cycles are refused** (CLI)
    - **Given** worktrees **a**, **b** with parent **a**, and **c** with parent **b**
    - **When** the agent runs `wt set a --parent-worktree c`, `wt set a --parent-worktree a`, `wt set c --no-parent`, then `wt show a`
    - **Then** the first two fail because **c** is a descendant of **a** and a worktree can't be its own parent; the third clears **c**'s parent; `wt show a` lists **b** as its only child

42. **SC-42: Rename edits the display name and notes** (UI)
    - **Given** worktree **fix-login** in the window
    - **When** the person chooses Rename… from its menu, enters display name "Login fix" and notes, and saves
    - **Then** the dialog was titled "Workspace details" with Display Name ("Shown in the sidebar. The folder name stays the same."), notes and Save; the card now reads "Login fix", and `wt list` shows the same name and comment with branch and folder unchanged

43. **SC-43: status, pin and unread from the card menu** (UI)
    - **Given** worktrees **fix-login** and **docs** in the window, with **main** open
    - **When** the person moves **fix-login** to In review, pins it, and marks **docs** unread, then opens **docs**
    - **Then** **fix-login** shows an "In review" label and also appears in a Pinned section at the top; **docs** shows an unread marker until opened, after which `wt list` shows it read

44. **SC-44: the sidebar shows the tree and reports it** (UI)
    - **Given** group **services** holding **api** (primary **main**, **fix-login**, and **child** whose parent is **fix-login**) and an ungrouped folder project **notes**
    - **When** the window loads and an agent runs `quirky ui state --json`
    - **Then** the sidebar shows section **services**, project **api** with **main** first carrying a "primary" badge, **fix-login** with a "1 child" chip that collapses **child**, then project **notes**; the report carries the same groups, projects and workspaces with kind, status, pinned, unread, parent and primary
    - **Data before:** **Group services**: api; **api**: main, fix-login, child (parent fix-login); **notes**: ungrouped
    - **Walkthrough:**
      1. The section reads groups, projects and worktrees
      2. It nests child under fix-login
    - **Data after:** **Report**: ✓ group services → api → main (primary), fix-login → child; ✓ notes ungrouped

45. **SC-45: metadata survives a restart and never follows a reused path** (API)
    - **Given** worktree **fix-login** with display name "Login fix"
    - **When** the daemon restarts; then, outside Quirky, `git worktree remove` deletes **fix-login** and `git worktree add` makes a new worktree at the same path
    - **Then** after the restart the display name is still "Login fix"; after the outside remove the worktree is gone from `wt list`; the new worktree at that path lists with no display name and status in-progress

### Delete

46. **SC-46: deleting a clean worktree confirms, removes, and deletes its merged branch** (CLI)
    - **Given** worktree **fix-login** with no changes, its branch with no commits beyond `origin/main`, and a shell session in it
    - **When** the agent runs `quirky wt rm fix-login` and answers the confirmation ask Yes, and another agent runs `quirky wt rm docs --yes` on a similar worktree
    - **Then** each worktree's folder is gone, `git worktree list` lacks it, its branch is deleted, its session is closed, and `wt list` lacks it
    - **Data before:** **Worktree fix-login**: clean; **Branch zoe/fix-login**: no commits beyond `origin/main`; **Session**: shell, running
    - **Walkthrough:**
      1. The kernel asks; the agent answers Yes
      2. No changes, not locked; no archive script
      3. Session closed; `git worktree remove`; `git branch -d` ✓
    - **Data after:** **Worktree fix-login**: ✓ gone; **Branch**: ✓ deleted; **Session**: ✓ closed

47. **SC-47: changes block a delete unless forced, and nothing is stopped first** (CLI)
    - **Given** worktree **fix-login** with an untracked file and a running shell session
    - **When** the agent runs `quirky wt rm fix-login --yes`, then `quirky wt rm fix-login --yes --force`
    - **Then** the first fails with "Worktree has uncommitted or untracked changes." and the session is still running; the second deletes the worktree and closes the session

48. **SC-48: a locked worktree is refused even with force** (CLI)
    - **Given** worktree **fix-login** locked with `git worktree lock --reason "ci holds it"`
    - **When** the agent runs `quirky wt rm fix-login --yes`, `quirky wt rm fix-login --yes --force`, then unlocks it and runs the first again
    - **Then** both refusals say "This workspace is locked by Git. Git reported: ci holds it. Run git worktree unlock /tmp/w/ws/api/fix-login from its repository, then retry deletion."; after unlocking the delete succeeds

49. **SC-49: an unmerged branch is kept and can be deleted later only if it hasn't moved** (CLI)
    - **Given** worktree **fix-login** whose branch has one commit not in `origin/main`
    - **When** the agent runs `quirky wt rm fix-login --yes --json`, then `quirky wt delete-branch api zoe/fix-login --head <old head> --yes`; and, in a second run where a commit was added to the branch after the delete, the same delete-branch
    - **Then** the delete removes the worktree and reports the kept branch with its head; delete-branch then deletes it; in the second run delete-branch fails because the branch moved, and the branch stays
    - **Data before:** **Branch zoe/fix-login**: head `a1b2c3`*, 1 commit not in `origin/main`
    - **Walkthrough:**
      1. `git branch -d` refuses; the changes aren't in the base → keep
      2. Result: kept branch `zoe/fix-login` at `a1b2c3`*
      3. delete-branch with head `a1b2c3`* ✓ deleted
    - **Data after:** **Worktree fix-login**: ✓ gone; **Branch zoe/fix-login**: ✓ deleted (first run); ✗ kept, moved (second run)

50. **SC-50: a squash-merged branch is deleted** (CLI)
    - **Given** worktree **fix-login** whose two commits were squash-merged into `origin/main`
    - **When** the agent deletes it with `--yes`
    - **Then** the branch is deleted even though `git branch -d` refused it, and nothing is reported kept

51. **SC-51: a reused branch is kept on delete** (CLI)
    - **Given** worktree **feat-passing** from SC-18
    - **When** the agent deletes it with `--yes`
    - **Then** the worktree is gone and branch `feat/passing` still exists at the same commit

52. **SC-52: the archive hook runs before a delete and its failure stops it** (CLI)
    - **Given** project **api** with local archive script `echo "$QUIRKY_WORKTREE_PATH" >> /tmp/w/archived.txt`, and worktrees **x** and **y**; then the script replaced by `exit 1`
    - **When** the agent deletes **x** with `--yes`; after the replacement deletes **y** with `--yes`, then `--yes --force`, then `--yes --allow-failed-archive-hook`; and deletes a third worktree with `--yes --skip-archive`
    - **Then** **x**'s path is appended to `archived.txt` before **x** is gone; **y**'s first two deletes fail with an archive-hook-failed code, leaving **y** and its sessions intact; the third removes **y**; the skipped one runs no script. An untrusted shared archive script is refused as in SC-32.

53. **SC-53: a parent is deleted only with its descendants** (CLI, UI)
    - **Given** worktree **a** with child **b**, which has child **c**
    - **When** the agent runs `quirky wt rm a --yes`, then `quirky wt rm a --yes --with-descendants`; and in the window the person opens **a**'s menu
    - **Then** the first fails naming **b** and **c**; the second deletes **c**, then **b**, then **a**; the window's menu offers "Delete with Descendants (2)…", whose dialog warns "Child workspaces will be deleted"

54. **SC-54: orphaned worktrees are cleaned or refused** (CLI)
    - **Given** three worktrees made by Quirky: **gone** whose folder was deleted by hand, **forgot** which git no longer registers but whose folder remains, and a folder `/tmp/w/other` Quirky never made
    - **When** the agent runs `quirky wt list`, then deletes **gone** with `--yes`, **forgot** with `--yes`, then **forgot** with `--yes --force` (after the worktrees folder setting was changed to another folder), and calls remove on `path:/tmp/w/other`
    - **Then** **gone** is cleaned (pruned, metadata dropped, branch rules applied, no archive script); **forgot** is first refused with "Git already forgot this workspace, but its directory is still on disk. Use Force Delete to remove the orphaned directory." and then its folder is deleted, because it lies inside the folder it was created under even though the setting changed since; `/tmp/w/other` is refused and left alone. A worktree Quirky found rather than made (no record of where it was created) is never force-deleted this way.

55. **SC-55: concurrent deletes share one run** (API)
    - **Given** worktree **fix-login** with an archive script that sleeps 2* seconds
    - **When** two clients delete it with the same options at the same moment, a third deletes it with `force` while they run, and a fourth lists worktrees while they run
    - **Then** the first two both succeed from one run (the script ran once); the third fails with "Worktree deletion already in progress"; the list shows **fix-login** with removing true

56. **SC-56: a delete is finished when it returns** (API; Orca defect)
    - **Given** worktree **fix-login** with a merged branch
    - **When** an agent deletes it with `yes`, and as soon as the call returns the daemon is killed and restarted
    - **Then** after the restart the folder, the worktree registration, the branch and the metadata are all gone, and no delete is pending

57. **SC-57: the window's delete dialog warns, offers Don't ask again, and deletes a dirty worktree** (UI)
    - **Given** worktree **dirty** with one untracked file, and **locked** locked by git
    - **When** the person deletes **dirty** from its menu, ticks "Don't ask again" and confirms, then deletes **locked**
    - **Then** the dialog was titled "Delete Workspace" and said "Remove dirty from git and delete its workspace folder. Any uncommitted or untracked changes in Git workspaces will be permanently deleted." with the path and "1 uncommitted or untracked change", Cancel and Delete Workspace; **dirty** is gone; a toast said "We'll skip this confirmation next time. You can change this in Settings."; deleting **locked** showed no dialog and a "Failed to delete workspace locked" toast with the lock message

58. **SC-58: a kept branch can be deleted from the window** (UI)
    - **Given** worktree **fix-login** whose branch is unmerged
    - **When** the person deletes it
    - **Then** a toast says the branch `zoe/fix-login` was kept because it isn't merged, with a Delete branch action; using it deletes the branch

59. **SC-59: the primary checkout can't be deleted** (API, UI)
    - **Given** project **api**
    - **When** an agent removes **main** with `yes`, and the person opens **main**'s menu
    - **Then** the call fails with Conflict "the primary worktree cannot be deleted; remove the project instead", and the menu's Delete is disabled with that text as its tooltip

### Project settings and the plugin surface

60. **SC-60: project settings round-trip through `repo set` and the Project Settings dialog** (CLI, UI)
    - **Given** project **api**
    - **When** the agent runs `quirky repo set api --display-name API --default-base origin/develop --worktree-location ../api-ws --setup-policy ask --agent-startup wait-for-setup --command-source run-both --setup-script "make deps"`, then `quirky repo show api --json`; and the person opens Project Settings from the project's menu
    - **Then** `repo show` returns each value, the effective setup ("make deps" from local settings, plus any shared one) and trust state; the next worktree is created under `/tmp/w/api-ws`; the dialog shows the same values and saving a change there shows in `repo show`

61. **SC-61: the new methods and commands are listed with schemas** (CLI)
    - **Given** a running daemon
    - **When** the agent runs `quirky api --json`
    - **Then** it lists `quirky.worktree/set`, `quirky.worktree/deleteBranch` (destructive) and the grown `create` and `remove` params, and `quirky.repo/clone`, `create`, `scan`, `import`, `set`, `show`, `trustHooks` and the group methods, each with its params schema, and the CLI commands `wt set`, `wt show`, `wt delete-branch`, `repo clone`, `repo create`, `repo scan`, `repo import`, `repo set`, `repo show`, `repo trust-hooks` and `repo group …`

62. **SC-62: Mod+N and the API open the create dialog** (API, UI)
    - **Given** the window showing **fix-login**
    - **When** the person presses Mod+N, closes the dialog, then an agent runs `quirky ui run command:quirky.worktree/new-worktree --args '{"repo":"web"}'`
    - **Then** the first opens the create dialog with project **api** (the open worktree's) selected, and the second opens it with **web** selected; `quirky ui state` reports the dialog open with its project

## Scope & non-goals

In scope: worktrees.md flows 1, 2, 5, the metadata edits of flow 3, hooks and `orca.yaml`, folder
workspaces and project groups ([D3](../../../loop/decisions/m1-worktrees.md)). Out of scope, for
m7-parity-sweep unless a later item takes them:

- **Flow 2, the hosting part:** the Smart tab's PR, issue and URL search, the GitHub and GitLab tabs,
  linked issues and PRs, and the "PR already exists" collision check (m4-worktrees-create-from).
- **Flow 2, other parts:** "Keep Local Main Up to Date" and the "Local main is behind" toast, sparse
  checkout and its presets, the prepared-checkout pool, the issue command split, default tabs,
  environment recipes, model and effort on the agent field (m1-launch-settings), the per-project
  "Worktree Shared Paths" setting, Run on hosts.
- **Flow 3, other parts:** Sleep, keyboard switching (`Mod+J`, `Mod+1..9`, `Mod+Shift+Up/Down`),
  worktree history, Open in, linked work, custom statuses and the workspace board.
- **Flow 4:** the Workspace options menu: group by, sort by, project order, card layout, show
  properties, and every filter.
- **Flow 6:** the cleanup scan and Delete Inactive Workspaces.
- **Flow 7:** hidden external worktrees, their visibility settings and the Sources list.
- **Project identity extras:** icons, colours and avatars, Ledger staleness, MCP configs, Jira
  defaults, GitHub accounts, Available hosts.
- **Remote hosts:** SSH and WSL.
- **Native folder picker:** Add project takes a typed path in this item; Browse with the macOS Open
  panel waits for a desktop-shell file dialog API.
- **Platforms:** everything [D52](../../../loop/decisions/m1-worktrees.md) logs.

## Decisions Locked

**Organization**
- Extend `quirky.repo` and `quirky.worktree`, one create and one remove path ([D5](../../../loop/decisions/m1-worktrees.md)).
- Groups in `quirky.repo` ([D46](../../../loop/decisions/m1-worktrees.md)); group folder workspaces ([D47](../../../loop/decisions/m1-worktrees.md)); folder projects with `--folder` ([D43](../../../loop/decisions/m1-worktrees.md)).
- Project settings on the repo record ([D49](../../../loop/decisions/m1-worktrees.md)); global settings as plugin settings ([D50](../../../loop/decisions/m1-worktrees.md)).
- Parent inference from the caller ([D29](../../../loop/decisions/m1-worktrees.md)).

**Naming and duplicates**
- v1's IDs, random IDs for extra folder workspaces ([D7](../../../loop/decisions/m1-worktrees.md)).
- Folder layout ([D9](../../../loop/decisions/m1-worktrees.md)), sanitising ([D10](../../../loop/decisions/m1-worktrees.md)), prefixes ([D11](../../../loop/decisions/m1-worktrees.md)), suffixes ([D12](../../../loop/decisions/m1-worktrees.md)), generated names ([D17](../../../loop/decisions/m1-worktrees.md)).
- Per-repo create queue ([D27](../../../loop/decisions/m1-worktrees.md)).

**Data**
- Git is the source of truth; metadata never follows a reused path ([D6](../../../loop/decisions/m1-worktrees.md)).
- The grown worktree record ([D8](../../../loop/decisions/m1-worktrees.md)) and the create result ([D28](../../../loop/decisions/m1-worktrees.md)).

**Create**
- Existing branches ([D13](../../../loop/decisions/m1-worktrees.md)), base resolution ([D14](../../../loop/decisions/m1-worktrees.md)), fallback ([D15](../../../loop/decisions/m1-worktrees.md)), branch config ([D16](../../../loop/decisions/m1-worktrees.md)).
- `wt create [<repo>] [<name>]` ([D18](../../../loop/decisions/m1-worktrees.md)); agent start ([D25](../../../loop/decisions/m1-worktrees.md)); carried files ([D26](../../../loop/decisions/m1-worktrees.md)).
- Window behaviour ([D30](../../../loop/decisions/m1-worktrees.md), [D31](../../../loop/decisions/m1-worktrees.md)).

**Hooks**
- `quirky.yaml` or `orca.yaml` ([D19](../../../loop/decisions/m1-worktrees.md)); local scripts and source policy ([D20](../../../loop/decisions/m1-worktrees.md)); the setup decision ([D21](../../../loop/decisions/m1-worktrees.md)); trust ([D22](../../../loop/decisions/m1-worktrees.md)).
- The Setup terminal ([D23](../../../loop/decisions/m1-worktrees.md)) and session create's title and command ([D24](../../../loop/decisions/m1-worktrees.md)).

**Delete**
- Window dialog ([D35](../../../loop/decisions/m1-worktrees.md)); CLI refusals ([D36](../../../loop/decisions/m1-worktrees.md)); archive hook everywhere ([D37](../../../loop/decisions/m1-worktrees.md)); branch cleanup ([D38](../../../loop/decisions/m1-worktrees.md)); descendants ([D39](../../../loop/decisions/m1-worktrees.md)); orphans ([D40](../../../loop/decisions/m1-worktrees.md)); inline and joined ([D41](../../../loop/decisions/m1-worktrees.md)); order ([D42](../../../loop/decisions/m1-worktrees.md)).

**Visual**
- Sidebar tree ([D33](../../../loop/decisions/m1-worktrees.md)) and menus ([D34](../../../loop/decisions/m1-worktrees.md)); Remove Project dialog ([D48](../../../loop/decisions/m1-worktrees.md)).

**Projects**
- Clone and create ([D44](../../../loop/decisions/m1-worktrees.md)); scan and import ([D45](../../../loop/decisions/m1-worktrees.md)).

**Assumed — fast-tracked** ([D53](../../../loop/decisions/m1-worktrees.md)): `wt list` gains STATUS; `wt show` prints the full record with children; events keep their names with the affected IDs; the empty sidebar keeps "No repositories yet." with Add project.

## Industry Insights

- Keep app metadata outside git and reconcile against `git worktree list --porcelain`, which is
  stable across versions; path-keyed metadata needs a creation check or a new worktree at a reused
  path inherits it ([git-worktree](https://git-scm.com/docs/git-worktree),
  [Orca docs](https://www.onorca.dev/docs/model/worktrees)).
- Storing metadata in git config is fragile: `extensions.worktreeConfig` breaks older git and strict
  parsers, `config.worktree` goes on prune, and concurrent writes fail on `config.lock`
  ([Antigravity forum](https://discuss.ai.google.dev/t/antigravity-agent-becomes-unresponsive-in-repositories-with-extensions-worktreeconfig-in-git-config/137358),
  [git ab7ed92](https://code.googlesource.com/git/+/ab7ed92d6cd704979f818eefc3ebe46d7d6f5afd%5E2)).
- Parallel `git worktree add` calls collide on `.git/config.lock`, so creates should be serialised
  ([claude-code #34645](https://github.com/anthropics/claude-code/issues/34645)).
- `git branch -d` is the safety net; squash merges defeat it, so deleting a squash-merged branch
  needs a tree comparison
  ([Stack Overflow](https://stackoverflow.com/questions/57901887/how-to-tell-if-git-branch-has-been-fully-merged-after-squash)).
- Locked worktrees need `--force --force`; a lock is deliberate and can go stale
  ([git-worktree](https://git-scm.com/docs/git-worktree)).
- Repo-provided scripts should be trusted by content hash and refused, not run, without a TTY, as
  direnv and mise do; an auto-approve setting was itself a vulnerability
  ([mise security](https://mise.jdx.dev/security.html),
  [GHSA-436v-8fw5-4mj8](https://github.com/jdx/mise/security/advisories/GHSA-436v-8fw5-4mj8)).
- Conductor passes `CONDUCTOR_ROOT_PATH`, `CONDUCTOR_WORKSPACE_PATH` and `CONDUCTOR_WORKSPACE_NAME`
  to setup scripts; Claude Code reads `.worktreeinclude` with gitignore syntax and copies only
  gitignored matches ([Conductor](https://www.conductor.build/docs/reference/environment-variables),
  [Claude Code worktrees](https://code.claude.com/docs/en/worktrees)).
- One plugin should own a model and its write path, with enrichment optional
  ([IntelliJ plugin dependencies](https://plugins.jetbrains.com/docs/intellij/plugin-dependencies.html),
  [Encore](https://encore.dev/articles/microservices-vs-modular-monolith)).
- Submodules in multiple checkouts are incomplete in git, so a populated submodule needs its own
  refusal on delete ([git-worktree](https://git-scm.com/docs/git-worktree)).

## Deferred Ideas

- `[tech-spec]` How metadata detects a recreated folder (folder creation time or another marker).
- `[tech-spec]` How the squash-merge check compares trees.
- `[tech-spec]` How the hooks file is read from the base commit and how `.worktreeinclude` patterns
  are matched against gitignored files.
- `[tech-spec]` Where the generated-name pool and the retired names are stored.
- `[tech-spec]` How the window knows a create's pending row and whether the view changed.
- Remember the last-used agent in the create dialog ([D25](../../../loop/decisions/m1-worktrees.md) revisit).
- A Browse button using the macOS Open panel.

## Glossary

- **Project:** a git repository or a plain folder that Quirky knows about (`quirky.repo`'s record).
- **Workspace:** a project's unit of work: a git worktree, or a registration of a folder.
- **Primary workspace:** the project's own checkout or folder; listed first, can't be deleted.
- **Folder workspace:** a workspace with no git behind it, in a folder project or on a group's
  parent folder.
- **Group:** a sidebar section holding projects; a scanned group remembers its parent folder.
- **Metadata:** what Quirky stores about a workspace beyond git: display name, comment, status,
  pinned, unread, parent, creation details, base, and whether its branch is kept.
- **Base:** the ref a new branch is cut from.
- **Setup script / archive script:** commands run after a workspace is created and before it is
  deleted.
- **Shared script:** a script from `quirky.yaml` or `orca.yaml` in the repo; **local script:** one
  saved in Quirky's project settings on this machine.
- **Trusted hash:** the SHA-256 of a shared script's text that the user approved for a project.
- **Setup policy:** ask, run by default or skip by default.
- **Kept branch:** a branch left in place on delete because git can't show its work is merged.
- **Descendants:** a workspace's children, their children, and so on.
