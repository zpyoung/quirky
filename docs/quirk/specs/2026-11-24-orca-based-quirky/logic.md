# Quirky on an Orca base

Quirky stops being a from-scratch Bun and Electrobun app. Instead it becomes the owner's Orca fork, synced from upstream one last time, trimmed, renamed throughout and owned outright as a hard fork. Today's Quirky is archived and kept as a reference library for later ports.

This spec covers the cutover, from the last upstream sync to archiving zpyoung/orca, plus the roadmap that follows. It is written for the owner, who uses the result as a daily driver, and for the agents that carry out each step. Each port after the cutover (chat first) gets its own brainstorm and spec.

## Why

Three things pushed this decision. Quirky still isn't stable enough to replace Orca day to day. Upstream Orca ships faster than one person can rebuild its features. And the Bun and Electrobun bet hasn't paid back its cost in runtime bugs, a forked Electrobun and thinner tooling. The end goal stays the same: replace both VSCode and Orca, with a central brain as the entry point for nearly all work. Orca becomes the base the brain gets built on.

## The model

The new Quirky is a **hard fork** of the owner's Orca fork (zpyoung/orca). Nothing merges in from upstream on its own. Instead, an **upstream review** every two weeks proposes specific changes to port, and the owner picks which ones.

Three apps share the owner's Mac during the transition:

- **Orca Dev** is the current daily app and the fallback for the whole overlap. It stays installed after the cutover as a cold backup that no longer gets updates.
- **Old Quirky** is uninstalled at the flip. Its code lives on in the repo's history, on the `archive/v1` branch and under the `quirky-v1-final` tag.
- **New Quirky** gets its own identity and runs beside Orca Dev without sharing anything with it.

Today's Quirky code is reference material only. Ports are rebuilt natively in Orca's main, renderer and IPC structure, guided by Quirky's specs, tests and recorded edge cases. No Quirky code comes over with its Bun or PluginContext plumbing.

## The sequence

The cutover runs in this order. Each step finishes before the next one starts.

1. **Last sync.** The fork's sync skill runs once more onto the newest upstream stable tag, and a final `zy` release is cut from it. That build is the Orca Dev fallback for the whole overlap.
2. **Split.** Today's Quirky main gets the `quirky-v1-final` tag and an `archive/v1` branch, and open Quirky PRs are closed with a pointer to the archive. Then the synced fork's history is merged in, keeping only the fork's tree, and main moves forward to that merge. Main's tree becomes Orca's and its history keeps old Quirky as an ancestor, with no force-push. The same day:
   - The fork-sync machinery is deleted: the ownership manifest, sync skill, sync gate and precheck, ownership guard, and release routing to zpyoung/orca.
   - Orca's CI, trimmed to macOS, replaces Quirky's workflows.
   - AGENTS.md is rewritten for the new tree.
   - Local-only rules Orca's tree doesn't know about, such as ignoring `research/`, are carried over.
   - This spec moves into the new tree.
3. **Trim.** Code nobody will use is deleted before anything is renamed, one cut per PR. Each cut needs green CI and a clean dead-code pass before the next starts.
4. **Rename.** Everything goes from Orca to Quirky, including code identifiers. A CI check keeps it that way.
5. **Import.** New Quirky's first launch offers to copy the owner's Orca Dev state.
6. **Daily-driver week.** At the start of the week, the owner's own scripts, skills and docs move from `orca` to `quirky`. The week ends after seven days in a row of real work without opening Orca Dev.
7. **Archive zpyoung/orca.** The repo is archived on GitHub, its release workflow stops, and new Quirky's release pipeline is the only one left.
8. **Chat port**, then the later ports, each from its own spec.

## Key decisions

- **Hard fork, with a review every two weeks.** Upstream moved about 5,700 commits from 272 authors in the 30 days to Nov 17, and the fork already trails it by about 6,600 commits. A daily sync is a permanent tax. A one-time catch-up followed by hand-picked ports keeps the gains without that tax.
- **Start from the fork after one last sync.** It already carries 33 fork features the owner uses (heimdall, the hosted-review sitter, objective, loops, ask, ledger, terminal-dock, session-info, session-handoff and more). Starting from a clean upstream tag would mean redoing that work.
- **Flip main first and build in the open.** A long-lived branch or finishing inside zpyoung/orca both mean weeks of living with two systems, and that's the most common way rewrites stall. GitHub also runs scheduled workflows only on the default branch.
- **Merge the fork in instead of force-pushing.** The merge keeps the fork's tree, so the old history stays reachable from main and no protection rules have to be lifted.
- **Code can change anywhere.** With no syncs, separate fork-* directories and the ownership manifest stop paying for themselves. Ports from upstream get harder to apply as files drift, which is acceptable because the reviews pick changes by hand anyway.
- **Trim before rename.** Code that's cut never has to be renamed, tested or built again.
- **Full rename, code identifiers included.** Later upstream ports need renaming as they come in, and the owner accepted that cost.
- **The `quirky` CLI only, with no `orca` alias.** The owner's own uses move at the start of the week, and Orca Dev keeps answering anything missed until then.
- **Orca's version wins wherever both apps have one** (ask, loops, heimdall, sitter, objective, orchestration, ledger, handoff). It's the one in daily use and it's already wired into Orca's UI. Quirky's improvements are ported only when the owner misses one.
- **The chat port replaces both engine and UI.** Plan mode, transcript paging and the visual panel depend on Quirky's session journal, so porting the UI alone would leave them without it.
- **The ~300 MB memory target is a goal, not a gate.** Each port reports against it, but none waits on it.

## What the owner sees

### Identity on one Mac

| | Orca Dev (fallback) | Old Quirky (removed at the flip) | New Quirky |
|---|---|---|---|
| Bundle id | `com.zpyoung.orca` | `dev.quirky.app` | `com.zpyoung.quirky` |
| Data | `Application Support/orca`, `~/.orca` | `~/.quirky` | `Application Support/quirky`, `~/.quirky` |
| CLI, URL scheme | `orca`, `orca://` | `quirky`, `quirky://` | `quirky`, `quirky://` |

New Quirky is signed and notarized with the same Developer ID as Orca Dev, so updates and macOS permissions work the same way. Its helper bundles, daemon socket, ports and keychain item are its own. LICENSE keeps Lovecast Inc.'s MIT notice next to the owner's, and the About window credits Orca.

### Scenarios

1. **SC-1: The flip keeps old Quirky reachable**
   - **Given** Quirky main is at its last Bun commit and the synced fork is ready
   - **When** the split runs
   - **Then** ✓ main's tree is the fork's; ✓ old main is an ancestor of main; ✓ `quirky-v1-final` and `archive/v1` point at old main; ✓ nothing was force-pushed; ✓ open Quirky PRs are closed with a pointer to the archive
   - **Data before:** **Quirky main**: last Bun commit, 4,193 commits; **zpyoung/orca main**: synced to the newest upstream stable tag
   - **Walkthrough:**
     1. The agent tags old main `quirky-v1-final` and pushes `archive/v1`
     2. On a branch holding the synced fork, the agent merges old main, keeping only the fork's tree
     3. Main moves forward to that merge
   - **Data after:** **Quirky main**: ✓ the fork's tree, with both histories behind it; **archive/v1**: ✓ old main; **Tag quirky-v1-final**: ✓ old main

2. **SC-2: Each trim cut stands alone**
   - **Given** the split has landed
   - **When** the trim runs
   - **Then** ✓ each cut is its own PR; ✓ CI is green and the dead-code pass is clean before the next cut opens; ✓ nothing in the "stays" list is touched
   - **Trim order:**

     | Order | Cut | Notes |
     |---|---|---|
     | 1 | Stably endpoints | Telemetry and crash reporting are removed. The update feed and `npx skills add` point at zpyoung/quirky |
     | 2 | Windows, Linux, WSL | WSL guest, Windows and Linux helpers in `native/`, Linux package updates, per-platform CI lanes |
     | 3 | Hosted relay | `cloud/` and the relay deploy workflows. Mobile stays in the tree but can't connect until the direct-pairing port |
     | 4 | Bitbucket, Gitea, Azure DevOps | GitHub and GitLab stay |

     Stays: SSH remotes, Linear, Jira, every agent CLI, computer use, the browser, the AI vault. The cuts total roughly 75k of about 2.5M lines, so the owner still owns about 2.4M.

3. **SC-3: A stray `orca` fails CI**
   - **Given** the rename has landed
   - **When** a PR adds a new identifier, string, path or doc line containing `orca` outside the allowlist
   - **Then** ✗ CI fails and names the file and line
   - **Allowlist:** LICENSE, CHANGELOG entries from before the rename, and the Orca credit in About and the README

4. **SC-4: Both apps run at once**
   - **Given** Orca Dev and new Quirky are both open
   - **When** the owner clicks a `quirky://` link, runs `quirky status` and runs `orca status`
   - **Then** ✓ the link opens new Quirky; ✓ each CLI talks only to its own app; ✓ quitting either app leaves the other's terminals running

5. **SC-5: Old Quirky is removed at the flip**
   - **Given** old Quirky is installed at `~/Applications/Quirky.app` with state in `~/.quirky`
   - **When** the split lands
   - **Then** ✓ old Quirky is uninstalled; ✓ `~/.quirky` is moved to `~/.quirky-v1-archive`; ✓ new Quirky can claim `quirky`, `quirky://` and `~/.quirky` without a clash

6. **SC-6: First-launch import**
   - **Given** new Quirky has no state and Orca Dev has the owner's setup
   - **When** the owner accepts the import offer on first launch
   - **Then** ✓ repos, the worktree list, settings, keybindings, automations and account links are copied; ✓ secrets are re-encrypted under Quirky's keychain item after one macOS prompt; ✓ automations arrive paused; ✓ existing worktrees stay where they are; ✗ live terminals and scrollback are not copied; ✓ nothing in Orca Dev's data changes
   - **Data before:** **Orca Dev**: 6* repos; 40* worktrees under `~/orca/workspaces`; 3* automations, active; Claude and Codex accounts linked. **New Quirky**: empty
   - **Walkthrough:**
     1. Quirky reads Orca Dev's data, read-only
     2. macOS asks once for access to Orca Dev's keychain item, and the owner allows it
     3. Quirky writes its own copies and re-encrypts the secrets under its own item
   - **Data after:** **New Quirky**: ✓ 6 repos; ✓ 40 worktrees, still under `~/orca/workspaces`; ✓ 3 automations, paused; ✓ both accounts linked. **Orca Dev**: ✓ unchanged; ✓ its 3 automations still active

7. **SC-7: Running the import again**
   - **Given** the import has run once and the owner has since added a repo in Orca Dev and deleted a worktree in Quirky
   - **When** the owner runs "Import from Orca" from settings
   - **Then** ✓ the new repo is added; ✗ the deleted worktree is not brought back, because a re-run adds only what's new in Orca Dev since the last import; ✓ nothing in Quirky is deleted

8. **SC-8: Moving an automation over**
   - **Given** an imported automation is paused in Quirky and active in Orca Dev
   - **When** the owner enables it in Quirky
   - **Then** ✓ it runs on its schedule in Quirky; ✓ nothing pauses it in Orca Dev, which the owner does by hand

9. **SC-9: Something sends the owner back to Orca Dev**
   - **Given** day 4* of the daily-driver week
   - **When** the owner opens Orca Dev because Quirky can't do something
   - **Then** ✓ an issue labeled `sends-me-back` is filed in the Quirky repo; ✓ it's fixed before other work; ✓ the week starts over from day 1 once it ships

10. **SC-10: The week passes**
    - **Given** seven days in a row of real work in Quirky without opening Orca Dev
    - **When** the week ends
    - **Then** ✓ zpyoung/orca is archived on GitHub; ✓ its release workflow is off; ✓ Orca Dev stays installed with no further updates

11. **SC-11: The owner's own `orca` uses move at the start of the week**
    - **Given** the import is done and the week is about to start
    - **When** the switch to `quirky` runs
    - **Then** ✓ these move to `quirky`: the Orca ask section of the global CLAUDE.md, `~/.local/bin/orca-ask-wait`, the installed orca-cli, orca-ask, orchestration and computer-use skills (Quirky ships renamed versions), and memory notes that name the `orca` CLI; ✓ anything missed still reaches Orca Dev until it's caught

12. **SC-12: Upstream review**
    - **Given** two weeks have passed since the last review
    - **When** the review runs
    - **Then** ✓ an agent reads stablyai/orca releases since the last review; ✓ it opens one proposal listing candidate ports, each with what it fixes or adds; ✓ nothing is ported until the owner picks it; ✓ each pick lands as an ordinary PR, renamed to Quirky

## After the cutover

The **chat port** comes next and has its own brainstorm and spec. Quirky's structured sessions and chat UI replace Orca's native chat and the fork's native-chat features. The sessions cover headless runs, the journal and permission prompts as asks. The UI covers the visual panel with `quirky view`, the header, plan mode, paging and Streamdown. That spec decides what happens to the shared agent composer and the terminal-dock composer.

Later ports each get their own spec, in an order set when each comes up:

- PTY history log with checkpoints
- Ask extensions: typed number and date questions, defaults, timeouts, credential refusal, draft persistence
- `quirky feedback`
- The brain (avatar)
- Mobile direct pairing over LAN or tailnet

## Scope and non-goals

In scope: steps 1 to 7 of the sequence, plus the upstream review routine.

Out of scope:

- Windows, Linux and the hosted relay
- Automatic upstream merges or a sync schedule
- Lifting Quirky code through an adapter, or rebuilding Quirky's Bun daemon or plugin kernel
- New plugin API work
- Fixes to old Quirky after the flip
- The phone app during the daily-driver week; direct pairing comes after the cutover

## Decisions Locked

**Intent**
- Drivers: Quirky stability, upstream pace, the Bun/Electrobun bet not paying off
- Fork model: hard fork, cloned once
- End goal unchanged: replace VSCode and Orca, with the brain as the entry point
- Quirky repo kept; today's main archived; the Orca-based version becomes Quirky

**Starting snapshot and upstream intake**
- Start from zpyoung/orca as it is (upstream v1.4.237 + fork features); the planned last sync was dropped (see Amendments)
- Upstream intake: a release review every two weeks proposes ports; nothing lands until the owner picks it
- Code changes anywhere; fork-sync tooling deleted
- zpyoung/orca archived once new Quirky passes the daily-driver week; Orca Dev is the fallback until then

**Rebrand and data**
- Full rename, code identifiers included
- `quirky` CLI only; the owner's scripts, skills and CLAUDE.md move at the start of the week
- Import Orca Dev state on first launch; existing worktrees stay in place
- Orca Dev and new Quirky fully separate (bundle id, data dir, socket, ports, URL scheme, keychain item)
- Old Quirky uninstalled at the flip; `~/.quirky` moved to `~/.quirky-v1-archive`
- Re-running the import adds only what's new in Orca Dev since the last import — assumed (the recommended answer; the spec was signed off with this question open)

**Trim**
- macOS only
- Hosted relay cut; mobile reconnects later over LAN or tailnet
- Bitbucket, Gitea and Azure DevOps cut; Linear, Jira, every agent CLI and computer use kept
- Trim right after the split, before the rename
- Telemetry, crash reporting, update feed and skills source cut or re-pointed away from Stably
- Every other Stably-hosted service cut too: artifact sharing, cloud sign-in, mobile push, feedback, changelog and plugin kill-list (see Amendments)
- Repos: `quirky.yaml` and `.quirky/` first, falling back to `orca.yaml` and `.orca/` (see Amendments)
- No phone app needed during the week

**Porting from Quirky**
- First port: Quirky's native chat replaces Orca's, engine and UI
- Worth porting later: structured sessions (part of the chat port), PTY history, view and feedback, ask extensions, the brain, mobile pairing
- The Orca fork's version wins where both exist
- Ports are rebuilt natively, with Quirky code and specs as reference

**Success and repo**
- Cutover done: seven days in a row of real work without opening Orca Dev
- Orca's full history becomes main; old main kept as `archive/v1` and `quirky-v1-final`
- ~300 MB memory: a goal, not a gate
- Approach: flip main first and build in the open
- UX review: skipped (no new screens in the cutover)

## Industry Insights

- Forks stay cheap when they carry few patches, each with a stated reason, merged often behind seams. The post-mortems share one failure: hand-applied changes nobody owns, whose sync cost compounds until upstream feels like a threat. ([Electron patches](https://electronjs.org/docs/latest/development/patches), [Meta, Escaping the fork](https://engineering.fb.com/2026/04/09/developer-tools/escaping-the-fork-how-meta-modernized-webrtc-across-50-+use-cases/), [Your fork will outlive your patience](https://dev.to/microseyuyu/your-fork-will-outlive-your-patience-a-systems-thinking-post-mortem-56pk), [Preset, Stop forking around](https://preset.io/blog/stop-forking-around-the-hidden-dangers-of-fork-drift-in-open-source-adoption/))
- Rewrites stall when two systems live side by side, when parity scope keeps growing, or when language, architecture and runtime all change at once. What's worth salvaging first is design work and edge-case tests, not modules. ([The Rewrite Trap](https://haseebafsar.substack.com/p/the-rewrite-trap), [Why Big Rewrites Fail](https://potapov.dev/blog/why-rewrites-fail/), [LessAnnoyingCRM](https://lessannoyingcrm.com/resources/code_rewrite_cautionary_tale))
- Framework memory numbers measure idle footprint only and contradict each other, so they don't decide Electron against Electrobun on their own. ([Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/), [framework comparison #135](https://github.com/pierophp/ai-mission-manager/issues/135))
- Swapping a repo's history: tag the old main first and avoid renaming it, because a rename retargets open PRs. A merge that keeps one side's tree replaces the tree without a force-push. ([git-merge](https://git-scm.com/docs/git-merge), [GitHub: renaming a branch](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/renaming-a-branch), [GitHub: workflow triggers](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows))
- Renaming an Electron app changes its userData path, single-instance lock scope, URL scheme, macOS permission (TCC) identity, keychain safe-storage item and helper bundle names. Each needs handling, or the app silently starts from an empty profile or collides with the original. ([Electron app API](https://www.electronjs.org/docs/latest/api/app), [Mnemo PR #7](https://github.com/apathywoke/Mnemo/pull/7), [Electron app distribution](https://www.electronjs.org/docs/latest/tutorial/application-distribution), [SwoopByte on TCC](https://swoopbyte.com/blog/mac-app-permissions-change-after-update/))
- For large deletions, delete first and rename after, in many small PRs, rerunning Knip after each cut. Watch for dynamic imports and string-keyed IPC channels, which compile cleanly and break at runtime. ([Sentry and Knip](https://gitnation.com/contents/dead-code-shouldnt-exist-how-we-removed-28k-lines-of-code-one-knip-at-a-time-3405), [Knip](https://knip.dev/guides/handling-issues), [cairn #175](https://github.com/ddutchie/cairn/issues/175))

## Deferred Ideas

- `[tech-spec]` Exact git commands for the split, and the order of protection-rule changes
- `[tech-spec]` Knip configuration and the dynamic entry points it needs
- `[tech-spec]` Rename tooling (ast-grep or ts-morph) and how to prove main and renderer IPC channel names still match
- `[tech-spec]` How keychain secrets are read from Orca Dev and re-encrypted
- `[tech-spec]` Which Orca CI lanes survive the macOS trim
- SSH remotes (~33k lines) and the AI vault (~29k) as later cut candidates; both stay for now
- Moving mobile direct pairing ahead of the week, if the phone turns out to matter during it

## Glossary

- **Hard fork.** A copy that never merges upstream automatically. Changes come in only as individual, hand-picked ports.
- **Orca Dev.** The owner's current build of zpyoung/orca, `com.zpyoung.orca`.
- **Old Quirky.** Today's Bun and Electrobun app, `dev.quirky.app`.
- **New Quirky.** The Orca-based app this spec produces, `com.zpyoung.quirky`.
- **The flip.** The moment Quirky main's tree becomes the synced fork's.
- **Upstream review.** The routine every two weeks that proposes ports from stablyai/orca releases.
- **Daily-driver week.** Seven days in a row of real work in new Quirky without opening Orca Dev.
- **Port.** A feature rebuilt natively in the new tree, using Quirky or upstream code as reference.

## Status & amendments

Status: Approved; tech spec written (gate fired: more than one session, crosses subsystems)

**Amendments:**

- 2026-11-24: Start point changed from "the fork after one last upstream sync" to "the fork as it is". The sync turned out to be stalled since Oct 24 on 19 unanswered owner decisions, with a red sync PR (#133) and 305 over-cap conflicts in a trial merge of upstream v1.4.273. The owner chose to skip it. Step 1 of the sequence is dropped: the split starts from zpyoung/orca main at `9b076575d12` (upstream v1.4.237), the installed Orca Dev build stays the fallback, and the first upstream review covers v1.4.238 to v1.4.273 to pick what's worth porting.
- 2026-11-24: Two decisions the owner made after approval, surfaced while writing the tech spec:
  - Repo config: Quirky reads `quirky.yaml` and `.quirky/` first and falls back to `orca.yaml` and `.orca/`, so existing repos keep working. New files use the Quirky names.
  - Stably-hosted services: all are cut, extending the trim's "cut everything that phones Stably". That removes artifact sharing (and the artifact-password feature built on it), cloud profile sign-in and mobile push notifications. LAN pairing still works.
- 2026-11-24: Corrected Orca Dev's data folder from `Application Support/orca-dev` to `Application Support/orca`. The installed Orca Dev.app writes there; `orca-dev` is a stale dev-runner profile last written Oct 19. New Quirky's folder is `Application Support/quirky`, from its package name. No decision changed.
