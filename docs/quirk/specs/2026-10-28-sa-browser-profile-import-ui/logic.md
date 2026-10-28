# Browser profile cookie import UI

## Status & amendments
Approved autonomously under docs/loop/LOOP.md on 2026-10-28. Combined logic and technical specification under build-first rules. Self-reviewed against browser.md section 2 and Cookie import in detail; no open questions.

## Purpose and conceptual model
Connect the shipped import engine to the built-in Browser plugin's human controls. Imported credentials belong to the explicitly selected managed Chrome profile, available in Watch/agent Chrome, never the Native system webview. A source browser/profile is an explicitly selected read-only source; the destination profile is independent. Import replaces the engine's safe matching site families, not all stored cookies.

## Scope and non-goals
Own Browser menu Import Cookies, toolbar Import browser data hint, per-profile Settings import controls, detected browser/profile rows, From File dialog, import progress/results/error toasts and persisted imported-source badges. Existing public API and CLI import methods remain canonical. No new native cookie backend, host selector, remote credential routing, Chrome engine/decryption changes, profile deletion repairs, identity changes, design tools or unrelated browser flows.

## Decisions locked / alternatives
- Reuse one shared import panel and tracked daemon jobs across all entry points. Separate implementations risk drift; synchronous imports hide long-running progress.
- Detect sources only after explicit opening of Import Cookies or the import hint. No startup, preference read or ordinary Browser menu detection. Loading, empty and error states stay distinct; a detection failure does not disable From File.
- One source profile renders directly as From Browser; multiple profiles render nested named choices. Only detected sources appear, with a refresh action requiring another explicit click.
- Each Settings profile owns its Import Cookies control. Menu/hint destination is the pane's selected profile. Capture the destination on submission, confirm replacement, and disable duplicate submissions through confirmation/file reading/start/poll. A pane profile change must not retarget an accepted job.
- From File opens a labeled Import Cookies dialog and uses the browser file chooser, reading explicit selected JSON bytes into the existing JSON import source. Never send a fabricated daemon-side path. Cancel has no mutation, invalid JSON/non-array/empty arrays show errors without a job.
- Show the managed-Chrome/Native distinction and Google exclusion before import and in results. Success requires terminal succeeded plus a real summary; zero imported is not described as restoring logins. Show skipped/Google/partition counts and engine warnings. Failed jobs and RPC failures show errors, not success.
- Closing a control stops its UI polling; the accepted daemon job remains owned by the daemon and queryable via existing importGet/importList. Do not cancel real work on a React unmount. Suppress stale component updates and scope any completion to the captured destination. Refresh profile metadata after success; refresh failure does not relabel a successful import as failed.
- File metadata uses the existing json source provenance, labeled JSON file/data. Source names are text, never HTML. Never toast or log cookie names/values/file content.

## Acceptance scenarios
1. **Explicit source opening:** Before: Browser Settings/menu mounted, no detection call. Open Import Cookies for Default: loading then only detected Google Chrome/Edge etc.; several Chrome profiles appear by profile name, singleton Firefox has a direct row. After: no import until selection/confirmation. Empty detection shows no supported browsers, retains From File and refresh. Detection rejection shows alert, retains file import.
2. **Browser/profile selection:** Before: Review selected, Chrome has Default/Work. Choose Work and confirm. After: importStart receives Review plus browser/chrome/Work; queued/running are visible and repeated clicks cannot create another job. A simultaneous pane change to Default cannot write Default. Terminal success shows actual counts/source/destination, refreshes metadata and toast; menu and Settings show source badge.
3. **File dialog:** Before: Settings Review row opened. From File displays Import Cookies dialog and JSON chooser; cancel leaves data untouched. Select cookie JSON and confirm: JSON source goes to Review, not Default or a client filesystem path. Malformed/non-array/empty input stays inline and raises an error toast without importStart. Re-selecting a file can recover.
4. **Summary and warnings:** Given result total 5/imported 2/skipped 3/Google skipped 1/partition skipped 2, show those exact distinctions plus warning codes/reasons. Given imported 0, explicitly show 0 imported, never claim native logins work. Google exclusion and managed Chrome destination remain visible.
5. **Failure and unmount:** Given denied source access/failed rollback/job failure, show backend error and no success toast/badge. Given closed control while running, stop polling and do not send another job/cancel or report success locally. API job remains queryable. A stale detection response from a closed/replaced panel cannot update current choices.
6. **All entry points:** Menu and hint use current pane profile, retain Browser Settings/Hide Hint; Settings supplies each row's exact ID and source badge. Imported Default remains Default for clear/remove semantics. Hide Hint persists through canonical setting API.

## Defects prevented
- No startup access to protected source directories or Keychain.
- No fabricated installed-browser rows, no no-op success and no daemon path inferred from input.value.
- No UI claim that managed Chrome import changes Native WKWebView sessions.
- No successful toast before job terminal success; partial/zero import and engine warnings remain visible.
- No target drift, double submission or stale-result mutation during a profile switch/unmount.
Engine rollback/Google/partition behavior already has owned backend coverage; this item connects visible outcomes without replacing that policy.

## Industry insights
No external research swarm under build-first LOOP. Requirements grounded in research/orca-features/browser.md section 2, lines 391–435; architecture.md Browser; sa-browser-agent-extras D2,D3,D6,D10–D12; sa-browser-profiles-settings D4,D9. Real API contracts inspected in cookies/types.ts, cookies/sources.ts and quirky-plugin.json.

## Glossary
Source: installed browser/profile or user-selected JSON contents. Destination: managed Chrome profile ID. Native: separate system webview, not imported by this engine. Job: daemon-owned queued/running/succeeded/failed operation.

## Deferred ideas
None; no extra unbuilt flow introduced. Native/remote prerequisites retain existing owner boundaries.

## Technical decisions and contracts
- PreferencesState.imports becomes `{available:true,destination:'managed-chrome',nativeSupported:false,reason:string}`. Controller emits this capability without discovery. The preference parser consumes the new shape; update all fixtures/assertions rather than retaining the obsolete unavailable contract.
- New `CookieImportPanel` in preferences-window/CookieImportPanel.tsx consumes `CookieImportPanelProps` from preferences/contract.ts: context, imports|null, destination `{id,label}`, optional loadError/onHideHint, onError(message), onImported():Promise<void>. Reuse existing DetectedBrowser, ImportSource, ImportJob, ImportSummary types via type-only imports; never import backend source code into a UI bundle.
- Shared panel owns detection/file dialog/confirmation/tracked-job polling/status/toasts. BrowserProfileMenu.tsx owns menu/hint composition; BrowserSettings.tsx owns row target and badges. Remove obsolete ImportDetails, not an alias.
- Existing public methods: detectBrowsers()->{browsers}; importStart({profile,source,yes:true})->{id}; importGet({id})->ImportJob. Public context.confirm precedes yes:true. Use one in-flight polling request at a time with cleanup on unmount. No new API methods or CLI aliases.
- Backend+contract integration parent; one isolated panel implementer; one isolated menu/settings implementer. At most two OpenAI omp workers, scopes disjoint after parent contracts commit. No reviews/suite runs; permanent behavior tests authored but not run under LOOP. Parent runs root typecheck and an isolated focused actual-surface smoke required by developer, not a full dogfood campaign.
