# Browser and mobile parity sweep

## Status & amendments
Approved autonomously 2026-10-28 under LOOP.md; no person is watching. End phase is active: canonical queue shows m7-test-triage claimed by lane 8. Logic and technical sibling specify the sweep; no behavior pass is inferred from compilation.

**Amendments:** 2026-10-28: actual production bridge/daemon/encrypted-phone/Chrome reproduction confirmed page teardown retains Watch and terminal input leases while the native RPC stays connected. S6 makes page resource reclamation explicit; no product boundary or public RPC is widened.

**Amendments:** 2026-10-28: caught-up production UI proved link routing and retained shell state, but exposed a session-record count mislabeled as tabs and flex-growing feedback wrappers. S7 adds a narrow layout-owned count snapshot; S8 preserves intrinsic feedback height. No raw layout payload, new control grant, Editor/Browser activation or Native substitution is authorized.

## Purpose and conceptual model
A paired phone and the desktop use the existing public plugin APIs. A terminal link belongs to its current workspace; its destination is an explicit phone preference. Choosing desktop means a newly created managed Chrome Watch page, not a replacement Native page. The daemon remains authoritative for tabs, consent, session ownership and filesystem revisions. This sweep inventories every feature-doc category, completes reachable gaps, repairs observed regressions, and preserves real external prerequisites rather than manufacturing parity.

## Scope and non-goals
Build terminal-link routing to explicit Watch and repair failures found by browser/mobile acceptance. Exercise implemented flows through daemon/CLI and production web UI. Preserve direct LAN/tailnet E2EE, exact page/method grants, no page credentials, connection-scoped terminal and Watch leases, inert Markdown and file CAS. No upstream relay/push endpoints, incompatible Orca install links, interactive native chat/voice, private Native FFI, unapproved active HTML preview, remote-host authority invention, or other lanes' shell redesign. Native-only scenarios remain in their existing handoff files. GitLab/Bitbucket/Gitea/Azure, Objective and PR sitter are explicitly excluded by the queue title.

## Feature flow disposition
| Feature flow | Current implementation and sweep acceptance | Retained outside prerequisite |
|---|---|---|
| Browser open/navigation, history/suggestions/find/zoom/viewport, downloads/prompts/popups/local HTML | Existing Browser plugin pane and automation; run exact-page API and Watch paths and repair confirmed failures | Native hard reload and authoritative failure events: sa-browser-pane-native-host-controls; Native prompt/download/popup events: sa-browser-pane-native-events; active grant preview and conversion Back: sa-browser-pane-workspace-preview |
| Browser profiles/cookie imports/settings/link routing | Existing profile, import UI and public CLI; verify isolated profiles, exact cookie replacement/rollback, on-demand detection and settings behavior | Native acknowledged storage clear/removal: sa-browser-native-profile-clear-completion; Native identity: sa-browser-native-identity; effective localhost labels: sa-browser-localhost-label-routing |
| Browser design grab/annotation/draw | Existing Watch selection, bounded/redacted payload, agent note delivery, markup and clipboard; verify repeated coordinate selection/annotation | Real Native image capture and residual native clipboard ownership remain with existing pane/design owners; never host-screen capture |
| Browser agent commands | Existing on-demand managed Chrome/CDP plus extras; verify scoped mutation, actual input, history, screenshot/PDF/network/profile behavior | Native is not a CDP substitute; exact original page/worktree authority cannot relax |
| Mobile desktop install/pairing page/settings | Existing pair/state/device/listener controls | Signed compatible Quirky artifacts/URLs: sb-mobile-install-links; independently owned settings visibility/revoke routing must not be duplicated |
| Mobile phone pairing/E2EE/onboarding/home/host actions | Existing native runtime plus secure storage, protocol gates, diagnostics and bundle bridge; exercise encrypted public client and available web surfaces | Real camera/SecureStore/iOS/Android background/custom-WebView behavior in existing native handoffs; upstream relay excluded by architecture |
| Mobile workspace/session | Existing options/provenance/Sleep parking, explicit stop-history-resume, terminal/dock/ask, real Markdown tabs and explicit Watch | Interactive native chat/voice and real Native mirroring: sb-mobile-chat-voice-native-ruling; no relabeling ask or Watch as those products |
| Mobile source control/review/files/tasks/accounts/history/artifacts | Existing public producer consumers and per-route grants; repair observed contract regressions and verify bounded drafts/consent/source identity | Provider-owned Linear/Jira APIs and native APNs/FCM need existing provider/push prerequisite owners; no fake rows/delivery |
| Mobile settings/notifications/revoke | Existing foreground notification replay/settings, device revoke, local preferences and diagnostics; add selectable desktop Watch terminal-link target | No OS push claim; signed app distribution and Native host constraints remain |

## Decisions locked and alternatives
Recommended approach: extend the existing SessionPage owner and explicit Watch creation. Rejected exposing generic browser/CDP authority to pages; rejected implicitly converting a Native pane; rejected retaining a permanently disabled choice now that its producer exists. Keep the current phone-browser default so an upgrade cannot silently start Chrome; the user explicitly selects desktop Watch. New work does not change existing Native identity or its unavailable explanation.

Gray areas resolved: interaction uses the existing settings choice and selected tab; loading/error shows actual creation failure and never silently falls back to phone; authentication/grants reuse exact session-route method admission; data lifetime persists one existing enum only; concurrent activations cannot create duplicate in-flight pages; stale/unmounted/disconnected completions cannot steal selection; invalid/executable URL schemes are rejected; phone-only mode remains external http(s) navigation; no hidden page retry or browser launch at render time.

## Acceptance scenarios
### S1 Phone-browser links stay external
- Given a connected terminal in workspace W, preference Phone, and a visible http(s) link U, activating U opens the phone browser through the native external-link verb and creates no Watch page.
- Data before: **Workspace** W contains terminal T; **Preference** Phone.
- Walkthrough: the user activates U in terminal output.
- Data after: **Workspace** W retains its original tab identities; **Phone browser** opens U. Invalid schemes never execute.

### S2 Explicit desktop choice opens exact Watch
- Given terminal T in W and preference Desktop (Chrome Watch), activating U creates one actual browser tab in W using browserWatchCreate with U and selects the returned tab identity. Native tabs are unchanged. Failure remains visible, retains the terminal and does not fall back externally. Floating workspaces without Browser support refuse honestly.
- Data before: **Workspace** W has terminal T and Native tab N; **Preference** Desktop (Chrome Watch).
- Walkthrough: the user activates U once; the daemon returns tab B and its owned Watch lease; the page selects B.
- Data after: **Workspace** W contains T, unchanged N and Watch B at U; no arbitrary page/lease can be selected or controlled.

### S3 Preference and lifecycle
- Settings offers both choices and saves the existing terminalLinkMode. A failed save retains prior selection. Repeated activation while creation is pending does not create multiple tabs. Navigation, disconnect or unmount prevents a late result from selecting another route; release any acquired lease safely without replaying a mutation.
- Data before: **Preference** Phone; **Pending operation** none.
- Walkthrough: choose Desktop, activate U, then leave before completion.
- Data after: **Preference** Desktop; **Current screen** remains the new destination; no orphaned active phone Watch lease.

### S4 Existing browser behavior and source defects
Run scoped browser automation, profile/import replacement and rollback, pane/design lifecycle and UI regressions. Coordinate-only Grab and a second selection/annotation must work without a prior hover; clicks must not leak through to the page. Sanitized extraction excludes secrets/executable markup and annotations are removed only after confirmed delivery. Tests must assert behavior, not incidental copy or constant literals. Missing Chrome on the remote test host is runner placement evidence, not product success or justification to skip real Chrome coverage.

### S5 Existing mobile behavior and source defects
Run encrypted pairing/revoke/allowlist/bundle/session/Markdown/Watch and panels acceptance. Migrate real producer contract changes without removing consent or provenance. Actual setup and issue-command pins are independently displayed and passed; stale consent cannot execute changed scripts. Verified bundle generations support their declared routes, reject unknown capabilities/grants, preserve prior valid generation on failed update, and do not weaken admission for a fixture. Phone Tasks create/cancel and filters remain bounded at narrow and short keyboard-like viewports without persistent layout shift. Dirty drafts remain after conflicts/cancel and disconnected pages cannot mutate. Test actual daemon/UI outcomes rather than mock echo/wiring.

### S6 Closing a page releases its resources, not the shared phone connection
- Given a phone page with terminal stream T and Watch lease B, closing or replacing that page immediately stops page delivery and releases exactly T/B. The shared authenticated phone connection remains usable. If create/attach finishes after close or connection replacement, its result is reclaimed through the original owning connection rather than lost with the pending reply.
- A later page adopting the same actual Watch lease must retain it when an older page closes or receives a late result. Cleanup cannot stop another page's new stream/lease, guess IDs, retry a mutation or close the shared RPC.
- Data before: **Phone connection** P is live; **Old page** owns T/B; **New page** may independently own T2 or adopt B.
- Walkthrough: the old page closes while one acquisition is pending; the original producer finishes.
- Data after: **Old page** has no input/streaming authority; its unshared resources are released; **Phone connection** P and **New page** resources remain live.

### S7 Workspace cards count actual layout-owned tabs
- Given a workspace containing terminal, Native Browser and Markdown tabs, its primary Open action reports all actual tabs rather than session records. A split adds a pane, not another tab; background sessions and closed-tab history are not counted. Group/window focus does not alter the total.
- The Terminal layout owner supplies one read-only batch snapshot with only workspace IDs, nonnegative counts and IDs whose stored layouts are unreadable. It reads its already-owned cold/hot models through the existing serial queue, without creating layouts, terminals or per-workspace Editor/Browser state. No raw titles, URLs, view arguments, paths or session launch data reach the phone.
- A complete successful snapshot means an absent workspace with no unreadable marker has zero stored tabs. Unreadable or unavailable/malformed snapshots must not be replaced by session-count guesses: keep the workspace openable, omit an unsupported number and show existing stale/error affordances. The optional session property remains explicitly a session count.
- Data before: **Workspace** W has one terminal tab with two split panes, one Native tab and one Markdown tab; **Background session** B has no tab.
- Walkthrough: the user returns to Workspaces; the page reads one batch count snapshot. Closing the Markdown tab changes the next count from three to two. Restarting the daemon preserves the same stored total.
- Data after: **Open workspace** shows three, then two actual tabs; no additional Chrome, Editor or PTY process starts just to count. Existing terminal grant and exact route admission remain; CLI exposes the same snapshot.

### S8 Feedback cannot become a second scrolling body
- Successful creation, save notices and errors occupy only their intrinsic content height above the tab strip. They retain the existing responsive/safe-area gutters but do not flex-grow or consume the main pane's available height.
- Data before: **Session** has an opened Watch page at a390×720 viewport; **Feedback** confirms explicit Chrome Watch.
- Walkthrough: the user follows a terminal link or creates/saves a note and observes the tab strip, controls and content.
- Data after: **Feedback** remains visible without the large empty band observed in screenshot9; the main content keeps its available height and scroll behavior. Error/notice semantics and route/lease logic are unchanged.

## Verification and retained limits
Use fresh disposable HOME/QUIRKY_HOME for every process and clean it; no real credentials, external posting or home configuration. Run bun run build, bun run typecheck, bun scripts/suite.ts scripts and affected suite.ts groups, then actual web dogfood via --surface web --owner yours --unattended. Every test, including one file, goes through suite.ts; only list-marked macOS cases execute locally. Native-only OS behavior is not established by web screenshots. Existing blocked owner items are retained, not duplicated as a new testing follow-up. Any genuinely new unbuilt flow may be captured in at most one implementation-only successor before land.

## Industry insights
No external research swarm: controlling LOOP uses feature docs, roadmap and earlier decisions. Source docs browser.md and mobile.md plus the BrowserMobileMap repository ledger establish the distinctions above. Baseline suite receipt: artifact53; 63 remote files (48 passed,15 failed),3 local macOS files passed. Many browser failures are absent Chrome on the remote host; no pass claimed for those.

## Deferred ideas
No new product expansion. Existing prerequisite owners above remain authoritative; pending verification alone is not missing implementation.

## Glossary
Native: human system webview. Watch: explicit owned view/control of an agent Chrome page. Link target: phone preference, not page authority. Consent pin: producer-issued content identity, independently authorized for each script class.
