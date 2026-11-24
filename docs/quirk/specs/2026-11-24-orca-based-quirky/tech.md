# Tech spec: Quirky on an Orca base

**Status:** Reviewed (one review round, fixes applied)  
**Logic spec:** [logic.md](logic.md)

Paths are repo-relative to the tree after the flip, which is the synced zpyoung/orca main (today `/Users/zpyoung/PycharmProjects/orca`). Line numbers come from the pre-sync fork (upstream v1.4.238 + fork features) and drift after the last sync; resolve each anchor by its symbol, and treat the line as a hint.

## Architecture

The tree is Orca's Electron app: `src/main` (main process, ~975k lines), `src/renderer` (React, ~1.02M), `src/preload`, `src/shared`, `src/cli` (the CLI binary), `src/packages/process-host` (`@orca/process-host`), `native/` (Swift/Rust helpers), `mobile/` (Expo, its own pnpm workspace), `cloud/` (relay and push services, its own pnpm workspace). Tooling is pnpm 12, Vitest, oxlint/oxfmt, Knip (`config/knip.json`), electron-builder (`config/electron-builder.config.cjs`) and GitHub Actions (`.github/workflows`, 108 files; the merge gate is `pr.yml` job `verify`).

State lives in a per-profile SQLite authority, `profiles/<id>/profile-state.db`, one row per top-level `PersistedState` domain (`src/shared/persisted-state-types.ts:57-135`; schema `src/main/persistence/profile-state/profile-state-database-schema.ts`). Secrets go through Electron `safeStorage` (`src/main/host/electron-secret-store.ts`), keyed by the keychain item `<app name> Safe Storage`. Worktrees are discovered from git; only their metadata is stored.

Work runs in five phases, matching [the sequence](logic.md#the-sequence): last sync (in zpyoung/orca), split, trim (4 PRs), rename (1 PR built from a script), import (1 feature). The upstream-review routine is a small sixth piece.

## Code references

### Phase 0: last sync (dropped)

Back-link: [Amendments](logic.md#status--amendments). The owner skipped the last sync on 2026-11-24. The split starts from zpyoung/orca main at `9b076575d12791d34d64a69deb4f83fd8a5f062d` (upstream v1.4.237 + fork features). Leave the abandoned sync's artifacts alone: PR #133 on zpyoung/orca, the `backup/main-20261124-175333Z` ref, and the `last-upstream-sync` Orca worktree. They disappear with the archive. The first upstream review covers v1.4.238 through v1.4.273.

### Phase 1: split (zpyoung/quirky)

Back-link: [The sequence, step 2](logic.md#the-sequence), [SC-1](logic.md#scenarios), [SC-5](logic.md#scenarios).

Delete (fork-sync machinery):

- `.claude/skills/sync-upstream/`, `config/fork-ownership.json`, `docs/fork-upstreaming.md`, `.github/scripts/check-fork-ownership.mjs`
- `config/scripts/fork-sync-precheck/`, `config/scripts/fork-sync-gate/`, `config/scripts/fork-ownership-guard/`, `config/scripts/fork-ownership-manifest.mjs` (+test), `config/scripts/check-fork-ownership.test.mjs`, `config/scripts/sync-upstream-file-ownership.mjs` (+test), `config/scripts/fork-release-recovery/`
- `pr.yml` job `fork_ownership_guard`, its entry in `verify.needs`, and the import of `fork-ownership-guard/aggregate-gate-jobs.mjs` in `config/scripts/pr-aggregate-gate-context.mjs` plus its contract tests
- The "Fork Feature Structure" section of `AGENTS.md`

Rewrite:

- `.claude/skills/release/SKILL.md`: drop the `-rc.N.zyNN` scheme and `upstream_synced` frontmatter; version Quirky on its own line (see Contracts).
- `AGENTS.md`: Quirky's test rules (below), no fork tiers.
- `.gitignore`: add `/research/`, `.memsearch/`.
- `LICENSE`: keep "Copyright (c) 2026 Lovecast Inc." and add the owner's notice.
- `.github/CONTRIBUTING.md`, `.github/CODEOWNERS`: drop upstream references.

Keep `config/scripts/sync-anti-slop-plugin.mjs`: `pnpm lint` runs it through `audit:anti-slop`; it is not sync tooling.

Keep: every `fork-*` product directory under `src/` (heimdall, sitter, objective, loops, ask tool, worktree groups, native-chat-*, terminal-dock, session-handoff and the rest). They are product code; only the manifest goes. Also keep the in-app git "fork sync" feature (`src/main/git/fork-sync.ts`, `RepositoryForkSyncSection.tsx`, the `git-fork-sync` IPC), which is unrelated.

CI at the flip (must land in the housekeeping commits, before main moves): the fork's workflows go live on zpyoung/quirky the moment main changes. 16 have `schedule:` triggers and 33 use Blacksmith runners.

- Remove every `schedule:` trigger (hourly/daily mac builds, cloud monitors, cache warmups and the rest); scheduled runs come back only by a later, deliberate PR.
- Switch every Blacksmith `runs-on` label to the GitHub-hosted equivalent (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-15`). This follows the Ask item `ci-runners`, which must be answered before main moves.
- Delete the release-repo guards' fork name: `if: github.repository == 'zpyoung/orca'` in `release-cut.yml` and `release-mac-build.yml` becomes `zpyoung/quirky`.
- Workflows that cut 2 and cut 3 delete later (globs): `win-*`, `windows-*`, `wsl-*`, `dev-channel-win-*`, `ssh-windows-hosts`, `linux-wayland-gpu-sandbox`, `terminal-ime-e2e`, `ssh-hostile-hosts`, `packaged-browser-e2e`, `node-next-compat`, `mobile-android-release`, `git-command-termination-runtime`, `daemon-relocation-spike`, `preflight-cli-platforms` (cut 2); `cloud-*` (cut 3). Until then they only run on PRs whose paths match, and any failure there is advisory (only `pr.yml` `verify` gates).

Old Quirky on this Mac (SC-5, done by the orchestrator with the owner's confirmation right after main moves): quit `~/Applications/Quirky.app` and stop its detached `quirkyd` and `quirky-pty` processes if running, delete the app bundle, and move `~/.quirky` to `~/.quirky-v1-archive`. `~/Library/Application Support/dev.quirky.app` stays; its name collides with nothing.

Carry from today's Quirky main into the new tree: `docs/quirk/specs/2026-11-24-orca-based-quirky/` (this spec). Nothing else; the rest stays reachable through `quirky-v1-final`.

### Phase 2: trim

Back-link: [SC-2](logic.md#scenarios), [Decisions Locked → Trim](logic.md#decisions-locked).

**Cut 1, Stably endpoints.**

- Delete `src/main/telemetry/`, `src/main/ipc/telemetry.ts` (+test), `src/shared/telemetry-*.ts`, `src/shared/*-telemetry.ts`, `src/renderer/src/lib/{telemetry,native-chat-telemetry,feature-education-telemetry,react-commit-cascade-telemetry}.ts`, `config/scripts/verify-telemetry-constants.mjs`, and the telemetry copy in `src/renderer/src/components/settings/PrivacyPane.tsx` and `privacy-search.ts`.
- Crash reporting: delete only the remote submit and upload path (`src/main/ipc/crash-reporting-submission.ts`, the `crashReports:submit` handler in `src/main/ipc/crash-reporting.ts`, `crash-feedback-diagnostic-bundle.ts`, `src/main/observability/diagnostic-upload-endpoint.ts`). Keep `src/main/crash-reporting/` local breadcrumbs; ~40 files import them.
- Wiring: `src/main/ipc/register-core-handlers/register-core-handlers.ts` (feedback, crash, diagnostics, telemetry registrations), `src/main/startup/main-process-observers.ts` (`initTelemetry`), `src/preload/index.ts` and `src/preload/api-types.ts` (`telemetryTrack*`, `crashReportsApi` submit), `electron.vite.config.ts` build constants `ORCA_POSTHOG_WRITE_KEY`, `ORCA_BUILD_IDENTITY` use for telemetry, `ORCA_DIAGNOSTICS_TOKEN_URL`, and `src/types/build-constants.d.ts`. About 110 `track()` call sites; the typecheck finds them.
- onorca.dev and Stably-hosted services (all cut; see `stably-services` below): `src/main/ipc/feedback-request.ts` (+`feedback.ts`), `src/main/updater-changelog.ts`, `src/main/updater-nudge.ts` and `src/main/updater/updater-nudge.ts`, `src/main/plugins/plugin-kill-list-service.ts`, `src/main/orca-profiles/profile-cloud-*` (cloud sign-in, ~20 files) with `OrcaAccountSettingsPane.tsx` and `orca-account-settings-search.ts`, `src/main/artifacts/artifact-cloud-config.ts` and the artifact share/upload flow including `src/main/artifacts/fork-artifact-passwords/`, `src/main/runtime/push/` (push gateway client), `src/shared/skill-share-link.ts` share hosts, `src/shared/plugins/plugin-marketplace.ts` default `stablyai/orca-plugins` source, `src/main/github/client/fetch/orca-star.ts` and the `gh:checkOrcaStarred`/`gh:starOrca` handlers (`src/main/ipc/github-account-handlers.ts`, preload `src/preload/api/gh-bridge-mutations-and-projects.ts`), help and docs links in `SidebarSettingsHelpMenu.tsx`, `MobileSettingsPane.tsx`, `mobile-platform-copy.ts`, `feature-wall-tiles.ts`, `feature-wall-workflows.ts`.
- Re-point: update feed (`src/main/updater/updater-setup.ts` `setFeedURL`, `src/main/updater/updater-release-feed.ts`, `src/main/updater-prerelease-feed.ts`, `config/dev-app-update.yml`, `config/electron-builder.config.cjs` `publish`) to zpyoung/quirky; dev channels in `src/shared/release-channel.ts` (`stablyai/orca-hourly|daily|adhoc`) removed; skills source `src/shared/fork-skills-repository/skills-repository-url.ts` and `src/shared/skill-freshness.ts` `ORCA_SKILL_LOCK_SOURCE` to zpyoung/quirky. `AGENT_STATE_RULES_RELEASE_REPO` (`release-channel.ts:29`) is decided in Ask.
- CI: the telemetry and diagnostics secrets and env in `release-mac-build.yml`, `release-cut.yml`, `release-javascript*.yml`, `hourly|daily|adhoc-mac-build.yml`, `config/scripts/release-javascript-artifact.mjs`.

**Cut 2, Windows, Linux and WSL.**

- Delete: `src/main/wsl/`, `src/main/windows/`, `src/wsl-guest/`; `native/{windows-agent-hook,windows-cli-launcher,windows-registry,windows-security,computer-use-windows,computer-use-linux,wayland-clipboard}`; `config/nsis/`, `config/electron-builder-pr-linux.config.cjs`, Linux-only `config/docker/*` (keep `config/docker/test-sandbox`); top-level `src/main/{wsl-*,win32-utils,windows-*,jetbrains-windows-gui-launchers,linux-*,preflight-wsl-cache,pwsh,powershell-osc133-bootstrap,appimage-runtime-identity}.ts`; `src/main/ipc/{wsl-host-handlers,wsl-move-handlers}.ts`; `src/preload/api/{wsl-bridge,wsl-hosts-api,wsl-move-bridge}.ts`; renderer Windows/WSL settings sections; `*.wsl.test.ts`, `*.win32.test.ts`, `tests/tools/{win-*,windows-*}`; the ~18 Windows/WSL/Linux workflows and their composite actions (`prepare-windows-*`, `prepare-wayland-clipboard`, `prepare-linux-package-fixture`, `setup-wsl-test-runtime`, `install-signpath-module`).
- Wiring: `config/electron-builder.config.cjs` `win`, `nsis`, `linux`, `appImage`, `deb`, `rpm` blocks and AppImage hooks; `package.json` scripts (`build:wsl-guest` and its callers, `build:linux`, `build:win`, `test:linux-cli-contract`, Windows smoke and WSL benches) and deps (`@orca/windows-*`, `@vscode/windows-process-tree`, `sherpa-onnx-linux-*`); `pnpm-workspace.yaml` entries for `native/windows-*`; `register-core-handlers.ts` WSL registrations; `config/knip.json` entry for `src/wsl-guest/wsl-agent-hook-relay.ts`.
- Scope limit: delete what this list names plus `process.platform` branches inside files the cut already edits. Remaining `win32`/`linux` branches elsewhere stay as harmless dead code. Persisted `wsl` host kinds must still load (normalize to dropped), because imported state can carry them.

**Cut 3, hosted relay.**

- Delete: `cloud/` in full (relay apps, relay-ops, fence broker, relay contract, terraform, and the push app and contract, since push is cut too); `src/main/runtime/mobile-cloud-relay/`, `src/main/runtime/mobile-desktop-relay/`, `src/main/runtime/rpc/relay-transport.ts`, `src/main/runtime/rpc/methods/mobile-relay-hosts.ts`, `src/main/ipc/runtime-environments/runtime-environment-mobile-relay-hosts.ts`, `src/main/startup/main-process-relay-{startup,status}.ts`; renderer `MobileRelaySignInPanel.tsx`, `MobilePairingConnectionOptions.tsx` and relay parts of `MobilePane.tsx`/`MobilePairingSetupSection.tsx`; ~29 `cloud-*.yml` workflows plus `cloud-verify.yml` and `.github/actions/cloud-sql-rollout-lease`; `tests/e2e/relay-region-*.unit.test.ts`, `src/main/runtime/push/push-host-proof-vector.test.ts`; `docs/relay-region-correction/`, `tests/tools/relay-bench/`, relay benchmark scripts.
- Wiring: `src/main/startup/main-process-runtime-launch.ts`, `main-process-state.ts` (`desktopRelay*`), `main-window-core-services.ts`, `main-process-quit.ts`, `src/main/runtime/rpc/methods/index.ts` (`MOBILE_RELAY_HOSTS_METHODS`), runtime-rpc pairing and device registry files, `src/preload/api/{mobile-api,mobile-bridge}.ts`, `config/scripts/pr-code-change-scope.mjs` cloud entries, `config/reliability-gates.jsonc` cloud gates.
- Keep: the `src/shared/mobile-relay-*` contract files and `src/shared/relay-host-close-reason.ts` that `mobile/` imports, so mobile still typechecks. Keep every SSH file named `relay` (`src/main/ssh/relay-*`, `src/shared/relay-frame-*`, `src/main/ssh/legacy-relay/`); they are SSH, not the hosted relay.

**Cut 4, Bitbucket, Gitea, Azure DevOps.**

- Delete: `src/main/{bitbucket,gitea,azure-devops}/`, `src/main/source-control/hosted-review-{bitbucket,gitea,azure-devops}.integration.test.ts`, `src/main/ipc/bitbucket.ts`, `src/preload/api/bitbucket-bridge.ts`, `src/shared/bitbucket-credentials.ts`, the Bitbucket card and dialog, and the Gitea/Azure cards in `token-source-control-integration-cards.tsx`.
- Wiring: `src/main/source-control/{forge-provider,hosted-review-creation-provider,hosted-review,forge-review-mappers}.ts`, `register-core-handlers.ts`, `src/preload/index.ts`, `src/main/preflight/agent-detection.ts`, `src/main/orcad/orcad-plaintext-credential-migration.ts`, `src/main/git/{hosted-remote-url,git-username}.ts`, provider unions in `src/shared/{hosted-review,hosted-review-creation-providers,workspace-reference-identity,pull-request-generation}.ts`, `src/shared/worktree/types.ts`, `src/shared/rpc-contract/git-params.ts`, renderer integrations pane and onboarding.
- Persisted `linkedBitbucketPR`, `linkedAzureDevOpsPR`, `linkedGiteaPR` (`src/shared/workspace-attachment-legacy.ts`) and cached hosted reviews with these providers must normalize to dropped, never crash.

### Phase 3: rename

Back-link: [The sequence, step 4](logic.md#the-sequence), [SC-3](logic.md#scenarios), [Identity on one Mac](logic.md#identity-on-one-mac).

Size: ~119k matching lines in ~14k files, 1,379 paths, ~1,632 distinct `ORCA_*` env names, `orcad` (7.6k) as its own product name, no central IPC registry (~889 `ipcMain` and ~1,118 `ipcRenderer` call sites with inline `'namespace:method'` strings).

Create:

- `config/scripts/rename-to-quirky/rename.mjs`: the deterministic rename (contract below), committed with its mapping table and run once.
- `config/rename-allowlist.json`: the allowlist both the script and the guard read.
- `config/scripts/check-no-orca-strings.mjs`: the CI guard, added to `pnpm lint`.
- `config/scripts/check-ipc-channel-parity.mjs`: extracts channel names and checks every renderer-side channel has a main-side handler.

Identity anchors the rename must land on (each currently Orca or Orca Dev):

- `config/electron-builder.config.cjs`: `appId` (l.74, `com.zpyoung.orca`), `productName` (l.210, `Orca Dev`), `protocols` (l.211, `orca`), helper names (`Orca Computer Use.app`, `orca-keyboard-layout`, `orca-notification-status`), mac artifact names, `publish` (l.762-770)
- `package.json`: `name` (`orca`, which sets the userData folder), `bin` (`orca`, `orca-dev`), `homepage`, `author`
- `src/shared/local-build-compatibility-contract.{ts,json}`: pinned `appId`
- `src/main/startup/dev-instance-identity.ts`: `BASE_APP_NAME`, `BASE_APP_USER_MODEL_ID`, dev `appName`
- `src/main/startup/configure-process.ts`: dev userData `orca-dev`, `ORCA_USER_DATA_PATH`
- `config/scripts/dev-electron-bundle-identity.mjs`, `config/scripts/run-electron-vite-dev.mjs`: dev bundle id and dev userData
- `src/main/macos-tcc-prompt-watch.ts`, `src/main/macos-press-and-hold-default.ts`, `src/main/ipc/notification-system-settings-link.ts`, `config/scripts/build-notification-status-macos.mjs`: hard-coded bundle ids
- `src/main/computer/macos-computer-use-permissions.ts`, `config/scripts/build-computer-macos.mjs`, `native/computer-use-macos/...AuthenticatedConnectionHangupMonitor.swift`: computer-use ids
- `src/main/daemon/macos-daemon-job-label.ts`, `src/shared/serve-bundle-coordination.ts`: launchd label prefixes
- `src/main/cli/cli-install-location.ts`, `cli-install-constants.ts`, `src/shared/orca-cli-command-name.ts`, `src/main/cli/bundled-cli-launcher-path.ts`, `src/main/cli/orca-cli-child-path.ts`, `resources/darwin/bin/orca`: CLI name and install path
- Every `join(homedir(), '.orca', …)` site (agent-hooks, keybindings, credential stores, zcode, orcad paths): home dir
- `src/shared/pairing.ts`, `mobile/src/transport/pairing.ts`: `orca://pair`
- `mobile/app.json`, `mobile/app.config.js`: name, slug, scheme, iOS/Android ids (`com.stably.orca.mobile`)
- Locale catalogs `src/renderer/src/i18n/locales/*.json` and `config/scripts/locale-brand-mistranslations.mjs`: brand

CONFIG: target identity values. The rename script applies these explicit mappings before its generic ones, because the generic mapping would produce wrong values (`Quirky Dev`, `com.stablyai.quirky`).

| Anchor | Today | Target |
|---|---|---|
| `productName`, About name | `Orca Dev` | `Quirky` |
| `package.json` `name` (sets userData and the keychain item) | `orca` | `quirky` → `Application Support/quirky`, keychain `quirky Safe Storage` |
| `appId` | `com.zpyoung.orca` | `com.zpyoung.quirky` |
| `BASE_APP_NAME`, `BASE_APP_USER_MODEL_ID` | `Orca`, `com.stablyai.orca` | `Quirky`, `com.zpyoung.quirky` |
| Any `com.stablyai.orca*` / `com.stably.orca*` id (helpers, computer use, launchd prefixes, dev bundle) | `com.stablyai.orca.<x>` | `com.zpyoung.quirky.<x>` |
| Dev runner | `com.stablyai.orca.dev`, `orca-dev` userData, `orca-dev` bin | `com.zpyoung.quirky.dev`, `quirky-dev`, `quirky-dev` |
| CLI | `orca`, `/usr/local/bin/orca` | `quirky`, `/usr/local/bin/quirky` |
| Home dir | `~/.orca` | `~/.quirky` |
| URL schemes | `orca`, `orca-preview`, `orca-media`, … | `quirky`, `quirky-preview`, `quirky-media`, … |
| Runtime WebSocket ports | `6768` default, `6769` dev pin | `6778` default, `6779` dev pin, so Quirky and Orca Dev never race for one port |
| Mobile | name `Orca`, slug `orca-mobile`, scheme `orca`, `com.stably.orca.mobile` | `Quirky`, `quirky-mobile`, `quirky`, `com.zpyoung.quirky.mobile` |
| Update feed, skills source, `homepage` | `zpyoung/orca`, `github.com/stablyai/orca` | `zpyoung/quirky`, `github.com/zpyoung/quirky` |
| About credit | none | `setAboutPanelOptions` in `src/main/startup/gpu-lifecycle.ts` gains "Based on Orca by Lovecast Inc. (MIT)" |

Repo config fallback (owner decision `repo-config`, 2026-11-24): readers of per-repo config try the Quirky name first and fall back to the Orca name. Readers: `src/main/hooks.ts` (`orca.yaml` reads at ~l.120, 137, 153), `src/main/effective-hook-config.ts`, `src/main/worktree-runner-script.ts`, `src/cli/handlers/vm.ts` (l.47, 264), `src/main/issue-command-file.ts` (`ORCA_DIR = '.orca'`). Home-dir strings `~/.orca/` are not repo config; they rename to `~/.quirky/` like any other match. New files are always written under the Quirky name. Agent hook files Quirky installs into other tools' homes (for example Copilot's `hooks/orca.json` in `src/main/copilot/hook-service.ts`) are renamed outright; they are Quirky's own installs, not the owner's repo files.

### Phase 4: import from Orca Dev

Back-link: [SC-6](logic.md#scenarios), [SC-7](logic.md#scenarios), [SC-8](logic.md#scenarios).

Create `src/main/import-from-orca/` (an allowlisted path; it is the one module that must name Orca's identity). Reuse, don't copy:

- `src/main/persistence/profile-state/legacy-json/profile-state-legacy-import.ts`: imports a `PersistedState` JSON into a fresh profile and establishes the SQLite authority. The importer writes through this route; it never copies `profile_state_documents` rows, because their `content_hash` and `revision` guards would break.
- `src/main/orca-profiles/profile-legacy-state-import.ts` (`copyLegacyStateToProfile`): the copy-if-absent, tmp-then-rename pattern.
- `src/main/persistence/loading-store/user-data-path.ts` (`migrateMobilePairingDataToCanonicalUserDataPath`): all-or-nothing copy with rollback.
- `src/main/host/electron-secret-store.ts`, `src/main/protected-secret-persistence.ts`, `src/main/persistence/loading-store/secret-sentinel-substitution.ts`: Quirky-side encryption and the `orca-secret-slot-<uuid>` sentinel format.
- `src/main/credentials/encrypted-api-key-file-store.ts`, `src/main/plugins/plugin-secrets-store.ts`: encrypted file formats under the home dir and plugins-data.
- `src/main/browser/browser-cookie-key.ts`: already reads a keychain password and derives the `saltysalt` PBKDF2 key for Chrome cookies; reuse its derivation instead of writing a second one.
- `src/main/persistence/profile-state/` export writers (`writeProfileStateAuthorityJsonExport`, `writeVersionedProfileStateExport`): turn a `profile-state.db` into a `PersistedState` JSON, the same shape as the on-disk `orca-data.json.sqlite-export.*.json` files. The importer runs this against its snapshot copy to get the source state.
- `src/main/persistence/loading-store/store.ts` (`Store`): the live store. The importer applies its plan through `Store`'s domain setters, so first-run and rerun take the same path and the store keeps its own authority, hashes and revisions.

Shared types and IPC (pinned): `src/shared/import-from-orca-types.ts` holds `ImportReport`, `ImportError` and `ImportDetectResult`; `src/main/ipc/import-from-orca.ts` registers `importFromOrca:detect` and `importFromOrca:run`; `src/preload/api/import-from-orca-bridge.ts` exposes them to the renderer.

UI: a first-launch offer when Quirky has no profile state and the Orca Dev source exists, plus a settings action "Import from Orca" (Settings → General). Exact placement is the implementer's call within those two surfaces.

### Phase 5: daily-driver week and archive

Back-link: [SC-9](logic.md#scenarios), [SC-10](logic.md#scenarios), [SC-11](logic.md#scenarios).

Before the week starts (SC-11), the orchestrator makes these edits outside the repo, each confirmed by the owner:

- `~/.claude/CLAUDE.md` and `~/CLAUDE.md`, the "Orca ask" sections: `orca ask` becomes `quirky ask`, `orca-ask-wait` becomes `quirky-ask-wait`.
- `~/.local/bin/quirky-ask-wait`: a copy of `~/.local/bin/orca-ask-wait` that calls `quirky ask wait`. The old script stays until the archive step, for Orca Dev.
- Installed skills `~/.agents/skills/{orca-ask,orca-cli,orchestration,computer-use}` (symlinked from `~/.claude/skills/`): install Quirky's renamed copies with `npx skills add` from zpyoung/quirky, then remove the orca-named copies and symlinks.
- Memory notes in `~/.claude/projects/-Users-zpyoung-PycharmProjects-PERSONAL-quirky/memory/` that name the `orca` CLI (5 files today): switch to `quirky`.

COMMAND: the week's label, created once.
```
gh label create sends-me-back -R zpyoung/quirky --description "Something sent the owner back to Orca Dev"
```

COMMAND: archive (SC-10), after the owner confirms the week passed.
```
gh workflow disable release-cut.yml -R zpyoung/orca
gh workflow disable hourly-mac-build.yml -R zpyoung/orca
gh repo archive zpyoung/orca --yes
rm ~/.local/bin/orca-ask-wait
```

### Upstream review routine

Back-link: [SC-12](logic.md#scenarios). Create `.claude/skills/upstream-review/SKILL.md` and a Quirky automation definition the owner enables. It reads stablyai/orca releases since the version in `docs/upstream-review/last-review.md` (seeded with `v1.4.237`, so the first run covers v1.4.238 onward), writes one proposal file `docs/upstream-review/<date>.md` listing candidate ports (what each fixes or adds, upstream PR links), opens it as a draft PR, and updates `last-review.md` only when the owner merges the proposal.

## Contracts & interfaces

### Split

COMMAND: run in a fresh worktree; `orca-fork` is a remote for `git@github.com:zpyoung/orca.git`.
```
git fetch origin && git fetch orca-fork main
git tag quirky-v1-final origin/main
git push origin quirky-v1-final origin/main:refs/heads/archive/v1
git switch -c zpyoung/flip orca-fork/main
git merge -s ours --allow-unrelated-histories origin/main -m "chore: Quirky continues on the Orca base; v1 is archived at quirky-v1-final"
```

COMMAND: move main by direct push, never through a PR (a squash or rebase merge would drop old Quirky from main's ancestry). Main has no branch protection or rulesets today.
```
git push origin zpyoung/flip:main
```

- Postconditions: `git diff orca-fork/main zpyoung/flip --stat` is empty before the housekeeping commits; `git merge-base --is-ancestor origin/main zpyoung/flip` succeeds; housekeeping lands as further commits on `zpyoung/flip`; main moves by fast-forward only.
- Push size: Orca's packed objects are ~1.5 GiB across all refs, under GitHub's 2 GB per-push limit. If the push is rejected for size, push ancestors first.

COMMAND: chunked fallback, only on a size rejection.
```
for n in 12000 8000 4000; do git push origin "orca-fork/main~$n:refs/heads/tmp/orca-import-$n"; done
git push origin zpyoung/flip:main
git push origin --delete tmp/orca-import-12000 tmp/orca-import-8000 tmp/orca-import-4000
```

- The local `research/` pre-push hook must keep passing; Orca's history has no `research/` path (checked).

### Rename script

CONTRACT: `node config/scripts/rename-to-quirky/rename.mjs [--dry-run] [--report <file>]`

- Input: the tracked tree (`git ls-files`), `config/rename-allowlist.json`.
- Mapping, applied longest-first and case-preserving: `orcad→quirkyd`, `Orcad→Quirkyd`, `ORCAD→QUIRKYD`, `orca→quirky`, `Orca→Quirky`, `ORCA→QUIRKY`. It applies inside identifiers (`OrcaRuntimeService→QuirkyRuntimeService`, `orcaPage→quirkyPage`), strings, env vars, CSS, locale values, docs, and file and directory names (via `git mv`).
- Exclusions come only from the allowlist: path globs that are skipped whole, and literal tokens that are never rewritten.
- `--dry-run` writes the report (per-file counts, every renamed path, and every match inside a word where `orca` is not at a camel or separator boundary, for review) and changes nothing.
- Postconditions after a real run: `check-no-orca-strings` passes; `pnpm install` regenerates `pnpm-lock.yaml` for `@quirky/*`; `oxfmt` leaves no diff; the IPC parity check passes.
- Idempotent: a second run changes nothing.

CONTRACT: `resolveRepoConfigPath(repoPath: string, kind: 'yaml' | 'dir'): string | null` returns `<repo>/quirky.yaml` (or `<repo>/.quirky/`) when it exists, else `<repo>/orca.yaml` (or `<repo>/.orca/`) when that exists, else `null`. Every reader goes through it; writers always use the Quirky name. It lives in `src/shared/repo-config-paths.ts`, which is on the rename allowlist because it must name the legacy files.

CONTRACT: `node config/scripts/check-no-orca-strings.mjs` exits 1 and prints `file:line` for each match of the exact-case variants `orca`, `Orca` or `ORCA` (which also cover `orcad`, `Orcad`, `ORCAD`) outside the allowlist; exit 0 otherwise. Mixed-case runs inside other words (`errorCategory`, `optionsOrCallback`, `NSURLErrorCancelled`: 541 hits in 170 files today) are not the brand and are never flagged, matching the rename mapping, which never rewrites them.

CONTRACT: `node config/scripts/check-ipc-channel-parity.mjs [--json]` collects string-literal channels from `ipcMain.handle|on|once`, `ipcRenderer.invoke|send|on|once`, `webContents.send`, and the `*_CHANNEL(S)` const maps; exits 1 listing every renderer-side `invoke`/`send` channel with no main-side handler, and every main-side `webContents.send` channel no renderer listens to. Run it before the rename to record the baseline set of known mismatches in `config/ipc-channel-parity-baseline.json`; after the rename, the mismatch set must equal the baseline with the mapping applied.

### Import

CONTRACT: `importFromOrcaDev(options: { mode: 'first-run' | 'rerun' }): Promise<ImportReport>`

- Preconditions: running inside Quirky (`app.getName()` is not `Orca Dev`); source root `~/Library/Application Support/orca` exists with `orca-profile-index.json`.
- Reads the source read-only. `profile-state.db` is copied with SQLite's online backup API into a temp file first, so Orca Dev can stay open; the importer never opens the source database for writing and never writes any file under the source root or `~/.orca`.
- Secrets: the source key is the keychain item `orca Safe Storage` (account `orca Key`). Packaged Orca Dev takes its app name from `package.json` `name`, the same name that sets its `Application Support/orca` folder. `Orca Dev Safe Storage` also exists on this Mac but belongs to the dev runner's stale `orca-dev` profile. The importer reads the primary item's password once (macOS prompts the owner), proves it by decrypting one known secret slot, and only then tries `Orca Dev Safe Storage` as a fallback, recording which item worked in the report. It derives the Chromium OSCrypt key, decrypts each `v10`-prefixed value, and re-encrypts it with Quirky's `safeStorage`. A value that fails to decrypt is skipped and listed in the report; the importer never writes plaintext, and aborts the secrets step if Quirky's `safeStorage` is unavailable.
- Builds the source `PersistedState` from the snapshot with the export writers, transforms it per the mapping table into an `ImportPlan`, and applies the plan to Quirky's active profile (`local-default` at first launch) through `Store` setters, adding items and never replacing existing ones. Copies account material dirs; writes `orca-import-receipt.json` in Quirky's userData.
- `rerun` adds only items whose ids are absent from both the receipt and Quirky's current state; it never deletes and never restores an item the owner removed in Quirky.
- Errors: `SOURCE_MISSING`, `SOURCE_INCOMPATIBLE` (profile-state build compatibility or schema version mismatch), `KEYCHAIN_DENIED` (import continues without secrets), `WRITE_FAILED` (rolls back everything written in this run).

PSEUDOCODE (justified, ≤3 lines): OSCrypt on macOS is undocumented by Electron, so the derivation is pinned here.
```
key = PBKDF2-HMAC-SHA1(password=<keychain password>, salt="saltysalt", iterations=1003, length=16)
plaintext = AES-128-CBC-decrypt(key, iv=16 x 0x20, ciphertext=value[3:])  # value starts with "v10"
```

### Release versioning

CONFIG: Quirky versions start at `2.0.0` (today's Quirky never shipped a 2.x) and follow plain semver with `-rc.N` prereleases; no upstream anchor. Releases publish to zpyoung/quirky.

## Data models / schemas

SCHEMA: `config/rename-allowlist.json`
```
{
  "version": 1,
  "skipPaths": ["LICENSE", "CHANGELOG.md", "docs/quirk/specs/2026-11-24-orca-based-quirky/**",
                "src/main/import-from-orca/**", "src/shared/repo-config-paths.ts",
                "mobile/src/app-update/fixtures/**", "..."],
  "keepTokens": ["stablyai/orca", "Lovecast Inc.", "Claude Code-credentials", "..."],
  "creditLines": [{ "path": "README.md", "match": "Based on Orca" },
                  { "path": "src/main/startup/gpu-lifecycle.ts", "match": "Based on Orca" }]
}
```
`keepTokens` is literal and case-sensitive. The guard and the script read the same file. Legacy names the app still needs at runtime (`orca.yaml`, `.orca/`, Orca Dev's data folder and keychain item) live only in the two skipped modules, never as keep-tokens, so every other reader is renamed.

SCHEMA: import field mapping (source `PersistedState` domain → Quirky)

| Domain | Action |
|---|---|
| `repos`, `projects`, `projectHostSetups`, `folderWorkspaces`, `projectGroups` | copy |
| `worktreeMeta`, `worktreeMetaByIdentity`, `worktreeIdentityAliases`, `worktreeLineageById`, `retiredWorktreeNamesByRepo` | copy |
| `settings` | copy, then: set `workspaceDir` to `~/quirky/workspaces` so new worktrees land there (existing worktrees are found from git wherever they are); drop secret slots that failed to decrypt; rewrite `claudeManagedAccounts[].managedAuthPath` into Quirky's userData; drop `wslLinuxAuthPath` |
| `automations` | copy with `enabled: false`; `automationRuns` not copied |
| `sshTargets`, `sshTargetGenerationCounter`, `deletedSshConfigAliases`, `removedSshTargetTombstones` | copy; SSH remotes stay and copied repos reference them |
| `ui`, `onboarding`, `sparsePresetsByRepo`, `folderWorkspaceDiffComments`, `retiredWorktreeNamesByNamespace`, `workspaceLineageByChildKey` | copy |
| `sshRemotePtyLeases`, `sshPtyConsumerRecoveries`, `workspaceSession` (including its `localOnlyScrollbackByTabId`), `workspaceSessionsByHostId`, `remoteLayoutSnapshots`, `legacyPaneKeyAliasEntries`, `githubCache`, `nativeChatUpgradeTipAudience`, `orcadMigration*`, `migrationUnsupportedPtyEntries`, `featureInteractionTelemetryBuckets`, `codexResetCreditAttemptLedger`, `mobileClientTabSelectionsByDeviceId` | not copied |
| any domain not named in this table | not copied, and listed by name in the report so a later import version can add it |
| any domain naming a removed provider or host kind (wsl, bitbucket, gitea, azure) | normalized away |

Files copied from the source root: `claude-accounts/<id>/`, `codex-accounts/<id>/`, `claude-profiles/<id>/`. From `~/.orca`: `keybindings.json` to `~/.quirky/keybindings.json`; encrypted credential files (`*.enc`, Linear, Jira site, API keys) decrypted and re-sealed into `~/.quirky`. Not copied: daemon, terminal history, agent-session journal and recovery, mobile pairing (`orca-devices.json`, `orca-e2ee-keypair.json`), `orca-profile-index.json` cloud link, Chromium dirs, logs, backups, fork stores (heimdall, loops, objective, pipelines, sitter ledger, project ledgers).

SCHEMA: `orca-import-receipt.json`
```
{ "version": 1, "sourceRoot": string, "runs": [{ "at": ISO8601, "mode": "first-run"|"rerun",
  "imported": { "<domain>": [<id>, ...] }, "skippedSecrets": [<slot or file>, ...] }] }
```

## DO-NOT-CHANGE fences

- `src/main/ssh/**`, `src/shared/relay-frame-*`, `src/main/ssh/legacy-relay/**` during cut 3: SSH remotes stay, and these files only share the word "relay".
- `src/shared/mobile-relay-*` and `src/shared/relay-host-close-reason.ts` during cut 3: `mobile/` imports them; deleting them breaks mobile's typecheck before the direct-pairing port.
- `src/main/crash-reporting/**` except the submit and upload path: ~40 files depend on its local breadcrumbs.
- Every `fork-*` product directory: they are the features the owner uses; only the sync manifest goes.
- `src/main/git/fork-sync.ts` and its IPC: an in-app git feature, unrelated to fork-sync tooling.
- `config/docker/test-sandbox/`: `pnpm test:sandbox` needs it.
- `src/main/claude-accounts/keychain.ts` (`'Claude Code-credentials'`) and `src/main/rate-limits/cursor-auth.ts` keychain names: they belong to other tools; the rename allowlist must cover them if they ever match.
- Source-side files of the import: the importer must never open for writing anything under `~/Library/Application Support/orca` or `~/.orca`.

## Always / Ask / Never

**Always**

- One PR per trim cut; typecheck, lint, Knip and the cut's targeted tests green before the next cut opens.
- Run the rename script in `--dry-run` first and commit the report with the PR for review.
- Keep the build installable side by side with Orca Dev after every phase from the rename on.
- Normalize persisted data that names a removed provider or platform instead of failing to load.

**Ask** (all answered by the owner on 2026-11-24)

- `agent-state-rules`: freeze today's agent-state detection rules in the repo instead of downloading them from upstream (`AGENT_STATE_RULES_RELEASE_REPO`, `src/shared/release-channel.ts:29`, and `.github/workflows/agent-state-rules-publish.yml`). Done in cut 1.
- `ci-runners`: GitHub-hosted runners. Every Blacksmith label switches in the housekeeping commits, before main moves.
- Repo secrets for releases (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `MAC_CERTS`, `MAC_CERTS_PASSWORD`) must be set on zpyoung/quirky by the owner before the first release; values can't be copied by API.
- `open-prs`: merge Quirky PRs #714 and #715 into old main if their CI is green, before the archive tag.
- `merge-policy`: cutover PRs merge once CI is green and the review loop passes. The flip push, removing old Quirky, edits to the owner's own files and archiving zpyoung/orca still need the owner's confirmation each time.

**Never**

- Force-push main, or rename `main` on either repo.
- Write to Orca Dev's data, keychain item or `~/.orca`.
- Write a decrypted secret to disk.
- Keep any call to an onorca.dev or Stably-owned endpoint after cut 1.
- Run the full test suite on this Mac; full runs go through PR CI.

## Cross-cutting

- **Security.** The import reads a keychain password and handles plaintext secrets in memory only; the report lists skipped slot names, never values. Deleting cloud sign-in also removes stored cloud session tokens on Quirky's side (there are none at first launch).
- **Migration.** Quirky starts from an empty userData, so renamed localStorage keys, mobile keychain keys and userData file names need no in-app migration. The importer is the only bridge, and it alone knows Orca's names.
- **Rollback.** Before the flip push, `archive/v1` and `quirky-v1-final` exist, so main can be restored by pushing `quirky-v1-final` back to main (owner confirmation required, since that is a force-push). Each trim and rename PR reverts cleanly on its own. Orca Dev stays installed through the week.
- **Observability.** Remote crash submission is gone; local breadcrumbs and `logs/` remain the diagnostic path.

## Testing strategy

- Single files locally: `QUIRKY_ALLOW_LOCAL_TESTS=1 pnpm exec vitest run --config config/vitest.config.ts <file>` (before the rename, `ORCA_ALLOW_LOCAL_TESTS=1`). The full suite runs on PR CI, which runs everything on non-draft PRs and selected tests on drafts (`ORCA_UNIT_SELECTION_MODE=selected`).
- Each trim cut: `pnpm typecheck`, `pnpm lint` (includes localization, ratchets, reliability gates), `pnpm audit:dead-code`, plus the tests the cut edits. Deleted tests go with their code; tests that only reference removed code get updated.
- Rename: unit tests for `rename.mjs` (case mapping, boundaries, allowlist, idempotence) and for `check-no-orca-strings.mjs` and `check-ipc-channel-parity.mjs` on fixtures; then the whole PR on CI. A packaged build launched beside Orca Dev must show SC-4's checks.
- Import: unit tests with a fixture source root built in a temp dir (never the real `~/Library/Application Support/orca`), covering each table row above, rerun semantics (SC-7), automations paused (SC-8), skipped-secret handling, and a source-tree hash that must be unchanged after import. The OSCrypt decrypt gets a known-vector test.
- Upstream review: a dry run against a fixed release list produces one proposal file.

## Non-goals

- The chat port and every later port; each gets its own spec.
- Removing every `process.platform` branch for Windows or Linux outside files the cuts edit.
- Rebranding stored data inside Orca Dev, or migrating Orca Dev in place.
- Mobile app store publishing; the mobile rename only changes identifiers in the tree.
- Importing fork stores (heimdall, loops, objective, pipelines, sitter ledger, project ledgers), mobile pairing, the cloud link, or terminal history.
