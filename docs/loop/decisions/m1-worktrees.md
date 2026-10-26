# m1-worktrees decisions

## D1: Classify the item as an API, CLI, Organization, Visual and Data design, and run research phases A and B
- **Question:** which domains the gray-area catalog draws from, and whether the research swarms run (quirk:brainstorming, checklist steps 2 and 7)
- **Options:** one domain; several; skip research
- **Chose:** API (new methods and the grown worktree record), CLI (`wt`, `repo` and group commands), Organization (projects, groups, folder workspaces, parent and child), Visual (the sidebar, create, update and delete dialogs) and Data (idempotent creates, metadata reconciliation). Phase A ran two web-research agents (lifecycle patterns; pitfalls). Phase B ran one per approach (metadata in Quirky's store, metadata in git config, a separate enrichment plugin). Phase C was skipped because the chosen approach extends existing plugins rather than being novel.
- **Why:** the consumers are a person at the window and agents at a shell, and the feature crosses both
- **Evidence:** docs/loop/queue.json m1-worktrees; research/orca-features/worktrees.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a later item finds a research gap this skipped
- **Source:** assumed — autonomous

## D2: Skip the visual companion and the adhd offer, use the standard gray-area set
- **Question:** brainstorming's visual companion offer and its Step 0 adhd offer
- **Options:** run them; skip them
- **Chose:** skip both
- **Why:** LOOP.md says to skip the parts that assume a person is there
- **Evidence:** docs/loop/LOOP.md "Skip the parts that assume a person is there"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never for headless runs
- **Source:** locked by docs/loop/LOOP.md

## D3: The slice is projects, create, delete, metadata edits, setup and archive hooks, folder workspaces and groups
- **Question:** which of worktrees.md's flows this item covers (brainstorming scope check; LOOP.md step 3 "one slice of a feature")
- **Options:** every flow except Create from PR; only the five things the title names, read narrowly; the title's five read as the flows that carry them
- **Chose:** the title's five as flows. In scope: flow 1 (add a git project, a non-Git folder, clone from URL, create new project, import nested repos with or without a group, remove a project), flow 2 (create a workspace from a name or an existing branch, with base resolution and fallback, setup, agent start, create more; not the GitHub and GitLab tabs), flow 3's metadata edits (Update dialog with display name and notes, Move to Status, Pin, Mark Unread, parent and child), flow 5 (delete, with every refusal, the archive hook, kept branches and descendants), hooks and `orca.yaml`, folder workspaces and project groups. Out, named in the spec's non-goals: flow 4 (workspace options menu: grouping, sorting, filters, card layout), flow 6 (cleanup scan), flow 7 (hidden external worktrees), Sleep, the workspace board, keyboard switching and history, Open in, linked work, sparse checkout, the prepared-checkout pool, Keep Local Main Up to Date and its behind toast, custom statuses, project icons.
- **Why:** the title names metadata, create and delete, setup, folder workspaces and groups. Metadata has no flow without a way to edit it, so flow 3's edits come along. The options menu, cleanup and hidden worktrees are separate flows the title doesn't name, and m7-parity-sweep picks up every remaining flow. The behind toast needs the fast-forward setting it links to, which is its own flow step.
- **Evidence:** docs/loop/queue.json m1-worktrees and m7-parity-sweep; worktrees.md "What the user can do"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the M1 exit test (a full day of agent work) needs a flow listed as out
- **Source:** locked by docs/loop/queue.json (the title); assumed — autonomous (the exact cut)

## D4: Select every gray area that matters for worktrees
- **Question:** which gray areas to drill into (brainstorming Gray Areas Step 1)
- **Options:** CLI: output-format, flag-design, progress-reporting, error-recovery, exit-codes; API: response-format, error-responses, versioning, pagination; Organization: grouping-criteria, naming-convention, duplicate-handling, exception-handling; Visual: layout-style, empty-state, error-state, interaction-style; Data: idempotency, error-handling
- **Chose:** naming-convention (folders, branches, generated names, method and command names), grouping-criteria (projects, groups, folder workspaces, parent and child, which plugin owns what), duplicate-handling (name and branch collisions, the same repo twice, concurrent creates), exception-handling and error-handling (setup and archive failures, locked, dirty, orphaned, unmerged), flag-design and output-format (`wt create`, `wt set`, `wt rm`, `repo` commands), error-responses and error-recovery (setup decision, untrusted hooks, base fallback), response-format and versioning (the grown worktree record), layout-style, interaction-style, empty-state and error-state (sidebar and dialogs), idempotency (request IDs and concurrent creates)
- **Why:** LOOP.md asks for every area that matters. Progress reporting matters only for clone and delete, which return when done. Pagination has no consumer with a long list here. Exit codes stay 0, 1 and 2 (m0-scripting D15).
- **Evidence:** docs/loop/LOOP.md "Gray areas"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an area left out produces a finding in review
- **Source:** assumed — autonomous

## D5: Extend `quirky.repo` and `quirky.worktree` in place, with one create path and one remove path
- **Question:** the approach (brainstorming step 8): where the metadata model, projects, groups and hooks live
- **Options:** extend the two existing plugins, with projects, groups and project settings in `quirky.repo` and worktree metadata, create, remove, hooks and folder workspaces in `quirky.worktree`; a new enrichment plugin layered over them; metadata in git config (`branch.<b>.*`, `config.worktree`)
- **Chose:** extend the two plugins. Every surface (window, CLI, API) creates and removes through the same two methods, so naming, base fallback, setup and cleanup rules can't drift.
- **Why:** Orca keeps two create implementations that "must be kept in step" and they differ on base fallback (worktrees.md "Processes and layers", Open questions). Research favours one plugin owning the model and its write path, with enrichment never required by the core. Git config storage breaks other tools when `extensions.worktreeConfig` is set, contends on `config.lock`, and loses `config.worktree` on prune.
- **Evidence:** worktrees.md "Processes and layers"; research: git-scm git-worktree docs, Antigravity forum thread on worktreeConfig, git commit ab7ed92 (config.lock), JetBrains plugin dependencies, Encore modular monolith
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** a distro needs to replace worktree metadata without replacing create and delete
- **Source:** assumed — autonomous

## D6: Git stays the source of truth for which worktrees exist; Quirky stores what git can't, and never attaches it to a different worktree at the same path
- **Question:** data reconciliation between git and the metadata store (Data: idempotency, error-handling)
- **Options:** a registry Quirky trusts; git's list joined with Quirky's metadata on every read; filesystem scanning only
- **Chose:** every list reads `git worktree list --porcelain` and joins Quirky's metadata by worktree ID. Metadata records when its folder was created, and a row whose folder was recreated since (a path reused outside Quirky) is discarded instead of attached. A worktree removed outside Quirky disappears from the list, and its metadata is dropped the next time the repo's list succeeds without it.
- **Why:** research: path-keyed metadata "inherits stale metadata" on path reuse unless creation time is checked; Orca uses an `instanceId` for the same reason and cleans its state on refresh after an outside `git worktree remove`
- **Evidence:** worktrees.md "Data it stores" (instanceId); research: onorca.dev/docs/model/worktrees, git-scm porcelain stability
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** a filesystem without creation times shows metadata dropped wrongly
- **Source:** assumed — autonomous

## D7: Worktree IDs stay v1's path hash; extra folder workspaces get random IDs
- **Question:** naming-convention: the worktree ID scheme
- **Options:** Orca's `<repoId>::<absolute path>`; v1's `wt_<sha1(real path)>` for git worktrees and a folder's first workspace, `wt_<random>` for further workspaces that share a folder
- **Chose:** keep v1's scheme, plus random IDs for extra folder workspaces
- **Why:** sessions, layout and selectors already store `wt_` IDs (m0-core D10, D21), and a folder can hold several workspaces, so a path can't identify them all
- **Evidence:** plugins/quirky.worktree/paths.ts:27; worktrees.md "Folder workspaces" (several workspaces share one folder)
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** a moved folder needs to keep its ID (Orca's `priorWorktreeIds`)
- **Source:** assumed — autonomous

## D8: The worktree record grows additively, and `name` becomes the display name or the folder name
- **Question:** response-format and versioning: what `quirky.worktree/list` returns now
- **Options:** a second `meta` method beside v1's record; the record grows new fields and keeps every v1 field
- **Chose:** the record keeps `id`, `repoId`, `path`, `branch`, `head`, `isMain`, `name` and adds `kind` (git or folder), `displayName`, `comment`, `status`, `pinned`, `unread`, `parentId`, `createdAt`, `baseRef`, `createdBy` (window, cli or api), `keepBranch` and `removing`. `name` is the display name when one is set, else the branch for the primary checkout and the folder name for the rest. The protocol version doesn't change, since every field is new.
- **Why:** one record keeps every consumer on one read. With branch prefixes (D11) a branch name like `zpyoung/fix-login` would make a poor card title, which is why Orca shows the folder name.
- **Evidence:** worktrees.md "Data it stores" (WorktreeMeta) and the observed results table; packages/protocol Worktree type
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** a consumer depends on `name` equalling the branch
- **Source:** assumed — autonomous

## D9: New worktrees go under `<worktrees folder>/<repo>/<name>`, with nesting and a per-project location as settings
- **Question:** naming-convention: where a worktree's folder goes
- **Options:** keep v1's layout only; Orca's rules (`nestWorkspaces`, per-project override, a relative override read against the repo, never outside the root)
- **Chose:** Orca's rules on v1's setting: the root stays `worktreesRoot` (default `~/quirky/workspaces`), `nestWorkspaces` (default on) adds the repo folder, a project may set its own location, a relative one resolves against the repo, and a path that would leave its root is refused.
- **Why:** parity (roadmap "Parity"), with v1's root kept because m0-core D13 made it a plugin setting users already have
- **Evidence:** worktrees.md "Settings and defaults", create algorithm step 9; docs/loop/decisions/m0-core.md D13
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** users want Orca's `~/orca/workspaces` default
- **Source:** locked by research/orca-features/worktrees.md (the rules); assumed — autonomous (v1's root)

## D10: Names are sanitised by Orca's rule, without emoji shortcodes
- **Question:** naming-convention: what happens to a typed name
- **Options:** v1's strict regex that rejects; Orca's sanitiser that rewrites
- **Chose:** Orca's: keep Unicode letters, digits and `._-`, turn every other run into `-`, collapse `--` and `..`, trim `.` and `-` from the ends, turn a name of only emoji into `workspace`, refuse an empty, `.` or `..` result as "Invalid worktree name". Emoji are dropped like other characters rather than spelled as shortcodes.
- **Why:** parity; shortcodes would add a lookup table for a cosmetic difference
- **Evidence:** worktrees.md create algorithm step 7
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** users type emoji names and expect their words back
- **Source:** locked by research/orca-features/worktrees.md; assumed — autonomous (no shortcodes)

## D11: Branches get a prefix, by default the git username
- **Question:** naming-convention: the branch a new worktree gets
- **Options:** v1's branch equal to the name; Orca's `<prefix>/<name>` with git-username, custom or none
- **Chose:** Orca's. `branchPrefix` defaults to git-username, resolved from `github.user`, then `user.username`, then `gh api user` when the repo has a GitHub remote (2.5 s per try), then `user.name` when it is branch-safe, else no prefix. An invalid custom prefix is an error naming the setting.
- **Why:** parity; the default changes v1's naming, which M1's parity goal allows
- **Evidence:** worktrees.md "Branch prefix"
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the gh lookup slows creates noticeably
- **Source:** locked by research/orca-features/worktrees.md

## D12: Collisions take the next free `-2`, `-3` suffix, up to 100 tries
- **Question:** duplicate-handling: the name or branch is taken
- **Options:** fail; suffix like Orca
- **Chose:** try `name`, `name-2`, `name-3` and so on to 100, skipping a candidate whose branch exists locally or on any remote or whose folder exists. An explicit branch name isn't suffixed: an existing one is reused only if it points at the base and isn't checked out elsewhere, else the create fails with "Branch X already exists". Orca's "a PR already exists for this branch" check waits for hosting (M4).
- **Why:** parity
- **Evidence:** worktrees.md create algorithm step 8
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md; assumed — autonomous (PR check deferred)

## D13: Creating from an existing branch checks it out and keeps it on delete
- **Question:** primary behavior: the Branch tab and "Reuse branch"
- **Options:** always cut a new branch; reuse the branch
- **Chose:** a create naming an existing branch checks that branch out. A remote-only branch becomes a local branch of the same name tracking it. The worktree is marked to keep its branch on delete. A branch checked out in another worktree is refused, naming where.
- **Why:** parity; deleting a branch the user brought in would lose work they never gave Quirky
- **Evidence:** worktrees.md flow 2 Branch tab, create step 8, step 13 (`preserveBranchOnDelete`)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D14: The base is the requested one, else the project's saved base, else the detected default
- **Question:** primary behavior: which commit a new branch starts from
- **Options:** v1's current HEAD; Orca's resolution
- **Chose:** Orca's: a requested base wins; else the project's default base by Orca's rules; else the first of `origin/HEAD`'s target, `origin/main`, `origin/master`, `main`, `master`. With none, the create fails before touching git: "Could not resolve a default base ref for this repo. Pass an explicit --base and try again."
- **Why:** parity; v1's HEAD base made a worktree created from a feature checkout inherit its commits
- **Evidence:** worktrees.md create steps 4 and 5
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D15: A missing remote base is fetched; if the fetch fails the create falls back to the local branch and says so
- **Question:** error-recovery: offline or unreachable remote
- **Options:** always fail; always fall back silently; Orca's runtime rule
- **Chose:** Orca's runtime rule for every caller: an existing remote-tracking ref is used and refreshed in the background; a missing one is fetched first; if the fetch fails and the remote's local branch exists, the worktree is created from it and the result carries a notice ("The remote-tracking ref X was unavailable, so Quirky used local Y instead. This workspace may not include the latest remote changes."). A caller can turn the fallback off, as Orca's automations do. The window shows the notice as a dialog.
- **Why:** Orca's desktop path falls back without fetching while its runtime path fetches first (open question 3); one rule everywhere is the fix
- **Evidence:** worktrees.md create step 6, Open questions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** background refreshes cause noticeable network churn
- **Source:** locked by research/orca-features/worktrees.md; assumed — autonomous (one rule for every caller)

## D16: New branches are cut with no upstream and record their base
- **Question:** what git state a create leaves behind
- **Options:** plain `worktree add -b`; Orca's `--no-track`, `branch.<b>.base`, upstream for a same-named remote base, and `push.autoSetupRemote` unless set anywhere
- **Chose:** Orca's
- **Why:** parity; source control (M2) compares against `baseRef`, and `push.autoSetupRemote` makes the first push work without flags
- **Evidence:** worktrees.md create step 11
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** users object to Quirky writing repo-local git config
- **Source:** locked by research/orca-features/worktrees.md

## D17: A blank name gets a generated marine-creature name that is never reused
- **Question:** naming-convention and empty-state: create with no name
- **Options:** require a name; generate one
- **Chose:** generate one from a fixed pool of marine-creature names, picked at random among those not used or retired in the repo. A generated name is retired once its create succeeds or fails, because agent CLIs key history by folder; typed names never retire. When the pool is spent it continues with `-2` forms. The window's Create button works with a blank name, showing the name it will use.
- **Why:** parity with Orca's source; Orca's Smart tab left Create disabled on a blank name (worktrees.md flow 2, "not reproduced"), so the window is held to the API's behaviour
- **Evidence:** worktrees.md "Generated names", flow 2 note on blank names
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D18: `wt create` takes `[<repo>] [<name>]`, inferring the repo from the caller when one positional is given
- **Question:** flag-design: the create command's shape
- **Options:** v1's `wt create <repo> <name>`; Orca's `--name` with the repo inferred from the cwd; both
- **Chose:** two positionals mean repo and name, one means the name in the caller's project, none means a generated name in the caller's project; `--repo`, `--name`, `--base`, `--branch`, `--branch-name`, `--display-name`, `--comment`, `--parent-worktree`, `--no-parent`, `--setup run|skip|inherit`, `--trust-setup`, `--agent`, `--prompt`, `--no-fallback` and `--activate` as flags. The repo can also be named by `--repo` alone.
- **Why:** keeps v1's words (m0-core D8) while an agent inside a worktree can type `quirky wt create fix-login` as it would with `orca worktree create --name`
- **Evidence:** docs/loop/decisions/m0-core.md D8; cli.md "Worktrees, repos, projects"
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** one-positional calls are misread in practice
- **Source:** assumed — autonomous

## D19: Hooks come from `quirky.yaml`, or `orca.yaml` when there is none, read from the base the worktree starts at
- **Question:** naming-convention and hard constraint: the shared hooks file
- **Options:** only `quirky.yaml`; only `orca.yaml`; `quirky.yaml` with `orca.yaml` as a fallback
- **Chose:** `quirky.yaml`, falling back to `orca.yaml`. Recognised keys: `scripts.setup`, `scripts.archive`, `setupAgentStartupPolicy`, `worktree.sharedDirectories`. Orca's other keys (`issueCommand`, `defaultTabs`, `environmentRecipes`) are recognised and reported as not supported yet; unknown keys are reported as unrecognised. The setup file is read from the commit the worktree starts at, so the gate can decide before any git work.
- **Why:** the user is replacing Orca and their repos already carry `orca.yaml`. Orca reads the file from the new worktree, whose content is that same commit for a new branch.
- **Evidence:** worktrees.md "Hooks and orca.yaml"
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** a repo keeps different `quirky.yaml` and `orca.yaml` on purpose
- **Source:** assumed — autonomous

## D20: Projects also keep local setup and archive scripts, merged by Orca's command-source policy
- **Question:** grouping-criteria: per-machine scripts
- **Options:** shared file only; local scripts with a source policy
- **Chose:** local scripts per project, with policy shared-only, local-only or run-both (shared first); unset, it behaves as local-only when a local script exists, else shared-only
- **Why:** parity
- **Evidence:** worktrees.md "Settings and defaults" (`commandSourcePolicy`), "Hooks and orca.yaml"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D21: Setup follows the project's policy, and "ask" with no decision creates nothing
- **Question:** error-responses: the setup decision
- **Options:** always run; Orca's policy with a refusal
- **Chose:** policy ask, run by default (the default) or skip by default; a create passes run, skip or inherit. Ask with no decision fails before any git work with a distinct error code whose message says to pass `--setup run` or `--setup skip`. The window requires the choice before Create is enabled.
- **Why:** parity, with a specific code where Orca returns a generic `runtime_error`
- **Evidence:** worktrees.md create step 2, "Edge cases"; cli.md error envelope for the setup decision
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md; assumed — autonomous (the error code)

## D22: A shared script runs only when its content is trusted, on every path, including the CLI
- **Question:** error-recovery and hard constraint: trusting repo-provided scripts
- **Options:** run per policy only, as Orca's runtime path appears to; ask through `quirky ask` in the middle of the create; refuse with a next step and let the caller pass trust
- **Chose:** a shared setup or archive script runs only when its SHA-256 matches the project's trusted hash. Otherwise the window asks ("Run setup from <repo>?", or "<repo>'s setup changed — run the new version?") with Run hooks, Don't run and Always trust, and a CLI or API call fails before any git work with an error that shows the script and says to pass `--trust-setup` (run it this once) or run `quirky repo trust-hooks` (always trust). Local scripts need no trust.
- **Why:** Orca's trust check lives only in the renderer, so its CLI may run an untrusted script (open question 2); research shows direnv and mise refuse untrusted configs without a TTY and hash what they trust. A refusal with a next step keeps agents from blocking on an ask.
- **Evidence:** worktrees.md "Trust prompt for shared scripts", Open questions; research: mise security docs, GHSA-436v-8fw5-4mj8, direnv allow
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** the ask-based confirmation turns out better for agents than a refusal
- **Source:** assumed — autonomous

## D23: Setup runs in a background "Setup" terminal in the new worktree, or in the daemon when sessions are off
- **Question:** primary behavior: where setup runs
- **Options:** always in the daemon; a terminal session like Orca's Setup tab
- **Chose:** a terminal session titled "Setup" in the new worktree that runs a runner script kept in the worktree's git directory, without changing the open tab. With `quirky.session` off it runs in the daemon with the archive hook's limits. The environment carries `QUIRKY_ROOT_PATH`, `QUIRKY_WORKTREE_PATH`, `QUIRKY_WORKSPACE_NAME` and Orca's names (`ORCA_*`, `CONDUCTOR_ROOT_PATH`, `GHOSTX_ROOT_PATH`), so scripts written for Orca or Conductor work. A failed setup never removes the worktree; a setup that exists but didn't run gives a warning.
- **Why:** parity; the person can watch and rerun setup output in a terminal
- **Evidence:** worktrees.md "Setup runs in a terminal", create step 15, "Edge cases"; research: Conductor environment variables
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D24: `quirky.session/create` grows an optional title and command for shell sessions
- **Question:** the plugin API: setup needs a terminal that runs one command under a given title
- **Options:** create a shell and type the command into it; spawn a PTY from the worktree plugin; add `title` and `command` to session create
- **Chose:** add optional `title` and `command` to `quirky.session/create`, for shell sessions only. The session runs the command under the login shell and exits with its exit code.
- **Why:** typing into a shell races its prompt, which the shell-ready barrier is still being built for (m1-term-daemon), and a PTY owned by the worktree plugin would be a session the session plugin doesn't know about
- **Evidence:** plugins/quirky.session/src/sessions.ts:47-93 (no title or command today); roadmap M1 term-daemon "shell-ready barrier"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m1-providers reshapes session create in a way that conflicts
- **Source:** assumed — autonomous

## D25: A create can start an agent, optionally after setup finishes
- **Question:** primary behavior: the dialog's Agent field and `--agent`
- **Options:** leave agent start to a separate call; start it from create
- **Chose:** create takes an optional agent and prompt and starts that session once the worktree exists; with the project's `setupAgentStartupPolicy` set to wait-for-setup, the agent starts when the Setup session exits. Model and effort flags wait for m1-launch-settings. The dialog's agent field starts empty.
- **Why:** parity for the flow; Orca preselects Claude, and its own doc warns to clear it when you only want a worktree, so Quirky doesn't preselect
- **Evidence:** worktrees.md flow 2 "Agent [Optional]", "Settings and defaults" (`setupAgentStartupPolicy`)
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the user wants the last-used agent remembered
- **Source:** assumed — autonomous

## D26: `.worktreeinclude` copies gitignored files by gitignore pattern, and `sharedDirectories` are symlinked
- **Question:** primary behavior: files carried into a new worktree
- **Options:** Orca's literal-paths-only include file; gitignore patterns like Claude Code
- **Chose:** `.worktreeinclude` at the repo root takes gitignore patterns, as Claude Code reads it, and copies only matching files that exist and are gitignored, never `.git`, with Orca's limits (file at most 256 KB, 1000 entries, a copy budget with a warning). `worktree.sharedDirectories` from the hooks file are symlinked from the primary checkout when present and gitignored, at most 100, dropping `..`, absolute paths and `.git`. Neither ever fails a create.
- **Why:** the same file is read by Claude Code with globs, and Orca skips globs with a warning, so a repo set up for Claude Code would get partial copies
- **Evidence:** worktrees.md create step 14; research: code.claude.com/docs/en/worktrees
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** pattern matching copies far more than users expect
- **Source:** assumed — autonomous

## D27: Creates in one repo run one at a time
- **Question:** idempotency and duplicate-handling: concurrent creates
- **Options:** Orca's per-path in-flight hold; a per-repo queue
- **Chose:** a per-repo queue, so two creates of the same name at once get `name` and `name-2`. Retries with the same request ID return the first outcome (m0-core D19).
- **Why:** research: parallel `git worktree add` contends on `.git/config.lock` and fails, which a per-path hold doesn't prevent
- **Evidence:** research: anthropics/claude-code #34645, git commit ab7ed92; worktrees.md create step 10
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** bulk creates are too slow
- **Source:** assumed — autonomous

## D28: The create result is the worktree plus what happened around it
- **Question:** response-format and output-format: what create returns and prints
- **Options:** just the worktree; the worktree plus warnings, base fallback and setup outcome
- **Chose:** the worktree record plus `warnings`, an optional `baseFallback`, `setup` (ran in a terminal, ran in the daemon, skipped, or none) with the Setup session's ID, and the agent session's ID. The CLI prints the record, then one line per warning or notice.
- **Why:** a script needs to know whether setup ran and where to read it
- **Evidence:** worktrees.md create steps 6 and 15
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** assumed — autonomous

## D29: A CLI create inside a worktree nests under it unless `--no-parent`
- **Question:** grouping-criteria: parent and child
- **Options:** never infer; infer from the caller like Orca
- **Chose:** a parent is set by `parent`, else inferred from the caller's session worktree, then the worktree containing its cwd, unless `--no-parent`. The window sets none unless chosen. A parent can't be the worktree itself or one of its descendants. Removing a parent from a worktree is `--no-parent`.
- **Why:** parity; agents that spawn worktrees then show as children of their own
- **Evidence:** worktrees.md flow 3 "Parent/child nesting"; cli.md request shape (parent inference)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** inferred parents surprise users
- **Source:** locked by research/orca-features/worktrees.md

## D30: A window create shows a pending row and opens the result only if you're still where you started
- **Question:** interaction-style: what the window does during and after a create
- **Options:** always open; Orca's rule
- **Chose:** a pending row appears in the project while the create runs. When it finishes, the new worktree opens only if the open view hasn't changed since Create was pressed; otherwise a toast names it. CLI and API creates never change the view unless `activate` is passed.
- **Why:** parity
- **Evidence:** worktrees.md flow 2 step 3
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D31: The create dialog has Project, Name, Create from, Agent, Advanced and Create more
- **Question:** layout-style: the create dialog
- **Options:** v1's name and base fields; Orca's composer minus the hosting tabs
- **Chose:** Project; Name (blank shows the generated name it will use); Create from, either a base ref (the detected default shown) or an existing branch (reuse); Agent (optional, empty) with a prompt; Advanced with display name, branch name, parent worktree, note, and the setup choice when the project has setup (with its source, "quirky.yaml", "orca.yaml" or "local settings"); a Create more switch that keeps the dialog open and resets name, agent and setup choice; Mod+Enter submits. The GitHub and GitLab tabs wait for M4.
- **Why:** parity for the flows in scope (D3)
- **Evidence:** worktrees.md flow 2
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D32: Metadata is edited with `quirky.worktree/set` and `wt set`, using Orca's flag names
- **Question:** flag-design: editing a worktree's metadata
- **Options:** one method per field; one `set` method
- **Chose:** `set` with display name (empty clears it), comment, status (todo, in-progress, in-review, done), pinned, unread and parent or no parent. `wt set <worktree> --display-name --comment --workspace-status --pin|--unpin --unread|--read --parent-worktree|--no-parent`. Opening a worktree in the window clears its unread mark.
- **Why:** Orca's flag names let agent skills written for `orca worktree set` carry over; Orca has no pin flag, so `--pin` and `--unpin` are added
- **Evidence:** cli.md `worktree set`; worktrees.md flow 3
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** custom statuses arrive and need their own IDs
- **Source:** assumed — autonomous

## D33: The sidebar shows groups, then projects, then workspaces with the primary first and children nested
- **Question:** layout-style: the sidebar tree
- **Options:** v1's flat repo list; Orca's project sections with groups, a Pinned section and nesting
- **Chose:** a Pinned section on top when anything is pinned; group sections (collapsible) holding their projects and any group folder workspace; ungrouped projects. In a project the primary workspace comes first with a "primary" badge, then the rest in creation order; children sit indented under their parent with a "N child" chip that collapses them. A card shows the name, the session status dot, an unread marker, a workspace status label other than In progress, and a pending or deleting state. The section's `ui state` report carries the same tree.
- **Why:** parity for what the slice covers; sort orders and grouping by status are the options menu, out of scope (D3)
- **Evidence:** worktrees.md flows 1, 3, 4 ("Sidebar rows")
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** creation order buries active work before the options menu lands
- **Source:** assumed — autonomous

## D34: A workspace's menu has Update, Move to Status, Copy Path, Pin, Mark Unread, Set Parent and Delete
- **Question:** interaction-style: the card's right-click menu
- **Options:** v1's remove button only; Orca's menu minus out-of-scope rows
- **Chose:** Update…, Move to Status (submenu), Copy Path, Copy Worktree Name, Pin or Unpin, Mark Unread or Mark Read, Set Parent Worktree… or Remove from Parent, Delete (Delete with Descendants (N) for a parent). The primary's Delete is disabled with a tooltip pointing to Remove Project. The project header menu has Project Settings, New Group from Project (or Move to Group), and Remove Project.
- **Why:** parity for the slice; Sleep, Open in and Mark Unread's siblings outside the slice are out (D3)
- **Evidence:** worktrees.md "Right-click menu on a workspace card", "Remove a project"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D35: The window's delete dialog warns about changes, offers Don't ask again, and then deletes even a dirty worktree
- **Question:** interaction-style and error-state: deleting from the window
- **Options:** v1's confirm then force on conflict; Orca's dialog
- **Chose:** Orca's: "Remove <name> from git and delete its workspace folder. Any uncommitted or untracked changes in Git workspaces will be permanently deleted.", the path, the count of uncommitted or untracked changes, a "Don't ask again" box (setting `confirmDelete`, default on, with a toast saying it can be turned back on in Settings) and Cancel and Delete Workspace. Confirming deletes even with changes, since the dialog warned. A refusal shows "Failed to delete workspace <name>" with git's or Quirky's reason.
- **Why:** parity
- **Evidence:** worktrees.md flow 5 steps 1 and 2
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D36: CLI and API deletes keep the kernel confirmation, refuse changes without `--force`, and refuse locked worktrees always
- **Question:** error-responses: deleting without the window
- **Options:** Orca's rules; also let `--force` remove locked worktrees
- **Chose:** the kernel confirmation (m0-core D20) unless `--yes`; changes refuse with "Worktree has uncommitted or untracked changes." unless `--force`; a submodule-populated worktree refuses with its own message unless `--force`; a locked worktree refuses with "This workspace is locked by Git. Git reported: <reason>. Run git worktree unlock <path> from its repository, then retry deletion." and `--force` doesn't override it.
- **Why:** parity; a lock is someone's explicit statement, which git itself only overrides with a double force
- **Evidence:** worktrees.md remove steps 4 and 8, flow 5 step 2; research: git-scm on `--force --force`
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D37: The archive hook runs on every delete unless skipped, and its failure stops the delete
- **Question:** exception-handling: the archive hook
- **Options:** Orca's (window runs it, CLI only with `--run-hooks`); the same everywhere
- **Chose:** the same everywhere: a delete runs the archive script (trust as in D22) before stopping anything, unless `--skip-archive`. A failure stops the delete with a distinct code; only `--allow-failed-archive-hook` waives it, not `--force`. It runs with a 2-minute timeout and output capped at 10 MiB. Prunable or already-gone worktrees skip it.
- **Why:** worktrees.md's own premise is that every path ends in the same code; a CLI that silently skips cleanup a script relies on is the drift D5 removes
- **Evidence:** worktrees.md "Archive hook", remove steps 5 and 6
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** agents deleting many worktrees find the hook too slow
- **Source:** assumed — autonomous

## D38: A deleted worktree's branch goes only when git shows it is merged, else it is kept and reported
- **Question:** exception-handling: branch cleanup
- **Options:** keep every branch; `-D` always; Orca's rule
- **Chose:** Orca's: a reused branch (D13) is kept; otherwise `git branch -d`; if that refuses, the branch is deleted only when its changes are already in its base or upstream (a squash merge), and only if it still points where it did; otherwise it is kept and the result names it. The window then offers "Delete branch" (in Orca, Review kept branches > Force Delete), which is a destructive method that refuses if the branch has moved.
- **Why:** parity; research: `-d` is the safety net, and squash merges need a tree comparison rather than ancestry
- **Evidence:** worktrees.md remove step 12, flow 5 step 3; research: Stack Overflow 57901887
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D39: Deleting a parent requires taking its descendants too
- **Question:** exception-handling: deleting a worktree with children
- **Options:** orphan the children; refuse unless asked; delete them
- **Chose:** refuse unless `--with-descendants`, naming the children. With it, children go first, deepest first, and the first failure stops the run with what was deleted so far. The window offers Delete with Descendants (N) with "Child workspaces will be deleted".
- **Why:** parity
- **Evidence:** worktrees.md flow 5 step 4, flow 3 nesting
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D40: A worktree git already forgot is cleaned if its folder is gone, and refused if its folder remains
- **Question:** exception-handling: orphaned and unregistered worktrees
- **Options:** Orca's rules
- **Chose:** a Quirky-known worktree whose folder is gone is cleaned (metadata, `git worktree prune`, branch rules). A registered worktree whose folder is gone is pruned without the archive hook. A worktree git forgot whose folder remains is refused: "Git already forgot this workspace, but its directory is still on disk. Use Force Delete to remove the orphaned directory." Force deletes that folder only when Quirky created it inside its worktrees root. A path Quirky never knew is refused.
- **Why:** parity; Quirky never deletes a folder it can't prove it made
- **Evidence:** worktrees.md remove step 3, "Edge cases" (orphans)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D41: Deletes finish before the call returns, and two deletes of one worktree share one run
- **Question:** progress-reporting and idempotency: long deletes
- **Options:** Orca's background removal returning `removing: true`; inline
- **Chose:** inline. While it runs the worktree lists with `removing: true` for every client, and a second delete with the same options waits for the first; one with different options is refused ("Worktree deletion already in progress").
- **Why:** an inline delete leaves nothing to recover after a restart, which Orca's background path leaves unverified (open question 6)
- **Evidence:** worktrees.md remove steps 1 and 11, Open questions
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** deletes that take 30 s block the window badly
- **Source:** assumed — autonomous

## D42: A delete checks first, then runs the archive hook, then closes sessions, then removes
- **Question:** exception-handling: the order of a delete
- **Options:** v1's (git refuses first, sessions close after); Orca's
- **Chose:** Orca's order: refuse locked, check changes unless forced, run the archive hook, close the worktree's sessions, remove with git, clean the branch, drop metadata. A session that won't close stops the delete unless forced.
- **Why:** with the change check up front, closing sessions before git runs can't kill sessions for a delete that then refuses, which was v1's reason for its order
- **Evidence:** plugins/quirky.worktree/main.ts:185-213; worktrees.md remove steps 6 to 13
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D43: A non-Git folder is added with `--folder`, and the CLI says so instead of just failing
- **Question:** error-recovery and primary behavior: folder projects
- **Options:** refuse non-Git folders; add them silently; add them when asked
- **Chose:** `repo add <path> --folder` adds a folder project; without it a non-Git folder fails with "not a git repository: <path>; pass --folder to add it as a folder project". The window shows "This folder isn't a Git repository. You'll have the editor, terminal, and search, but Git-based features won't be available." with Open as Folder. A folder project has one primary workspace on the folder; creating more makes workspaces that share it with no file work; deleting one only forgets it. Source control shows "Opened as folder. Git features are unavailable for this workspace."
- **Why:** Orca's CLI could not create a folder workspace at all (`repo add` and `project setup-existing-folder` both failed), which is a defect to test
- **Evidence:** worktrees.md "Verified in the app" (CLI folder attempts), "Folder workspaces"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D44: Clone and create-new-project put the repo in the worktrees folder and add it
- **Question:** primary behavior: Clone from URL and Create new project
- **Options:** require a destination; default to the worktrees folder like Orca
- **Chose:** `repo clone <url> [--location]` clones into `<location or worktrees folder>/<repo name>` and adds it; `repo create <name> [--location]` makes the folder, runs `git init` with git's own default branch, and adds it. An existing destination is refused. A repo with no commits can be added, but creating a worktree in it fails with "<repo> has no commits yet".
- **Why:** parity; git's default branch follows the user's `init.defaultBranch`, which is why Orca's produced `master`
- **Evidence:** worktrees.md flow 1 step 1
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** users expect an initial commit
- **Source:** locked by research/orca-features/worktrees.md

## D45: A folder of repos is scanned and imported, with or without a group
- **Question:** grouping-criteria: nested repo import
- **Options:** Orca's scan rules and import result
- **Chose:** `repo scan <path>` lists repos within depth 3 (1 to 8), at most 100 (1 to 500), skipping `node_modules`, `.next`, `dist`, `build`, `.cache`, `vendor`, `__pycache__`, `.turbo`, `.parcel-cache` and VCS folders, and not descending into a repo it found. `repo import <path> [--group <name>]` adds each, returning imported, already-known or failed per repo with counts; with a group it makes a project group remembering the parent folder. The window offers this when an added folder isn't a repo but holds some: "Found N repositories in <path>", "Group these repositories?", Yes, import as group or No, import separately.
- **Why:** parity
- **Evidence:** worktrees.md flow 1 step 3, "Folder workspaces" (nested repo scan)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D46: Project groups live in `quirky.repo`, with `repo group` commands
- **Question:** grouping-criteria and naming-convention: project groups
- **Options:** a separate groups plugin; in `quirky.repo`
- **Chose:** `quirky.repo` owns groups: name, collapsed, order, parent folder for scanned groups. A project is in at most one group. Commands `repo group list|create|rename|delete|add|remove|collapse`. Deleting a group ungroups its projects; removing a project takes it out of its group.
- **Why:** a group is a set of projects, which `quirky.repo` owns; a separate plugin would need the repo list to mean anything
- **Evidence:** worktrees.md "Data it stores" (ProjectGroup); research: Encore on data ownership
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** sidebar-extras' cross-repo groups (m2) need groups that hold worktrees from many projects
- **Source:** assumed — autonomous

## D47: A scanned group can hold folder workspaces on its parent folder
- **Question:** grouping-criteria: folder workspaces inside a group
- **Options:** leave them out; Orca's group folder workspace
- **Chose:** `wt create --group <group>` in a group with a parent folder makes a folder workspace on that folder, listed in the group's section. Its `repoId` is `group:<groupId>`.
- **Why:** parity: it lets the user work from the parent folder of related repos
- **Evidence:** worktrees.md "Folder workspaces" (FolderWorkspace inside a project group)
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** consumers trip over a `repoId` that isn't a repo
- **Source:** locked by research/orca-features/worktrees.md; assumed — autonomous (the synthetic repo ID)

## D48: Removing a project keeps its folder and closes its terminals, and says both
- **Question:** error-state: Remove Project
- **Options:** v1's silent removal; Orca's dialog
- **Chose:** the window's dialog says "This only removes <name> from Quirky. It is still on your disk. N open terminals in this project will be closed." with Cancel and Remove. The method stays as v1 had it (closes sessions, forgets the project) and also drops its worktrees' metadata.
- **Why:** parity
- **Evidence:** worktrees.md "Remove a project"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D49: Project settings are a `quirky.repo` record, set with `repo set` and shown with `repo show`
- **Question:** grouping-criteria and flag-design: per-project settings, given that plugin settings have one scope (m0-ui-api D17)
- **Options:** per-project plugin settings; project fields on the repo record
- **Chose:** project fields on the repo record: display name, default base, worktree location, setup policy, agent startup policy, command source, local setup and archive scripts, trusted hashes. `repo set <repo> ...` and `repo show <repo>` (which also reports the effective hooks, their source and trust, and the hooks file's warnings), and a Project Settings dialog in the window.
- **Why:** m0-ui-api D17 gives settings only the user's scope, so per-project values belong to the plugin that owns projects
- **Evidence:** docs/loop/decisions/m0-ui-api.md D17; worktrees.md "Settings" (Project Settings page)
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** settings gain scopes
- **Source:** supersedes nothing; works within m0-ui-api D17

## D50: Global worktree settings are plugin settings
- **Question:** what goes in user settings
- **Options:** the five Orca settings in scope
- **Chose:** `worktreesRoot` (v1's), `nestWorkspaces` (on), `branchPrefix` (git-username, custom, none), `branchPrefixCustom` and `confirmDelete` (on)
- **Why:** parity for the slice; external-worktree visibility and Keep Local Main Up to Date are out (D3)
- **Evidence:** worktrees.md "Settings and defaults"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by research/orca-features/worktrees.md

## D51: The Orca defects tested are the two create paths, the CLI's folder gap, the CLI's trust gap, the generic setup error and the stuck blank name
- **Question:** LOOP.md step 4: which Orca defects the doc records
- **Options:** every gap the doc mentions; the ones that change what a user sees
- **Chose:** (1) the window and the CLI give different results for one create (two implementations; base fallback differs); (2) the CLI can't create a folder workspace; (3) a CLI create may run an untrusted shared script; (4) a refused setup decision returns a generic error code; (5) a blank name leaves Create disabled; (6) background deletes may not finish after a restart. Each gets a test showing Quirky doesn't do it. Not counted: `Cmd+N` through the automation driver (unverified and native), legacy locale strings, the Archive Script field with no Archive action (out of scope), git's `master` default (git's behaviour).
- **Why:** each counted one changes an outcome for a user or an agent; the rest are unverified, cosmetic or not Orca's
- **Evidence:** worktrees.md "Processes and layers", "Verified in the app", "Edge cases", Open questions
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a reviewer reads another gap as a defect
- **Source:** assumed — autonomous

## D52: Platform-specific parts are logged and built for macOS only
- **Question:** what will need Linux or Windows work
- **Options:** build for all; macOS only and log the rest
- **Chose:** macOS only. Logged: the Windows `.cmd` runner and `cmd` archive hook, `core.longpaths` args, partial-delete recovery on Windows, WSL routing, `/bin/bash` as the hook shell, folder creation times used by D6, and case-insensitive path comparison.
- **Why:** locked platform rule
- **Evidence:** docs/loop/LOOP.md "Platforms"; worktrees.md "Edge cases" (Windows)
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the cross-platform checks are planned
- **Source:** deferred: platform

## D53: Fast-track the remaining defaults
- **Question:** brainstorming's fast-track once the six essentials are covered
- **Options:** keep asking; take the recommended defaults
- **Chose:** take them. Purpose, consumers, success criteria, hard constraints, scope and primary behavior are covered by the roadmap, worktrees.md and D3 to D52. Defaults taken: `wt list` gains STATUS and a `--json` record with every field; `wt show <worktree>` prints the full record with children; events stay `quirky.worktree/changed` and `quirky.repo/changed` with the affected IDs; the empty sidebar keeps v1's "No repositories yet." with an Add project button.
- **Why:** LOOP.md treats the user as having elected the fast-track
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by docs/loop/LOOP.md

## D54: Add project takes a typed path; the macOS Open panel waits
- **Question:** layout-style: Browse folder opens the native folder picker in Orca
- **Options:** add a desktop-shell file dialog API now; keep v1's path field
- **Chose:** keep the path field in the Add project dialog, with the Open as Folder and import dialogs after it
- **Why:** the UI plugin API has no file dialog, and adding one means a shell-to-window bridge outside this item's plugins; the flows behind the picker (folder, import, group) are all reachable with a typed path
- **Evidence:** packages/protocol/src/ui.ts:181-209 (UiPluginContext has no file dialog); worktrees.md flow 1
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the desktop shell gains a dialog API
- **Source:** assumed — autonomous

## D55: Write a tech spec
- **Question:** the tech-spec rubric's complexity gate
- **Options:** skip; write one
- **Chose:** write `tech.md`
- **Why:** LOOP.md always asks for one, and the work crosses `quirky.repo`, `quirky.worktree`, `quirky.session`, `quirky.git`, `@quirky/git` and the window
- **Evidence:** docs/loop/LOOP.md step 4
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** never
- **Source:** locked by docs/loop/LOOP.md

## D56: One Codex adversarial review over both specs, at deep depth, standing in for the tech-spec reviewer
- **Question:** LOOP.md step 4 review, and the tech-spec rubric's reviewer dispatch
- **Options:** the rubric's tech-spec reviewer plus an adversarial pass; one adversarial pass over both
- **Chose:** one `quirk:adversarial-review` run over the range holding both specs (`c4957f7..HEAD`, spec-design profile, deep as the script suggested for a contract surface), Codex (`gpt-6.1-sol`) promoting and refuting in separate contexts, a third family only if a finding is contested. The criteria staged are LOOP.md's and the roadmap's requirements verbatim; the decision log's rationale is not staged.
- **Why:** LOOP.md replaces the user's spec review with one adversarial pass over both specs, and m0-core D37 folded the tech-spec reviewer into it the same way
- **Evidence:** docs/loop/LOOP.md step 4; docs/loop/decisions/m0-core.md D37
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the pre-pass can't run on a range and a path target would give it ground truth
- **Source:** locked by docs/loop/LOOP.md

## D57: Spec review: fix all seven standing findings, accept the two refutations, and add Mod+N anyway
- **Question:** what to do with the adversarial review's findings (LOOP.md step 4 "Fix every confirmed finding")
- **Options:** fix the standing ones; also act on refuted ones
- **Chose:** NEEDS_FIXES with seven standing (2 HIGH, 4 MEDIUM, 1 LOW advisory), two refuted. Fixed all seven: F1 a project with no name is `--repo` (SC-18, SC-21); F2 an existing-branch create with no name takes its folder from the branch; F3 a list keeps an unregistered row whose folder exists, so a later Force can find it; F4 rows record `created_root` and Force deletes only inside it; F6 an explicit `--setup skip` doesn't warn (Orca's rule); F7 a wait-for-setup create returns with the agent pending; F8 the Setup exit is watched race-free and the agent starts once. F5 (existing `branchName` reuse) was refuted but the tech spec now says it outright. F9 (API commands for dialog controls) was refuted; Orca's Mod+N create shortcut is in worktrees.md's shortcut table and cheap, so a `new-worktree` command with `mod+n` is added (SC-62).
- **Why:** every standing finding named two readings with different outcomes; F6 matched Orca's create step 15 rule, so the logic spec moved, not the tech spec
- **Evidence:** scratchpad ar1/gate.json and manifest.json (reviewer gpt-6.1-sol, independence full, depth deep, profile spec-design); logic.md amendments 2026-10-26
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the build finds a fix contradicts code
- **Source:** assumed — autonomous

## Progress
Step 4 done: specs reviewed (D56, D57) and committed. Next: step 5, quirk:subagent-driven-development against tech.md, in waves W1 protocol+git, W2 repo/session/git plugins, W3 worktree daemon+CLI, W4 window, W5 scenario tests.
