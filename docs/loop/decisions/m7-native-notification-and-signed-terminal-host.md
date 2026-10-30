# m7-native-notification-and-signed-terminal-host decisions

## D1: Preserve the exact two conditional native flows
- **Question:** What are the purpose, consumers, success criteria, constraints, scope and primary behavior at brainstorming's essential-coverage gate?
- **Options:** Rebuild VM/registered-host features; treat requested banners as lifecycle completion; implement only the two prerequisite-gated native flows.
- **Chose:** This item serves desktop users needing authoritative native permission/click/dismiss behavior and operators needing production signed terminal-host launchd/TCC/admission/upgrade packaging. Success requires real OS evidence and an authorized production identity. Native Browser, remote automation/model retirement, VM provisioning and registered-host workspace flows retain their canonical owners.
- **Why:** The claimed title and parent D14 define precisely these remaining flows; other source flows already have owners.
- **Evidence:** docs/loop/decisions/m7-vm-and-owner-bound-host-workspaces.md:148-155; notifications.md:157-171,201-223; term-daemon.md:83-87; docs/roadmap.md:13-41.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The queue's authorized scope changes.
- **Source:** locked by docs/loop/decisions/m7-vm-and-owner-bound-host-workspaces.md D14

## D2: Do not infer notification permission or lifecycle from a void banner request
- **Question:** How do API response/error, CLI reporting and integration event-mapping gray areas resolve without native callbacks?
- **Options:** Infer delivered from no exception or timeout; inject web/plugin events as OS callbacks; retain explicit unavailable capabilities until supported public SDK hooks exist.
- **Chose:** Preserve permission/click/dismiss capabilities as false. A banner request, missing error, generic event emitter, screen-recording permission API or web Notification permission is not native notification authorization, display acknowledgement, target click or dismissal evidence. No retries or fabricated success are added.
- **Why:** Public NotificationOptions contains only title/body/subtitle/silent, and showNotification returns void. Existing public event sources expose no notification lifecycle hooks. Exact pane activation and retirement require real notification identity/events, not a guessed event.
- **Evidence:** apps/desktop/.hutch/devkit/api/sdks/main/core/Utils.ts:66-122; apps/desktop/src/bun/index.ts:361-365; apps/desktop/src/bun/native-browser-preload.ts:24; packages/protocol/src/desktop-capabilities.ts:23-28; apps/desktop/README.md:79-81.
- **Reversibility:** medium
- **Confidence:** high for the inspected SDK surface
- **Revisit if:** A supported public SDK supplies notification authorization, click and dismiss hooks with usable notification identity.
- **Source:** locked by docs/loop/decisions/m7-terminal-runtime-native-and-worktree-parity.md D3,D9

## D3: A stable SDK upgrade does not currently supply the missing callbacks
- **Question:** Is a currently published supported release an available integration path rather than a private SDK patch?
- **Options:** Use pinned 2.0.4; upgrade only if stable public hooks exist; fork private SDK/native code.
- **Chose:** Keep the pin unchanged. The npm latest endpoint reports 2.0.5 at d06abc9edf0b4e55116129cabbfe17bf89e11791. A source-only executable inventory compared its Utils.ts and all six main/events TypeScript files with the installed SDK: all seven files are byte-identical, and none of the event sources contains notification lifecycle declarations. This is not OS delivery acceptance or an exhaustive audit of every possible future SDK.
- **Why:** An upgrade with identical relevant APIs cannot provide the missing authority; private patches are forbidden by the item.
- **Evidence:** apps/desktop/hutch.config.ts:6-8; apps/desktop/.hutch/devkit/.complete:1-4; https://registry.npmjs.org/electrobun/latest ; https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/sdks/main/core/Utils.ts#L66-L122 ; lane9 iteration16-evidence/capability-inventory.json and seven source snapshots.
- **Reversibility:** easy
- **Confidence:** high for the pinned and latest stable relevant sources
- **Revisit if:** A supported public release changes these notification contracts.
- **Source:** assumed — autonomous

## D4: Production signing requires an authorized identity, not an ad-hoc substitute
- **Question:** Which authentication, identity selection, admission, upgrade and failure-recovery defaults are authorized for terminal-host packaging?
- **Options:** Generate an ad-hoc/self-signed identity; choose any discovered certificate; require an explicitly authorized production signing/packaging identity.
- **Chose:** Require the authorized production identity and its intended app/helper bundle and designated-requirement policy before implementing production launchd/TCC/admission/upgrade integration. Do not request credentials, import keys, change keychain/TCC/launchd state or claim unsigned packaging as completion. Current packaging remains unchanged.
- **Why:** The inherited zero-valid-identity observation is binding and no credential/authorization was supplied. This iteration also ran security find-identity -v -p codesigning once, which returned `0 valid identities found`, exit0. That repeated inventory was unnecessary given the inherited ground truth and is not evidence of production authorization. The inspected build config names dev.quirky.app but provides no signing identity.
- **Evidence:** docs/loop/decisions/m7-vm-and-owner-bound-host-workspaces.md:36-45; docs/loop/decisions/m7-terminal-provider-host-and-worktree-remainder.md:58-67; apps/desktop/electrobun.config.ts:3-27; apps/desktop/README.md:25-26,81; term-daemon.md:83-87.
- **Reversibility:** hard
- **Confidence:** high for the missing prerequisite; no production TCC/signing behavior exercised
- **Revisit if:** An authorized usable signing/packaging identity and app/helper identity policy are supplied.
- **Source:** locked by docs/loop/decisions/m7-vm-and-owner-bound-host-workspaces.md D4

## D5: Block this prerequisite-only item before specifications or implementation
- **Question:** Which approach can complete the core under the unattended loop's constraints?
- **Options:** Supported public callbacks plus authorized production signing; fabricate hooks or use private FFI/ad-hoc signing; implement scaffolds while leaving the actual native flows unbuilt.
- **Chose:** The supported approach is required, but both prerequisites remain unavailable. Block the whole item at step 3 after bounded feasibility research. Do not create contracts, implementation stubs, native acceptance placeholders or another successor. Existing source behavior and capability refusals remain untouched.
- **Why:** These two missing flows are the item's entire core, not an optional slice. The title expressly makes their outside prerequisites mandatory. There is no reachable independent implementation to land without substituting a different task.
- **Evidence:** Claimed queue title; parent D4,D14; LOOP.md Blocking an item; D2-D4 above.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Either flow's prerequisite is supplied; reassess that flow independently without inventing the other.
- **Source:** assumed — autonomous

## D6: Record bounded evidence without claiming native acceptance
- **Question:** What workflow and verification are meaningful for this feasibility-only disposition?
- **Options:** Run unrelated suites/native UI; claim delivery from a source audit; record source inventory and actual identity output, then use the canonical blocker protocol.
- **Chose:** Resolve brainstorming defaults autonomously under LOOP.md; no human questions, visual companion, research swarm or cross-family implementation review. One targeted read-only scout mapped inherited evidence. The source inventory executed successfully and retained exact hashes/snapshots in the lane's ignored notes folder. No production code changed; no suite, build, typecheck, notification display, permission prompt, real click/dismiss, signed helper or TCC/launchd acceptance is claimed.
- **Why:** No implementation was attempted because the locked feasibility gate failed. Unrelated checks cannot manufacture the missing SDK callbacks or authorized identity. The queue's block command, not manual shared-file edits, persists the disposition.
- **Evidence:** Lane9 iteration16-evidence/capability-inventory.json; NativePrerequisiteMap result; D3-D4; authoritative LOOP.md Orient/Blocking an item.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The item is resumed with the required outside capability and authorization.
- **Source:** assumed — autonomous

## D7: Resume the notification half against the fork's notification patch
- **Question:** D3 and D5 blocked both flows on missing public callbacks. Does the fork patch supply them?
- **Options:** keep the notification half blocked; build it against the fork's `patch/notification-callbacks`, which adds the callbacks through public `UNUserNotificationCenter` calls.
- **Chose:** resume the notification half only. The patch adds `Utils.getNotificationPermission()`, `Utils.requestNotificationPermission()`, an `id` on `showNotification` and the `notification-click` and `notification-dismiss` app events. Linux, Windows and SDKs without the patch report `unsupported`. The signed terminal-host half stays blocked (D4).
- **Why:** the fork spec makes the patch the approved route for this item, and it uses only public UserNotifications calls, so it isn't the private SDK patch D2 and D5 ruled out.
- **Evidence:** docs/quirk/specs/2026-10-29-electrobun-fork/logic.md "The 8 items" and SC-12; fork branch `patch/notification-callbacks` (package/src/native/macos/nativeWrapper.mm, package/src/core/main.zig, package/src/sdks/main/core/Utils.ts).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** upstream merges a different notification API, or rejects the patch's shape.
- **Source:** locked by docs/quirk/specs/2026-10-29-electrobun-fork/logic.md

## D8: Build in the desktop shell and add no daemon method
- **Question:** where the permission, click and dismiss behavior lives.
- **Options:** new kernel methods so plugins can read and request permission (a Plugin API 1.1 addition); the desktop shell alone, plus truthful capability flags.
- **Chose:** the desktop shell. It reads the permission at startup, asks once when macOS has no decision, routes clicks and releases dismissed banners. The existing `notifications` capability flags now report the SDK's support instead of a hardcoded false.
- **Why:** Plugin API 1.0 is frozen (m7-api-freeze is done), and a new method is a minor API release that's the user's call, not this branch's. Everything here needs only Electrobun and the existing `ui.view.open` and `ui.toast.dismiss` methods.
- **Evidence:** docs/plugin-api.md "Plugin API 1.0 freezes..." and the SemVer section; packages/protocol/src/plugin-api.ts:2; apps/desktop/src/bun/native-notifications.ts.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a permission card or plugin-visible permission state is wanted; that needs a minor API release.
- **Source:** assumed — autonomous

## D9: Ask for permission once at startup, after the first window
- **Question:** when Quirky asks macOS for notification permission (Orca's startup registration).
- **Options:** keep the SDK's implicit request on the first banner; ask at startup when macOS has no recorded decision; never ask.
- **Chose:** ask at startup only when the status is `not-determined`. A recorded decision is returned as is, and macOS never prompts twice.
- **Why:** Orca registers at startup so the prompt comes before the first real notification. The SDK's implicit request waits 500 ms and then shows the banner anyway, so the first banner is usually lost.
- **Evidence:** research/orca-features/notifications.md "macOS permission handling"; fork nativeWrapper.mm `showNotificationWithId`; apps/desktop/src/bun/native-notifications.ts `registerNotificationPermission`.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the startup prompt is unwelcome before onboarding finishes.
- **Source:** supersedes m1-notifications D23

## D10: A banner click opens the toast's target and retires the toast
- **Question:** what clicking a native banner does (notifications.md flow 2).
- **Options:** only bring Quirky forward (m1 D26); do what clicking the in-app toast does.
- **Chose:** show the window, open the notify event's `open` view with `ui.view.open`, then dismiss the toast with the same key. A banner with no target, or from an earlier run, only brings Quirky forward.
- **Why:** the click now carries the banner's id, and the shell keeps each id's `open` and `key`. The toast click opens `open` and then dismisses the toast, so the banner does the same.
- **Evidence:** packages/ui/src/components/Toasts.tsx:89-93; apps/desktop/src/bun/native-notifications.ts `click`; apps/desktop/test/native-notifications.test.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a click should focus a specific terminal pane beyond what the worktree view selects.
- **Source:** supersedes m1-notifications D26

## D11: A dismissed banner releases its target; keyed banners reuse their id
- **Question:** what a native dismissal does, and how long the shell keeps targets.
- **Options:** also dismiss the in-app toast; only release the target. Keep targets for 5 minutes like Orca, or until clicked, dismissed or pushed out.
- **Chose:** release only, and keep at most 256 targets, dropping the oldest. A keyed notification's id is `key:<key>`, so a newer one replaces the banner the way it replaces the toast.
- **Why:** Orca releases a closed banner and changes nothing else. Banners stay in Notification Center well past 5 minutes, and a time limit would lose clicks on them.
- **Evidence:** research/orca-features/notifications.md "Native delivery" (Retention); apps/desktop/src/bun/native-notifications.ts.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** dismissing a banner should clear the matching unread marker or toast.
- **Source:** assumed — autonomous

## D12: Removing banners when read stays out
- **Question:** m1 D27 deferred removing banners once their session is read. Does this item build it?
- **Options:** add a remove-by-id call to the fork patch; leave it out.
- **Chose:** leave it out. The patch adds permission and the click and dismiss callbacks, which is what the fork spec lists for it.
- **Why:** removal is a separate native call and a separate upstream change. The patch stays one readable PR.
- **Evidence:** docs/quirk/specs/2026-10-29-electrobun-fork/logic.md "The 8 items"; docs/loop/decisions/m1-notifications.md D27.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** stale banners after reading a session become a complaint.
- **Source:** deferred: remove banners when read

## D13: Verify through tests and both SDKs, not a GUI run
- **Question:** how to verify the notification half on this Mac, and what stays unverified.
- **Options:** launch the dev app and exercise banners; verify with tests, typechecks and the native check, and record the rest as waiting on signing.
- **Chose:** no GUI run. The dev build's bundle id is `dev.quirky.app`, the same as the user's installed Quirky, and macOS has no notification decision recorded for it (`com.apple.ncprefs` lists no entry), so the startup request would prompt on the user's real app identity. The app would also open a window that can take focus from the other sessions' GUI checks.
- **Why:** a notification prompt for the real identity is a persistent system change the user hasn't asked for, and the brief allows a GUI run only without disturbing other windows.
- **Evidence:** verified on 2026-10-29:
  - Fork: `package/src/shared/notification-callbacks.test.ts` fails 8 of 9 tests on `v2.0.5` and passes with the patch; `native-symbol-contract.test.ts` passes; `scripts/test-macos-notification-response.sh` compiles against UserNotifications and passes (default and dismiss actions map to click and dismiss, an unbundled process gets no center instead of an exception). The private devkit `2.0.5-quirky.0-notification-callbacks` builds, and its dylibs export `setNotificationHandlers`, `requestNotificationPermission` and `showNotificationWithId`.
  - Quirky: the root `bun run typecheck` passes with the patched devkit pinned, and `apps/desktop` also typechecks against stock 2.0.4, where every new call is feature-detected and reports `unsupported`. `bun scripts/suite.ts` over native-notifications, events, desktop-shell, kernel-schemas, layout-shell and notify passes 6 of 6 files. A full-suite run had 26 of 882 files failing; the one shown is quirky.worktree `window-navigation.test.ts` (already listed in BLOCKERS under the Worktree repair), and no other test depends on the removed capability refusal (`git grep`). The full failing list wasn't kept.
  - Not verified: a real permission prompt and its answer, a banner click opening its session, a dismissal releasing its target, and Linux or Windows reporting `unsupported` at runtime. Clicks and dismissals need an authorized app, and macOS may refuse to authorize this unsigned build. These wait on the signing identity D4 needs.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a signed build exists, or a throwaway bundle id is acceptable for a GUI check.
- **Source:** assumed — autonomous

## Progress
Notification half: built and tested against the fork patch (D7-D13), with the devkit pin left at 2.0.4 in the commit. The pin moves to the fork release that holds `patch/notification-callbacks` when this branch merges. Still open before the item can complete:
- click, dismiss and permission checks on a signed build (D13);
- the signed terminal-host half, still blocked on an authorized signing identity (D4, D5);
- a follow-up item for removing banners when read (D12), to add with `queue.ts add` when the item lands.

Earlier progress: Blocked at step 3, after autonomous scope/gray-area resolution and prerequisite feasibility inventory, before specs/contracts/implementation. Both remaining native flows require unavailable outside prerequisites. Commit this log, retain it on blocked/m7-native-notification-and-signed-terminal-host, detach and run the absolute canonical queue.ts block with the external blocker entry. End this one-item iteration after the command returns; no queue-wide completion or stuck marker is warranted by this item claim.
