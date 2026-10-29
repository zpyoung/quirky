# Electrobun fork

Quirky carries its own Electrobun fork so the 8 items blocked on missing native APIs can ship, while
the fork stays one rebase away from upstream's latest stable release. This spec is for whoever
maintains the fork or picks up one of the 8 items: it says how patches are made, combined, released
and consumed, and how the fork follows upstream.

## Why a fork

Electrobun 2.0.5 doesn't expose WebKit features that macOS has had for years: a custom user agent,
cache-bypassing reload, navigation failure callbacks, dropped file paths, storage-clear completion,
page dialogs, auth and certificate challenges, download control, per-view proxies, URL scheme
handlers and notification callbacks. Upstream's next line (2.0.6) is a GPU UI engine and touches
none of them. Open upstream issues #384, #408 and #440 cover parts of the gap with no fix yet.

Each patch is meant to be temporary. It goes upstream as its own PR and leaves the fork once
upstream merges it.

## Conceptual model

- **The fork** is the public GitHub repo `zpyoung/electrobun`, registered in Orca as a repo.
- **The base** is an upstream stable release tag, starting with `v2.0.5`. The fork never follows
  upstream `main` or beta tags.
- **A patch** is one branch, `patch/<name>`, cut from the base tag and independent of every other
  patch, so it can become one upstream PR as is.
- **The `quirky` branch** is the fork's default branch. It holds only fork tooling: `FORK.md`, the
  ordered patch list `patches.txt`, the rebuild script and the macOS arm64 release workflow.
  Upstream's own workflows are disabled in the fork.
- **The unified build** is the branch `quirky/v2.0.5`: the base tag, then each listed patch merged
  in list order, then one commit that sets the fork version and adds the release workflow. The
  rebuild script regenerates it from scratch, so it's force-pushed and never edited by hand.
- **A release** is an immutable tag `v2.0.5-quirky.N` on the unified build, with the macOS arm64
  devkit attached as a GitHub release asset.
- **Quirky** pins exactly one release in `apps/desktop/hutch.config.ts`. Hutch loads it through
  `HUTCH_ELECTROBUN_DEVKIT_ROOT`.

## How a patch reaches Quirky

A session develops its patch on `patch/<name>` and builds a private test version locally: the base
tag plus that one patch. It points its paired Quirky worktree at that build to prove the blocked
feature works. When the patch is done, the session adds the branch to `patches.txt` and rebuilds
the unified branch. Any conflict with patches already listed is the newer patch's to resolve. The
patch branch itself stays based on the tag.

Tagging the unified build as the next `v2.0.5-quirky.N` runs the fork's release workflow on a
GitHub-hosted macOS arm64 runner. The workflow builds the devkit once, runs every listed patch's
test, and attaches the devkit to the release. Quirky picks it up by bumping its pin. A Quirky
script downloads the pinned release's devkit into a local cache and sets the devkit variable, and
`build.yml` does the same in CI.

Releases are incremental: each finished patch produces the next `quirky.N`. Since every release
holds every patch listed before it, moving the pin forward never drops a patch.

## Key decisions and rationale

- **One branch per patch plus a generated unified branch.** Each Orca worktree owns one branch and
  each branch is one upstream PR. Meta's WebRTC fork uses the same shape. The unified branch is
  script-built because no off-the-shelf tool assembles topic branches.
- **Stable tags only.** The fork moves when upstream cuts a stable release, so Quirky never pins
  moving code.
- **Prerelease version numbers.** `2.0.5-quirky.N` can't collide with an upstream version.
  Hutch 0.28.1 accepted a prerelease pin from a local devkit in a probe on 2026-10-29.
- **A mismatched pin fails loudly.** The same probe showed Hutch refuses to prepare when the pin
  and the devkit version differ, and fails when no devkit is set and the version isn't an upstream
  release. Quirky can't fall back to stock Electrobun by accident.
- **A test per patch.** Patches can break after an upstream change with no conflict and no compile
  error, so every patch carries a check and the release workflow runs them all.
- **macOS only.** Each patch implements macOS and reports the feature unsupported on Linux and
  Windows. Upstream may ask for the other platforms before merging, and that request is handled
  per PR.
- **The user reviews before anything goes public.** Sessions write the upstream PR text but don't
  open the PR, and they leave Quirky changes on a branch for review.

## The 8 items

| Quirky item (preserved `blocked/<item>` branch) | Patch branch | What the patch adds |
| --- | --- | --- |
| `sa-browser-native-identity` | `patch/webview-user-agent` | Set a view's user agent at creation and later |
| `sa-browser-pane-native-host-controls` | `patch/hard-reload-load-failed` | Cache-bypassing reload and a navigation-failed event |
| `m4-editor-drop-open-in-place` | `patch/drop-source-paths` | Source file paths on a native drop |
| `sa-browser-native-profile-clear-completion` | `patch/storage-clear-completion` | A completion result for storage clears and a per-profile storage root |
| `sa-browser-pane-native-events` | `patch/webview-native-events` | Page dialogs, auth and certificate challenges, download control, popups that keep their opener |
| `sa-browser-localhost-label-routing` | `patch/per-view-proxy` | A proxy per view or profile, so named hosts reach a local port |
| `sa-browser-pane-workspace-preview` | `patch/isolated-preview-view` | A throwaway view served through a custom scheme, with outbound traffic, permissions and downloads blocked |
| `m7-native-notification-and-signed-terminal-host` | `patch/notification-callbacks` | Notification permission, click and dismiss callbacks |

The storage root, the per-view proxy and the custom scheme rely on WebKit APIs that need macOS 14
or later. Those features report unsupported on older macOS.

## Scenarios

1. **SC-1: A session builds a private test version**
   - **Given** a session working on `patch/webview-user-agent` in its fork worktree
   - **When** it builds Electrobun for its paired Quirky worktree
   - **Then** the build is the base tag plus that one patch, versioned as a private test version
     that names the patch, and the Quirky worktree's pin matches it
   - **Data before:** **Fork worktree**: `patch/webview-user-agent` on `v2.0.5`; **Quirky worktree**:
     `blocked/sa-browser-native-identity`, pin `2.0.4`
   - **Walkthrough:**
     1. The session builds the devkit from `v2.0.5` plus its patch, as version
        `2.0.5-quirky.0-webview-user-agent`
     2. The session sets the Quirky worktree's pin to that version and points the devkit variable
        at the build
   - **Data after:** **Quirky worktree**: ✓ runs against the patched devkit; **Fork releases**:
     unchanged

2. **SC-2: A private test version can't be released**
   - **Given** a tag on the fork that has the private test version shape
   - **When** the release workflow runs on it
   - **Then** the workflow refuses to publish, and no release is created
   - **Data before:** **Tag** `v2.0.5-quirky.0-webview-user-agent`
   - **Walkthrough:**
     1. The release workflow reads the version from the tag
   - **Data after:** ✗ release refused: the version names a patch; **Fork releases**: unchanged

3. **SC-3: A finished patch joins the unified build**
   - **Given** `patches.txt` already lists `patch/webview-user-agent`, and
     `patch/hard-reload-load-failed` is finished
   - **When** the session adds its patch to the list and rebuilds the unified branch
   - **Then** `quirky/v2.0.5` is regenerated as the tag plus both patches in list order, and the
     session resolves any conflict between them on the unified branch, leaving its patch branch
     based on the tag
   - **Data before:** **patches.txt**: `patch/webview-user-agent`; **quirky/v2.0.5**: tag + user
     agent patch
   - **Walkthrough:**
     1. The session appends `patch/hard-reload-load-failed` to `patches.txt`
     2. The rebuild script starts from `v2.0.5` and merges each listed patch in order
     3. Both patches add to the webview event list, so the merge conflicts; the session resolves it
   - **Data after:** **quirky/v2.0.5**: ✓ tag + user agent patch + reload patch + version commit;
     **patch/hard-reload-load-failed**: still based on `v2.0.5`

4. **SC-4: The unified build is released**
   - **Given** the regenerated unified branch with two patches, and the last release is
     `v2.0.5-quirky.1`
   - **When** the unified build is tagged
   - **Then** the tag is `v2.0.5-quirky.2`, the workflow runs both patches' tests, and the release
     carries the macOS arm64 devkit only if every test passes
   - **Data before:** **Fork releases**: `v2.0.5-quirky.1` (user agent)
   - **Walkthrough:**
     1. The maintainer tags the unified build `v2.0.5-quirky.2`
     2. The release workflow builds the devkit and runs both patch tests
   - **Data after:** **Fork releases**: `v2.0.5-quirky.1`; ✓ `v2.0.5-quirky.2` (user agent,
     reload) with its devkit attached

5. **SC-5: Quirky uses a release**
   - **Given** Quirky pinned to `2.0.5-quirky.2`
   - **When** a developer runs the desktop app, or `build.yml` runs in CI
   - **Then** the pinned release's devkit is downloaded once into a local cache, the devkit
     variable points at it, and Hutch prepares the app against it
   - **Data before:** **hutch.config.ts** pin `2.0.5-quirky.2`; **Devkit cache**: empty
   - **Walkthrough:**
     1. The Quirky script downloads the devkit attached to `v2.0.5-quirky.2`
     2. Hutch prepares the app with the devkit variable set
   - **Data after:** **Devkit cache**: ✓ `2.0.5-quirky.2`; **App**: ✓ built against the fork

6. **SC-6: A mismatched or missing devkit stops the build**
   - **Given** Quirky pinned to `2.0.5-quirky.2`
   - **When** the devkit variable points at a different version, or isn't set
   - **Then** Hutch refuses to prepare and the build stops, and Quirky never runs on stock
     Electrobun
   - **Walkthrough:**
     1. (a) The devkit variable points at `2.0.5-quirky.1`; Hutch compares versions
     2. (b) The devkit variable isn't set; Hutch looks for an upstream release
        `2.0.5-quirky.2`
   - **Data after:** (a) ✗ version mismatch; (b) ✗ release not found

7. **SC-7: Upstream cuts a new stable release**
   - **Given** the fork on `v2.0.5` with patches listed, and upstream publishes stable `v2.0.6`
   - **When** the maintainer moves the fork to the new base
   - **Then** each listed patch is rebased onto `v2.0.6` and compared with its old version, the
     unified branch `quirky/v2.0.6` is built, and its first release is `v2.0.6-quirky.1`; the
     `quirky/v2.0.5` releases stay as they are
   - **Data before:** **patches.txt**: 3 patches*; **Fork releases**: up to `v2.0.5-quirky.3`*
   - **Walkthrough:**
     1. The maintainer rebases each patch branch onto `v2.0.6` and compares each old and new patch
     2. The rebuild script builds `quirky/v2.0.6`
     3. The maintainer tags it `v2.0.6-quirky.1`
   - **Data after:** **Fork releases**: `v2.0.5-quirky.1` to `.3` unchanged; ✓ `v2.0.6-quirky.1`

8. **SC-8: Upstream merges one of our patches**
   - **Given** upstream's new stable release includes `patch/webview-user-agent`'s PR
   - **When** the fork moves to that release
   - **Then** the patch leaves `patches.txt`, its branch is kept for history, and Quirky's code
     keeps working through upstream's version of the API
   - **Data before:** **patches.txt**: user agent, reload, drop paths
   - **Walkthrough:**
     1. The maintainer removes the user agent patch from `patches.txt` before rebuilding
   - **Data after:** **patches.txt**: ✓ reload, drop paths; **patch/webview-user-agent**: kept, not
     built

9. **SC-9: An upstream change silently breaks a patch**
   - **Given** a patch that still merges and compiles on a new upstream base, but no longer works
   - **When** the release workflow runs the patch tests
   - **Then** that patch's test fails and no release is published
   - **Data after:** ✗ release blocked by the failing patch test; **Fork releases**: unchanged

10. **SC-10: An item's session finishes**
    - **Given** a session that owns `patch/drop-source-paths` and the Quirky worktree on
      `blocked/m4-editor-drop-open-in-place`
    - **When** the patch works in Quirky
    - **Then** the session leaves the patch on its branch with its test, the unified build updated,
      the Quirky feature verified on its branch, and upstream PR text written but not opened; after
      the user reviews, the upstream PR opens and the Quirky branch merges in order with its pin
      moved to the release that holds its patch
    - **Data before:** **Fork**: patch branch in progress; **Quirky**: blocked branch
    - **Walkthrough:**
      1. The session finishes and tests the patch, joins it to the unified build (SC-3), and
         verifies the Quirky feature against its private test version
      2. The session writes the upstream PR text and stops
      3. The user reviews; the release is tagged (SC-4); the Quirky branch's pin is moved to it and
         the branch merges
    - **Data after:** **Fork**: ✓ patch listed and released; **Upstream PR**: ✓ open after review;
      **Quirky main**: ✓ feature merged, pin on that release

11. **SC-11: A patch on a platform it doesn't support**
    - **Given** a Quirky build on Linux or Windows, or on macOS older than 14 for the macOS 14
      features
    - **When** Quirky asks for a patched feature
    - **Then** the fork reports it unsupported, and Quirky shows its existing unavailable state
      rather than a no-op

12. **SC-12: Notifications stop at signing**
    - **Given** no code-signing identity on this Mac
    - **When** the notifications session finishes the patch
    - **Then** the callbacks are built and their API is tested, the click and dismiss checks that
      need a signed app are recorded as waiting on signing, and the item isn't called complete

## Scope and non-goals

In scope:
- Creating the fork, its `quirky` branch tooling, the rebuild script and the release workflow.
- The 8 patches and the Quirky feature each one unblocks.
- Quirky's devkit download script, its pin and its `build.yml` change.

Not in scope:
- Linux and Windows implementations of the patches.
- Upstream's `main` and beta lines.
- Opening upstream PRs without the user's review.
- A code-signing identity, which only the user can supply.

## Decisions Locked

**Branches**
- One `patch/<name>` branch per item, cut from the base tag, plus a generated `quirky/v2.0.5`
  rebuilt from the ordered `patches.txt`.
- The fork's default branch `quirky` holds only fork tooling; upstream's workflows are disabled.

**Upstream line**
- Stable release tags only, starting at `v2.0.5`; Quirky moves from 2.0.4 to the fork's 2.0.5.

**Consumption**
- A local build for development and the fork's GitHub release asset for CI, through
  `HUTCH_ELECTROBUN_DEVKIT_ROOT`.
- Releases are incremental: one `quirky.N` per finished patch.

**Upstreaming**
- Each patch goes upstream once it works in Quirky, macOS only, with Linux and Windows reporting
  unsupported.
- Sessions write the PR text; the PR opens after the user reviews the patch.

**Sessions**
- All 8 items in the first batch.
- Claude Code in each worktree, owning both a fork worktree and a paired Quirky worktree on the
  item's `blocked/<item>` branch.
- Quirky changes land as verified branches; they merge in order after the user looks.

## Industry Insights

- Electron keeps patches as files with an order file, and requires each patch's commit message to
  say why it exists and whether it's headed upstream. It warns that patches can break "without even
  a patch conflict or a compilation error." ([Electron: Patches](https://www.electronjs.org/docs/latest/development/patches))
- Brave re-applies its patches after each Chromium bump and regenerates or drops the ones that
  fail. ([Brave: Chromium rebases](https://github.com/brave/brave-browser/wiki/Chromium-rebases))
- Meta's WebRTC fork fell years behind as a monorepo copy. Its fix gave each patch a named branch,
  an owner, and a fresh base per upstream release.
  ([Meta Engineering, Apr 2026](https://engineering.fb.com/2026/04/09/developer-tools/escaping-the-fork-how-meta-modernized-webrtc-across-50-use-cases/))
- Vivaldi dropped merging upstream after two years in favour of rebasing.
  ([Vivaldi](https://yngve.vivaldi.net/sooo-you-say-you-want-to-maintain-a-chromium-fork/))
- `git range-diff` compares a patch stack before and after a rebase, and `git rerere` reuses
  conflict resolutions across rebuilds. ([range-diff](https://git-scm.com/docs/git-range-diff),
  [rerere](https://git-scm.com/docs/git-rerere))
- A Chromium fork's version counter collided with upstream tags.
  ([pubky-chromium #54](https://github.com/pubky/pubky-chromium/issues/54))
- Fork maintainers regret not upstreaming early.
  ([Lobsters thread](https://lobste.rs/s/yav1ky/those_who_have_maintained_forks_oss_at))

## Deferred Ideas

None. Discussion stayed within scope.

## Glossary

- **Base tag:** the upstream stable release the fork builds on, `v2.0.5` now.
- **Patch branch:** `patch/<name>`, one item's change, cut from the base tag.
- **`patches.txt`:** the ordered list of patch branches in the unified build.
- **Unified build:** the `quirky/v2.<x>.<y>` branch, regenerated from the base tag and the listed
  patches.
- **Release:** an immutable `v<base>-quirky.N` tag with the macOS arm64 devkit attached.
- **Private test version:** a session's local build of the base tag plus one patch, versioned
  `<base>-quirky.0-<patch>`, which can't be released.
- **Devkit:** the built Electrobun package Hutch loads: native libraries, runtime and TypeScript
  API.
- **Paired Quirky worktree:** the Quirky worktree on an item's `blocked/<item>` branch, owned by
  the same session as the patch.

## Status & amendments

**Status:** Approved 2026-10-29.

**Amendments:** none.
