# Session extras parity sweep

## Conceptual model and purpose
Accounts, Vault, Handoff, Session Info and Terminal Dock remain separate built-in plugins on the public API. This sweep checks every kept flow in their external feature documents, repairs actual gaps, and distinguishes product failures from native/driver limits. Existing source files, provider session identity and daemon-owned state remain authoritative.

## Scope and non-goals
Sources: `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/{accounts,ai-vault,handoff,session-info,terminal-dock}.md`. The complete original M3 scenario catalogs and later completion catalogs remain acceptance obligations, including their error/boundary scenarios; this document does not replace them with narrower examples.

Explicitly excluded: native interactive chat and its resume surfaces, dictation, input-quarantine refusal, standalone skills catalog, Linux/Windows/WSL implementation, GitLab/Bitbucket/Gitea/Forgejo/Azure, Objective runner and PR sitter. Other queued owners retain remote transport and full-owner authority. Native OS chooser/clipboard/Keychain/Finder/focus observations follow pending nightly scenarios; browser evidence cannot certify them. No real credentials, model requests or user provider homes are used.

## Current evidence and alternatives
Recommended: repair the existing Accounts vertical slice and exercise the shipped features. Rebuilding all five would discard current public contracts. Treating historical blocker entries as current defects would duplicate already-landed Vault menu and Dock repairs. Merely recording all flows as complete would ignore the actual Accounts overflow/native Open failures and the end-phase verification obligations.

Initial inspection found Accounts overflow summing chip widths without CSS gaps and hidden max-content measurement escaping layout containment (`src/window/Usage.tsx:403-434`, `styles.ts:39-44`). The earlier measured sweep in `m3-accounts-overflow-verification` D8 remains direct failure evidence: clipped +N at760/960 and document overflow. Codex LoginLinkNotice used target=_blank (`AccountsSettings.tsx:28-49`); the native AC6/7 report observed no Open effect. The canonical `quirky.terminal/openExternal` already opens URLs through the system handler. These established the initial implementation changes; later repairs require actual end-phase evidence.

Vault Copy First Prompt/Log Path are already portaled, scrollable and tested. Dock's old question-hit-target, refresh, exit and fractional-height gaps were repaired in its unfinished-flow item. Session Info's narrow wrapping is already landed. Their stopped post-fix verification is not permission to claim success or add speculative replacement code.

## Data flow
Accounts reads secret-free quota and account projections; Usage measures rendered space and chooses a visible prefix plus an accessible suffix button. Open uses only the allowlisted URL from the current login projection and the existing public system-opener method, with visible failure feedback. No authentication state is copied, selected, refreshed or removed by opening a link.

Vault scans/indexes source-owned sessions on its Worker, scopes by registered identity, and passes archived SourceRef to Handoff through its effective public contribution. Handoff composes a reviewable draft and locked-last notice, starts a separate terminal session and records one-hop lineage; uncertain delivery is not automatically replayed. Session Info follows exact focused terminal/provider identity and per-launch statusline consent. Dock serializes accepted PTY input and retains newer drafts/attachments across uncertain sends and interrupts.

## Decisions locked
- Existing feature layouts and contribution IDs; no second shell or state authority. Keep accessible controls reachable at constrained widths.
- Compact/Used defaults and consumption-based urgency; Remaining changes displayed percentages, not urgency. Hidden measurement content cannot enlarge the page or intercept input. Overflow fitting includes actual chip gaps and overflow-button size. Growth restores all chips; badge-only mode uses actual badge widths.
- Codex Open uses `quirky.terminal/openExternal({target: pending.url})` only after existing URL validation. It must not depend on browser pop-up support, navigate the Quirky window, report success after failure or alter login/account selection.
- Search stays off until consent, clear disables before deletion, source bytes remain unchanged, unknown scopes do not widen, stale cursors replace page1, host-qualified paths remain redacted where required.
- Preserve exact provider/source/account/host identities and revision fences, generation guards, no automatic uncertain resend or destructive replay.
- No writes to real ~/.claude/.codex/.quirky; per-launch Claude telemetry/effort adaptation remains locked.

## Behavior and acceptance matrix
Every row describes before, walkthrough and required after. API/CLI proof drives the real daemon with temporary source/provider homes. Visible flows additionally use the built web surface; inherently OS-only outcomes are explicitly native handoffs.

| ID | Before and walkthrough | Required after |
|---|---|---|
| A1 | Ten configured quota fixtures; resize through constrained and wide widths; inspect suffix and choose +N. | No page/row overflow or clipped button; exact omitted suffix title; opens Usage; widening restores chips. Repeat Compact/Detailed, Used/Remaining and badge-only. |
| A2 | No configured provider, then idle/fetching/ok/unavailable/error/stale quota fixtures; refresh and change visibility/density. | CTA/hide, loading/sign-in/error copy, all windows/balances/reset times, consumed urgency and persisted preferences are honest; refresh redetects; roster sorts worst first. |
| A3 | Isolated synthetic Claude/Codex logins; add/cancel/copy-link/open/reauthenticate/select/System default/remove, including duplicate and unreadable/untrusted homes. | Official provider CLI protocol/private ownership; Claude add not selected, Codex selected; no user-home mutation; allowlisted link reaches system opener, refusal visible; failed/cancelled work preserves committed auth. |
| A4 | Live old-account conversations; switch with Ask/Always/Never, busy/idle, Keep/Restart and opt-out; remove old account and resume again. | Old process identity remains truthful until explicit preserving restart; exact revision/selection and full accumulated native conversation content survive; no account fallback on transient errors. |
| A5 | Captured Codex reset offer; cancel/confirm/opt-out/replay and change account/offer; configure encrypted fixture meter keys and read Grok/Cursor status. | No duplicate spend, captured offer fence, secret-free status, correct clear/reload; read-only providers never rotate/write auth; stale/backoff/live-feed/inactive-account policies hold. |
| V1 | Local fixtures across25 formats plus old in-scope sessions; browse Workspace/Project/All, host/filter/group/depth/sort/reset/refresh/show-more, narrow panel. | Exact source identity and contextual scope; bounded rendered rows; stable view options; no globally capped loss of old scoped records; explicit loading/empty/degraded states. |
| V2 | Search off then consent, query words/phrases/operators/typos, paging, source append/rewrite/truncate/replace/sidecars/SQLite/deletion/unreadable roots and retention. | Opt-in disposable index, documented fallback semantics/snippet highlights, source-preserving reconciliation and generation/incarnation paging, honest source presence and limits, unknown scopes never widen. |
| V3 | Selected parent/child after Worker restart; expand/copy first prompt/ID/path/resume command; view/open/reveal/jump/cwd, keyboard/drag resume, handoff, safe confirmed Trash. | Literal selected data and configured launch args; exact live destination/group; effective archived handoff; cancel/symlink refusal preserves outsiders; cache/index cannot resurrect trashed source. |
| V4 | Settings status/enable-all/open sidebar/disable/clear; lazy Worker idle/crash/shutdown and CLI invalid combinations. | Honest counts/unsupported/partial host status; local first; clear does not immediately rebuild; packaged Worker lifecycle settles calls and owns no leaked processes. |
| H1 | Live source then archived Vault source; open handoff, choose existing/new worktree, agent and relationship, controls/template/notes. | Source stays running, target-host detection exact, no-context blocked, new worktree created only at Start, failure keeps edited fields. |
| H2 | Busy source; Wait/Capture, focused/full transcript, Git status/diff cap/open tabs, edit preview/detach/regenerate and Cancel/Escape reopen. | Correct original-source content and safe target reachability; latest context requires review; detached edits preserved/stale labelled; draft retained, full transcript only if genuinely reachable. |
| H3 | Start handoff, inspect actual child argv/stdin and both lineage directions; exercise confirmed/uncertain delivery/manual resend, templates CRUD/reset. | Locked notice appended last, all user blocks fenced, no false repository warning, duplicate-risk warning, exact child/session/tab lineage and working jump, best-effort lineage errors never misreport spawned child as failed. |
| I1 | Focus shell/Claude/neutral agent/split; open/close sections/restart and trigger Copy ID/Open Vault/Focus/Open/Reveal transcript. | Correct empty state and focused identity, only supported sections, daemon-persisted sections, exact Vault filter and no-spawn pane focus; all actions reachable at220/240/280px with long IDs/errors. |
| I2 | Partial Claude statusline, turn-end transcript scan, replacement session and delayed old ticks, custom statusline consent/drift, configured MCP and failures/retry. | Correlated model/usage/context/files/plan windows, no stale cross-session leak; waiting vs estimated vs stale honest; per-launch chain preserves user command/settings/stdout; neutral/remote locality gates and teardown bounds. |
| D1 | Plain shell and supported agent; enable/auto-open/manual Hide/Show, remembered user hide, exit/relaunch, feature disable/re-enable and remount/reconnect. | Only eligible pane docks; no stale focus stealing or state writes while flag off; active composer focus restored; actual manual Show visible; exact pane state survives appropriate lifecycle. |
| D2 | Compose multiline/Enter/Shift+Enter/history, slash/skill/@ pickers, actual attachment acquisition/paste/drop/removal; send and edit newer draft then Stop/Escape. | PTY clear/body/separate Enter accepted in order; literal prompt once; newer text/attachments retained on failure/interruption; history bounds; no false Codex warning after positive transcript evidence; no persistent global Claude effort command. |
| D3 | Visible question card collapse/expand/answer/dismiss/refresh; model/effort permission/context controls; passthrough and remote/mobile-disabled state. | Controls hittable, answered card retires immediately, dismissed pending request still blocks send, safe session-only option success/refusal, passthrough no false mobile hold, no lost draft. |
| D4 | Drag rows3..15 and exact short-pane239/260/280 threshold; multiple focused/background splits, direct authenticated SessionEnd/foreign-child negative, whole PTY exit. | One final PTY fit, correct hysteresis from rendered pixels, focus owner only, automatic undock/reopen uses fresh exact provider evidence, all owned resources cleaned. |

## Orca defects and regression obligations
Accounts: never log out or mutate the user's default homes; fix native Open no-op and narrow suffix clipping rather than preserve them. Vault: preserve real first-prompt access, literal configured resume arguments and documented quote fallback; do not reinstate historical clipped row menus. Handoff: healthy repository state must not emit the false warning; lineage jump works; Cancel/Escape keeps drafts; uncertain delivery never implies confirmed receipt. Session Info: completed turns can populate usage without statusline, old-session ticks never leak, custom statusline never replaced globally, long stale errors wrap. Dock: positive Codex transcript evidence must not restore a false failed-send draft, local passthrough never claims mobile ownership, effort does not write global Claude settings, question-card click targets are reachable, queued interruption preserves all drafts.

## Execution contract
See [the technical specification](tech.md) for the exact file scopes, inherited API schemas, DO-NOT-CHANGE fences, test commands, isolated fixture contract and integration gates. End-phase normal workflow requires the sibling tech spec and combined spec review before implementation; the build-first one-spec shortcut no longer applies.

## Industry insights
No new research swarm under LOOP. Existing M3 decisions and feature docs provide evidence: native CLI credential isolation, generation-fenced disposable indexes, explicit PTY receipt boundaries and event-driven focus prevent duplicate authority and false success.

## Deferred ideas
The source audit found genuinely unbuilt paired-owner composition: focused-owner Accounts state/sign-in gates, a shipped production Vault host contributor/actions, and host-qualified Handoff detection/reachability/secret-warning/delivery/lineage. Preserve those requirements in the single implementation successor `m7-session-extras-owner-host-flows`, dependent on this item and `m7-vm-and-owner-bound-host-workspaces`; register it through the canonical queue just before landing. Local core remains independently usable. Test-only forwarders, phone/worker grants and local fallback do not implement these flows. Native-only/platform exclusions retain their existing handoffs. No verification-only follow-up is authorized.

## Glossary
- **Source identity:** agent plus provider session/transcript and host, independent of title.
- **Receipt:** accepted transport input, not proof the agent consumed or answered it.
- **Suffix:** providers omitted from the visible prefix, represented by +N and its exact title.
- **Native handoff:** pending OS-only scenario, never a claimed headless pass.

## Status & amendments
Status: Approved autonomously per LOOP.md. Tech spec required: crosses public UI/daemon boundary and touches at least three source files. Self-reviewed against all five docs and current completion source: no requirement intentionally narrowed.

**Amendments:** 2026-10-28 — Initial sweep contract. Historical Vault/Dock failures are classified using their later fixes, not repeated as current missing implementation. Normal end-phase verification applies because triage is claimed.

**Amendments:** 2026-10-28 — Correct phase interpretation before implementation: triage claim ends build-first shortcuts as well as test suppression. Author sibling tech.md and run the required combined specification review.

**Amendments:** 2026-10-28 — Actual generated CLI smoke found stable manifest command IDs did not match Accounts' module exports. Extend the existing A3/A5 scripting acceptance to require the declared `login-status`, `cancel-login`, profile, credential, UI-state and reset/describe commands to dispatch through their unchanged catalog IDs. Migrate implementation keys and direct consumers without aliases.

**Amendments:** 2026-10-28 — Valid provider model discovery failed because the direct-spawn path used a shell-override-only executable resolver. Discovery must use the actual located executable whether it is on the login PATH or an install directory; retain account preparation, nonempty-authority and failure snapshot fences. Kernel confirmation failure is owned by the user's canonical lane12 fix through existing Ask list, not a new API on this branch.

**Amendments:** 2026-10-28 — Source audit distinguished the unbuilt paired-owner composition from already working local flows; retain the exact implementation obligations in the single prerequisite-bound successor above. Current remote daemon/PTY/CLI proof and partial guarded web observations do not certify unrun visual/native outcomes. Incoming shell/Ask/Accounts authority contracts supersede obsolete fixture selectors and private assumptions.
