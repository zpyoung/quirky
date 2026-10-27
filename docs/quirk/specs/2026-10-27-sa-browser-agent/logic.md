# Browser agent automation and cookie import

## Status & amendments
Status: **Ready for implementation after bounded spec-review adjudication and exercised helper/dialog feasibility**. No implementation or permanent acceptance pass claimed. Tech spec required (subsystem boundary and more than three files). Actual Codex gate remains NEEDS_FIXES; material F1 is remedied by the dialog-control amendment/proof, and resolver/heading heuristics are adjudicated in D27 rather than rewritten to a passing gate.

Amendments: 2026-10-27 — Initial unattended specification halted on per-page-helper feasibility (D14–D17). On 2026-10-27 the user authorized one helper per profile (D19), replacing only helper/queue topology. The revised public failure/import contracts are explicit in tech.md; the required Codex promote/fresh-refute review completed and its confirmed F1 is addressed below. Restart/target identity remains positive and fail-closed, never order or page URL/title inference. All autonomous decisions and actual evidence are recorded in the item log.

Recovery amendment, 2026-10-27 (D19): helper identity is scoped to one live helper epoch. If that epoch is lost, the triggering operation fails with `browser_tab_changed` and is never retried. Quirky tears down only its provably owned Chrome/helper process group, restarts the same durable profile on the next explicit browser operation, and recreates retained managed-page metadata through helper `tab new` using saved URLs and new helper-returned IDs. Public page IDs may remain stable, but prior DOM/history/transient input and refs do not survive reconstruction; credentials in the durable profile do. Reconstructed pages are never inferred from old target order, URL/title matches, or recycled tN values.

Dialog-control amendment, 2026-10-27 (Codex F1): a pending dialog must be answerable while its triggering operation awaits completion. Normal helper selection and execution remain serialized; dialog accept/dismiss is an out-of-band control action on the exact already-bound page and its current pending dialog, never another helper tab selection. New pages are created blank and positively bound through trusted CDP debugger metadata before navigating caller content; no page URL/title/global marker or old helper ID is used as identity evidence. Unbound, stale, missing or closed dialogs fail rather than responding on whichever page is active.

## Conceptual model
Agents drive Quirky-owned headless Chrome pages without opening or focusing a desktop browser. Pages belong to worktrees and persistent browser profiles. A snapshot describes the page accessibility tree and yields short-lived element references for subsequent interactions. A profile holds Chrome-managed authentication state; explicit cookie import can reuse supported source-browser logins without opening the source browser or modifying its files.

The daemon exposes these behaviors as the built-in browser plugin's schema-declared API and CLI command group. The same public plugin API is available to third parties. No browser process starts just because the plugin is discovered, enabled, listed, or queried for profiles.

## Scope & non-goals
In scope: local on-demand Chrome/Chromium discovery and ownership; all local automation command families in external browser.md's command-surface table; page/worktree targeting and queueing; profile create/list/delete/switch/show/default/clone; cookie get/set/delete and explicit browser/file imports; import discovery and result reporting; lifecycle, errors and source defects listed below.

Not in this slice: visible system-webview pane, browser toolbar/settings UI, address-bar suggestions/search UI, native menus, screencast presentation and design mode (sa-browser-ui); SSH/WSL/client-hosted remote routing, artifacts, native chat (BRIEF drops); browser-data import beyond cookies. Electron-specific identity cleanup has no effect on native Chrome: identity get/set reports clean/native intent but never claims an Electron engine exists. Local open-url creates a managed page; no paired-client routing is introduced. UI-only find/zoom, page chrome prompts, download shelf and native dialogs belong to sa-browser-ui; automation download, emulation and dialog commands remain here.

## Key decisions & rationale
Choose owned Chrome plus pinned agent-browser for the existing snapshot/ref and command vocabulary, with direct CDP for profile-cookie identities and missing native operations. This reuses the upstream headless backend's proven boundary without its Electron proxy. A direct-CDP-only driver avoids a helper but requires reimplementing the full high-level command surface. A Playwright-only CDP driver supplies richer library operations but still needs the snapshot/ref/exec compatibility layer and has documented reduced fidelity over CDP. Neither alternative removes process ownership or cookie policy.

Use one lazily started browser and one helper session per profile. The helper creates every managed page; Quirky retains the helper-returned tN mapped to its public page ID. One profile-wide FIFO lock atomically selects the retained tab and executes the complete operation, including multi-command actions and profile mutations. No system profile is an automation destination. Closing/deleting cancels relevant queued/in-flight work without retargeting another page. After helper restart, recover only from proven identity; never infer from enumeration order, URL or title, and fail closed if identity cannot be established.

## Decisions locked
- API: existing daemon authentication, namespaced `quirky.browser` methods, structured result/error envelopes and existing CLI exit conventions; no new transport. Plugin API remains unstable until M7.
- CLI: `quirky browser ...`; explicit page wins over worktree selectors, cwd resolves the current managed worktree, `all` removes a read filter. Text mutations require an explicit page or resolved worktree, never global fallback. Assume recommended structured output defaults.
- Input: snapshot refs are page-bound and invalid after navigation, profile switch or tab switch. Commands never steal host focus. Large inputs retain their exact Unicode content.
- Data: Default always exists; isolated profiles keep credentials separate. Destructive profile deletion, clearing and imported-domain replacement use existing confirmation/`--yes` behavior. Source browser files are read-only.
- Import: explicit detection only; JSON, Chromium-family, Firefox and Safari inputs; Google exclusions are disclosed; unreadable partitions suppress their whole registrable family. Atomic domain-scoped replacement with rollback preserves unrelated and unsafe-to-import families.
- Integration: bounded operations; no automatic retry of user mutations. Import is a user-triggered daemon operation with observable job state, not a recurring scheduler action.
- Platforms: macOS build/test only; other-platform launch/decryption/discovery verification is deferred and recorded.

## Data flow
The CLI resolves its cwd and passes selectors through the authenticated daemon API. The browser plugin resolves a page and profile, starts owned headless Chrome only if needed, and queues the command against that page. It returns the command's real result or a structured error. Snapshot results include page identity, current URL/title, accessibility text and reference descriptors. Page metadata retains navigation load errors rather than presenting Chrome's internal error URL as the requested destination.

An explicit import resolves a selected source and destination, snapshots any source SQLite files including WAL, obtains a decryption key only when needed, parses and validates rows, and computes safe families before modifying destination cookies. The destination lock covers snapshot/delete/write/rollback. The client can inspect job progress/result; file paths and raw cookie values are never logged. Source snapshots and plaintext temporaries are removed on both success and failure. Failed live writes are not reported as imported: preserve the source's restart-fallback warning semantics when no safe cold-replay mechanism exists, without silently injecting a real Chrome database.

## Behavior & scenarios
Every scenario is acceptance coverage through the real daemon API or quirky CLI. Fixtures are synthetic, process ownership uses a fresh temporary QUIRKY_HOME, and tests kill all processes they start. No test touches real browser profiles or Keychain.

### SC-01: Lazy startup and local browsing
Given a newly enabled plugin with no running browser, listing pages/profiles leaves it idle. Creating a page for a managed worktree starts headless Chrome with a private profile; navigating to an HTTP(S), file or blank page returns its real URL/title. Unsupported schemes fail before navigation. Back, forward and reload reflect history.
- Data before: Default profile; no pages or browser process.
- Walkthrough: agent lists profiles, creates a page, navigates between two fixture pages, goes back/forward and reloads.
- Data after: one managed page with fixture title and the correct URL; browser remains headless and owned.

### SC-02: Target selection and focus isolation
Given pages in two worktrees, explicit page, explicit worktree and CLI cwd select the intended page. Text mutations without either scope fail; invalid selectors never fall back to another page. Read `all` lists both; tab current/show/switch return authoritative active state. Switch invalidates old refs. No command activates a native window.
- Data before: worktrees Cedar and Birch each have a page/input.
- Walkthrough: agent fills Cedar by cwd and Birch by page, lists all and switches Cedar's active page.
- Data after: each input contains only its own text; no unscoped text write succeeds.

### SC-03: Snapshots and stale references
Given an accessible fixture, snapshot returns named roles and refs usable for interaction. Navigation, switching, closing or profile changes invalidate those refs; using one fails with stale/closed/not-found semantics rather than reaching a different element.
- Data before: page has a Submit button.
- Walkthrough: snapshot, click its ref, navigate, then reuse the old ref.
- Data after: first click is observed; reuse is rejected.

### SC-04: Interaction and large input
Click/dblclick, fill/type/inserttext/keypress, select/check/uncheck/focus/hover/clear/select-all/scrollintoview, drag/upload and mouse move/down/up/wheel operate on the scoped page. Unicode inputs exceeding 8 KiB survive exactly; fill does not overflow argv; select-all works on macOS. Clipboard writes over the source's 8 KiB limit fail. Clipboard operations are browser-scoped, not the real desktop clipboard.
- Data before: fixture inputs, select, checkbox, draggable item and file input.
- Walkthrough: agent exercises each family and reads observable DOM/file state back.
- Data after: expected values, checked states, uploaded filename and event records match commands, including exact large Unicode text.

### SC-05: Query, wait and evaluation
Get/is/find/highlight report and act on real page state. Eval awaits promises and returns serializable values; script failures are distinguishable evaluation errors. Wait supports selector/text/url/load/function/state and bounded duration; condition timeout is a timeout error, not success.
- Data before: delayed fixture element hidden.
- Walkthrough: agent waits for visibility, queries it, evaluates a promise, then waits for a nonexistent condition.
- Data after: visible element observed, promised value returned, missing condition times out.

### SC-06: Captures and download
Screenshot/full-screenshot PNG/JPEG and PDF return actual decodable artifacts; full capture covers offscreen content. Download saves to an explicitly selected path; no unexpected OS Downloads writes occur in tests.
- Data before: tall fixture and download link.
- Walkthrough: agent captures each format and downloads the fixture asset.
- Data after: valid image signatures/dimensions, PDF header and exact asset bytes; capture temporaries removed.

### SC-07: Network, console and emulation
Console/network honor requested limits. Capture start/stop yields real HAR records. Every requested interception pattern is installed, listed and removable, not just the first. Viewport scale/mobile, device/geolocation/offline/headers/credentials/media and dialog accept/dismiss affect real browser state.
- Data before: two managed pages; one fetches two endpoints and logs three messages.
- Walkthrough: configure two interception patterns, query logs with limit 1, record HAR and set emulation. While eval awaits a prompt on one page, accept its exact pending dialog with Unicode text; while the other awaits confirm, dismiss it without responding on the first page.
- Data after: both patterns take effect; one requested log entry is returned; HAR contains observed requests; emulation matches requested settings; prompt eval returns exact supplied text and dismissed confirm returns false without timeout or cross-page effects.

### SC-08: Cookie and web storage commands
Cookie get/set/delete preserve domain/path/security attributes and scoped identities; local/session storage get/set/clear act on the current origin. They do not import unrelated browser storage.
- Data before: empty fixture-origin cookies/storage.
- Walkthrough: agent writes and reads values, deletes only the selected cookie and clears the selected storage area.
- Data after: requested values were observed and only selected state cleared.

### SC-09: Exec cannot retarget
Exec parses quoted arguments without a shell, preserves empty arguments, rejects malformed quoting, and cannot change CDP endpoint, session, executable, profile or launch arguments through split/equal-form flags. It cannot switch/close unmanaged targets or attach to another browser.
- Data before: two managed pages.
- Walkthrough: agent executes a harmless quoted query plus attempted target overrides and lifecycle retargeting commands.
- Data after: harmless result is real; override/lifecycle escape fails without modifying either other page.

### SC-10: Lifetime and failure
Closing a page rejects queued work and cancels in-flight child work with page-closed semantics. Chrome/helper crash or idle expiry cannot launch an unrelated browser. Timeouts are bounded; after helper restart, commands proceed only when their page identity is proven, otherwise return changed/closed semantics without mutating any candidate page. Plugin disable/daemon shutdown closes all owned processes, connections and temporary files; restart preserves profiles without adopting an unrelated process.
- Data before: two queued operations and an owned browser.
- Walkthrough: close during work, then restart daemon and disable plugin.
- Data after: work rejects with structured error; durable profile remains; no owned process survives shutdown.

### SC-11: Profiles
List/create/delete/show/set/use-default/clone preserve Default and isolation. Switching a page retains its URL but uses the selected profile's credentials and invalidates refs. Cloning copies source cookies into a new isolated profile; deletion clears/deletes only its own profile and reassigns affected pages to Default. Refused confirmation leaves everything unchanged.
- Data before: Default logged into fixture; isolated Review empty.
- Walkthrough: agent switches, clones, checks isolation, refuses deletion then confirms it.
- Data after: Review never sees Default credentials before explicit clone/import; deleted profile gone, Default remains.

### SC-12: Explicit detection and source selection
Detection enumerates installed supported Chromium families (Chrome, Edge, Arc, Brave, Comet, Helium), Firefox profiles and Safari using selected roots. Discovery runs only on request; unsafe profile directory names are rejected. Permission/lock failures identify the source and actionable close-browser/Full Disk Access remedy.
- Data before: synthetic browser roots with valid and traversal profile entries.
- Walkthrough: agent requests detection/import against fixtures.
- Data after: valid profiles found, traversal refused, source files unchanged, actionable errors for inaccessible sources.

### SC-13: JSON import validation and summary
Import from a JSON cookie array reports total/imported/skipped/domain/warning counts. Invalid JSON, non-array, empty input and entirely invalid rows fail with distinct actionable errors before mutation. Import job state is queryable through CLI/API.
- Data before: existing fixture cookie plus valid/invalid rows in a selected file.
- Walkthrough: agent starts import, waits/queries result and reads resulting cookie state.
- Data after: valid safe rows imported, invalid rows counted; malformed inputs never delete existing state.

### SC-14: Chromium snapshot and decryption
A stable temporary DB/WAL snapshot supplies rows; plaintext and supported macOS v10/v11 AES values, Chromium epoch timestamps, host-hash prefixes, domain/path/SameSite/security and supported partitions are decoded. App-bound/undecryptable values are skipped with explicit warnings; source DB/WAL unchanged. Tests inject synthetic encrypted values and keys, never invoke real Keychain.
- Data before: synthetic SQLite DB including WAL data, decryptable and app-bound cookies.
- Walkthrough: agent imports the selected fixture source.
- Data after: exact decryptable values observed in destination; app-bound count disclosed; snapshots cleaned.

### SC-15: Firefox and Safari sources
Firefox SQLite/WAL rows and Safari binarycookies parse expiry, security and SameSite correctly; expired rows are dropped. Firefox partitioned rows lacking faithful identity suppress their registrable family, never downgrade to unpartitioned. Safari source has no partition field. Malformed/truncated binaries fail safely.
- Data before: synthetic Firefox and Safari files with expired and live cookies.
- Walkthrough: agent imports each selected source.
- Data after: only live faithfully represented families imported; skipped partitioned rows disclosed; source bytes identical.

### SC-16: Domain policy and partition fidelity
Google-source/domain exclusions, public/private suffixes and unsafe domains cannot delete destination logins. Unreadable partition suppresses all sibling rows in its registrable family; an unreadable row with no family refuses the whole import. Supported partition keys retain their ancestor bit and exact partition identity.
- Data before: destination unrelated login, Google login and two private-suffix tenants; source includes safe, unsafe and unreadable-partition rows.
- Walkthrough: agent imports and reads exact destination identities.
- Data after: only safe imported family replaced; unrelated/Google/other tenant/suppressed families unchanged.

### SC-17: Atomic replacement and concurrent imports
Before replacement, snapshot exact destination identities in imported scope; write under one profile mutation lock. A failed delete/write rolls back attempted writes and restores the snapshot, returning a failure rather than a misleading success count. Parallel imports serialize without lost cookies; secret values never enter daemon logs.
- Data before: destination two cookies and unrelated login.
- Walkthrough: imports race; a fixture transport failure interrupts a replace.
- Data after: failure restores exact original identities; unrelated state retained; subsequent valid import works; no credential logs or plaintext temporaries remain.

### SC-18: CLI/catalog and distribution
Every shipped browser behavior is reachable through schema-declared plugin methods and `quirky browser` command group. Help/catalog remain available with no Chrome process running. Packaged plugin resolves its pinned helper/dependencies without depending on the source checkout or upstream Orca.
- Data before: built distribution with no upstream checkout in resolution paths.
- Walkthrough: agent lists help/catalog and runs create/snapshot/import against fixtures.
- Data after: real results and clean ownership; no private kernel imports or Electron dependency.

## Source defect regressions
- DF-01: console/network limit ignored (external browser.md:238): SC-07 asserts exact bounded records.
- DF-02: only first interception pattern installed (external browser.md:240): SC-07 independently observes both patterns.
- DF-03: browser-enable switch is cosmetic (external browser.md:118,256): no false security switch is introduced; API auth/targeting remains authoritative (SC-02/18).
- DF-04: snapshot refs stale across navigation and tab changes (external browser.md:251-255): SC-03 rejects stale refs, never aliases them into a new page.
- DF-05: helper lifecycle/orphan and input focus hazards (external browser.md:194-196,259-261,425-429): SC-02/10 prove headless focus isolation, target binding and cleanup.
- DF-06: source-byte limits and Control+a select-all bug on macOS (external browser.md:220-244,433): SC-04 verifies actual selected text and exact large Unicode payloads.
- DF-07: profile methods unavailable in upstream external-Chromium provider (external-chromium-browser-process.ts:104-112): SC-11 requires working profile lifecycle, not an unavailable stub.

## Industry insights
- Chrome 136 requires a non-default debugging user-data directory: https://developer.chrome.com/blog/remote-debugging-port
- CDP is a privileged trusted-client protocol; keep it loopback-only and never expose credentials/endpoints in untrusted page data: https://chromedevtools.github.io/devtools-protocol/
- agent-browser provides the command/ref vocabulary but does not replace Quirky page/profile ownership: https://github.com/vercel-labs/agent-browser
- Playwright documents connectOverCDP's reduced fidelity: https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
- Auth-state files contain live credentials; cookie import is not complete auth-state import: https://playwright.dev/docs/auth

## Deferred ideas
Only already allocated or dropped scope in Scope & non-goals. [tech-spec] owns dependency packaging, Chrome process discovery, profile storage, direct CDP cookie adapter and synthetic fixture/key-provider boundaries; these are implementation questions, not extra features.

## Glossary
Profile: Quirky-owned Chrome user-data directory. Page: one managed Chrome target with a public page ID and worktree identity. Ref: temporary snapshot element handle, not a durable selector. Imported family: public-suffix-aware registrable site group eligible for replacement. Partition identity: top-level site plus cross-site-ancestor bit identifying a CHIPS cookie. Import job: explicit user-triggered daemon work with observable state, not a periodic scheduler run.
