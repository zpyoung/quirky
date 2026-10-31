# AI vault: browse, resume and opt-in transcript search

Reader: feature reviewers — Decision: whether the vault preserves every surviving documented agent-history flow without silently indexing private conversations.

## Conceptual model

The vault is a view of agent-owned session files, not a new conversation store. A person opens Agent Session History, finds a past session by context or remembered words, inspects its evidence, and resumes it through that agent's existing CLI. Scripts perform the same actions through the daemon API and the vault CLI group.

Browsing scans the 25 documented source formats and caches derived metadata. Full-text search is separate, disabled until explicit consent, and keeps a disposable searchable copy on the answering computer. Disabling search preserves that copy; clearing search data disables search before removing the copy. Neither operation changes agent transcripts.

## Scope and non-goals

Full parity contract: the feature document's macOS local browse, filters, settings, title filtering, full-text indexing/search/status, session previews/subagents, provider-specific terminal resume, navigation/copy/log/reveal/delete, handoff integration, session-info vault navigation, keyboard/drag interactions, CLI/API contracts, cancellation/freshness and error states. The source inventory includes all 25 history agents, including sidecar- and SQLite-backed sources. Existing account/profile roots must be discoverable when their owner exposes them.

**Operator-authorized landing amendment:** this item lands the core browse/resume, explicit-consent transcript search and disable/clear flows. Remaining advanced flows and incomplete proof obligations are named individually in [BLOCKERS.md](../../../loop/BLOCKERS.md#m3-vault-open-review-findings) and the dependent `m3-vault-parity-completion` item. The scenario catalog below remains that completion contract; it is not a claim that every scenario passed in this landing.

Explicit exclusions are native-chat actions, the native-chat /resume modal and chat-only structured ownership, because interactive native chat is dropped; SSH/WSL hosts and their scanning because SSH/WSL remote is dropped; Windows/Linux execution under the macOS-only rule. Pairing, non-loopback listeners, E2EE and the mobile application belong to the separate mobile roadmap slice; the vault must not invent another transport. Local and All hosts work with no paired servers, and host forwarding/access policy uses the shared authenticated transport when available. A dependent feature not being installed must produce an honest unavailable action, not simulated success.

No network search service, embeddings, cloud transcript upload, automatic account discovery outside supported roots, new retention editor, telemetry, automatic update, or native interactive chat is added.

## Data flow

Opening the panel resolves the active workspace/project and stable view options in daemon state. A lazy worker discovers candidate files, parses agent-specific formats, emits progress and issues, and returns bounded session metadata. Scoped scans select candidates before applying depth so old in-scope sessions are not hidden by newer sessions elsewhere.

With search off, typed text filters titles. Enabling search after the privacy disclosure starts a background worker index pass; the UI can search while indexing continues. Transcript reads supply role-aware evidence to the disposable index. Search applies scope, agents, retention and query operators, chooses ranked sessions, and returns snippets plus a change-sensitive page cursor. A source is checked before an action; absent or unverifiable sources cannot resume.

Resume preserves the original working directory and the correct provider identifier/path, with the current configured agent launch options. Existing worktree/session APIs own terminal placement and process launch. Deletion validates the agent's supported source roots and moves only supported local transcript targets to OS trash after confirmation.

## Key decisions and rationale

Use a lazy Bun Worker inside the daemon. The locked architecture requires worker execution and excludes helper processes. Inline SQLite/parsing is simpler to wire but blocks the API thread and violates that boundary. Orca's forked child provides stronger process isolation but violates the no-helper rule. Bun Workers are experimental; lifecycle, bundling and shutdown need direct verification. The local Bun FTS5 capability probe passed.

Reuse existing provider launch/resume and plugin contributions, rather than inventing another launcher or privileged built-in API. Stable view choices live in daemon-owned plugin state rather than Orca's localStorage, because scripts must read and change what the window shows.

Search stores unredacted conversations and up to 3,072 characters from each tool output. Consent must disclose this and authenticated-client access. Quotes influence the phrase-first retrieval ladder but do not promise strict phrase-only results: the feature document observed later AND/OR fallback.

## Decisions locked

All choices below are autonomous recorded defaults under LOOP.md, unless the cited project decision already fixes them.

- Visual: Agents panel, source defaults, virtualized grouped history; Workspace/Project/All availability follows active context. Stable options persist; context-derived scope does not.
- Visual: explicit progress, empty, partial, unavailable and retry states; no hidden scan/search failure.
- API/CLI: namespaced schema-declared vault methods and command group; shared authentication; the same view commands route to an open window and are readable as daemon state.
- Search: explicit opt-in, role-aware content, source-compatible query ladder/operators/typo repair, bounded evidence, deterministic sorting and generation-bound opaque cursors.
- Data: disposable caches/index; missing versus unreadable versus unverifiable sources remain distinct. Unknown scope must never widen to All.
- Integration: all 25 source types, configured POSIX provider resume, supported local trash deletion, honest dependent-action availability. No native-chat or SSH/WSL implementation.
- Platform: build/test on macOS; log Linux/Windows work rather than claiming cross-platform proof.

## Behavior and acceptance scenarios

Every scenario below must be driven through the real CLI or daemon API in an isolated temporary home. UI scenarios additionally run through the actual web surface. Test-only roots/fake agent executables may replace external agent installations, but they must contain real format fixtures and prove the observable result rather than echo mocked responses.

### Browsing and presentation

1. **SC-01: Discover all supported history formats.** Given one valid transcript source for each of the 25 agents, opening/listing history returns each correct agent/session identity, working directory, title, model/branch when present, timestamps, counts and up to five latest role-labelled previews. Sidecar/SQLite sources and configured profile roots work; subagent/artifact directories do not appear as independent top-level sessions.
   - **Data before:** **Claude history** contains custom title "Timeout repair" and an earlier generated title; **Codex history** contains a rollout and title-index record; each other source contains a session in its documented layout.
   - **Walkthrough:** The client lists history with unlimited depth in the temporary source home.
   - **Data after:** **Claude history** is shown as "Timeout repair"; **Codex history** uses its indexed title; all 25 identities are represented once with their real parsed metadata.
2. **SC-02: Scoped depth does not hide older relevant sessions.** Workspace is initially selected with an active worktree, otherwise Project or All as available. Disabled scopes cannot be selected without their required context. Workspace covers the worktree path(s); Project covers its worktrees. Depth applies to the selected scope.
   - **Data before:** **Current workspace** has one old session; **Other projects** have more than 250 newer sessions.
   - **Walkthrough:** The client opens Workspace history with default depth, then Project, then All.
   - **Data after:** Workspace includes the old matching session; Project includes only that project's worktrees; All returns the newest 250 overall. Unavailable scopes report why and never silently broaden.
3. **SC-03: Stable view options persist and reset.** Agent selection/select-all/clear, project/folder/agent grouping, hide-empty, depth 250/500/1000/unlimited and both sorts affect the list and adjustment badge. Reset restores defaults; show-more increases visible depth. A daemon restart preserves stable choices but recomputes contextual scope.
   - **Data before:** **View** uses defaults with one empty and one nonempty session.
   - **Walkthrough:** The client hides empty sessions, groups by agent, changes depth/sort, restarts, then resets.
   - **Data after:** The nonempty row alone remains after restart under saved choices; reset restores both rows, default grouping/depth/sort and no adjustment badge.
4. **SC-04: Progress, refresh, cancellation and shared scans.** Opening/refreshing shows real scan progress, age and counts; refresh forces a rescan. Coalesced equal scans retain independent caller cancellation. Cancelling all consumers stops the scan; cancelling one does not abort another.
   - **Data before:** **Two clients** request the same delayed scan.
   - **Walkthrough:** Client one cancels; client two completes. A new transcript is added and client two refreshes.
   - **Data after:** Client one is cancelled; client two receives the complete first list and then the refreshed additional session. The cancelled scan cannot overwrite newer cache state.
5. **SC-05: Off-state title filter and no selected agents.** Typing with indexing disabled filters only titles, reports that limitation and offers consent locally. Clearing all agents returns no results and an explicit status, never all agents implicitly.
   - **Data before:** **Session** title is "Timeout repair", transcript contains "aardvark"; indexing is off.
   - **Walkthrough:** The client searches "aardvark", then "Timeout", then deselects every agent.
   - **Data after:** First query has no title matches; second shows the session; no-agent state has no rows and says "No agents selected". No search database was created.
6. **SC-06: Readable and responsive history UI.** The panel has the history header/subtitle, local/all host choice, filters, refresh, scope, search, sort and scan strip; narrow width uses the compact Agents title. Large histories use bounded visible-row rendering. Groups collapse and rows expand without losing selection or showing another row's details.
   - **Screen states:** Empty profile: resume-past-sessions guidance. Scanned profile: indexed-history subtitle and counts. No matching filters: explicit empty result. Expanded row: first prompt, latest five turns with roles, subagents and available actions.

### Consent, settings and index lifecycle

7. **SC-07: Explicit consent before indexing.** Search is off for missing/malformed settings. The consent card and Settings expose the same opt-in and disclose full unredacted conversations, capped tool output, local storage and authenticated-client search access. Enable persists policy, marks the related tip seen and retries the active query. A failed settings write leaves it off with actionable error.
   - **Data before:** **Search policy** is absent; **Transcript** contains a private term.
   - **Walkthrough:** The client checks status/browses, then explicitly enables search.
   - **Data after:** Before consent no search DB exists; after consent the enabled policy survives restart and the private term becomes searchable once indexed. A rejected enable never reports success.
8. **SC-08: Settings status and navigation.** Agent Session Search shows local status, indexed/total session and searchable-message counts, failed files and unchecked roots. It polls faster while indexing, offers Open in sidebar with focused search, and supports the same API-driven actions.
   - **Screen states:** Indexing: indexed-of-total and message counts. Current: total searchable sessions/messages. Degraded: read/scan issue counts. Open: Agents panel and search focus visible in daemon UI state.
   - **Advanced:** Searchable-session/message counts, files owed, files needing retry and unchecked roots stay inside the Advanced card and expand or collapse with it.
9. **SC-09: Disable preserves, clear destroys only derived search data.** Disable closes the index without deleting it. Confirmed clear switches off before deleting DB/WAL/SHM; no immediate rebuild. Cancelling clear changes nothing. A later explicit enable rebuilds from original transcripts.
   - **Data before:** **Search** is enabled with indexed term "login" and intact source transcripts.
   - **Walkthrough:** Disable, enable, cancel clear, then confirm clear through the irreversible-action API with explicit consent.
   - **Data after:** Disable retains the DB; cancelled clear retains enabled data; confirmed clear leaves disabled/no search data with original transcripts intact. Re-enable recovers "login" from the sources.
10. **SC-10: Freshness and retention.** Append, rewrite, truncate, replace and sidecar-title updates reconcile correctly; unchanged files skip unnecessary reads. Failed files are retried and held out after three failures at the same mtime until changed. Valid retention purges old indexed content without deleting source files. Fresh search waits at most the documented deadline and reports freshness truncation if work remains.
    - **Data before:** **Transcript** has "oldmarker" and is indexed; another source is older than the configured history window.
    - **Walkthrough:** Replace with "newmarker", change the sidecar title, request fresh search and apply retention.
    - **Data after:** New content/title replaces old content, old retained-out content does not answer, originals remain on disk and status describes any owed work.
11. **SC-11: Resilient source/index lifecycle.** File/root failures produce partial issues/degraded state without preventing healthy sources from browsing/searching. An empty/unmounted previously populated root is unverifiable, not proof every transcript was deleted. A genuinely missing file is eventually removed from answers; a missing source hit is labelled and cannot resume. Index schema mismatch rebuilds only disposable data. Worker failure rejects pending calls honestly and recovers on later work.
    - **Data before:** **Healthy source** and **Unavailable root** are indexed.
    - **Walkthrough:** Make one root unreadable/empty and remove one proven-present individual file; trigger reconciliation.
    - **Data after:** Healthy results remain; root failure is visible rather than wiping its index; proven missing source is unresumable and removed on confirmed deletion; later recovery reflects restored sources.

### Search semantics and paging

12. **SC-12: Conversation and tool search with evidence.** Search conversation scope matches user/assistant text; all scope additionally matches capped tool output and split identifiers. Tool characters beyond 3,072 are not indexed; user/assistant text is chunked rather than arbitrarily dropped. Evidence marks matched words, labels role/time and is bounded.
    - **Data before:** **Session** contains user "fix login timeout", tool "resolveTerminalPath" followed by output beyond the cap.
    - **Walkthrough:** Search "login", "terminal path" and a unique term occurring only beyond the tool cap in each relevant scope.
    - **Data after:** "login" has user evidence; identifier search matches only all scope; beyond-cap-only text does not match; highlights are rendered as text, never executable HTML.
13. **SC-13: Query ladder and literal safety.** Plain text, quoted phrases, code punctuation, filenames, camelCase, stop words and quotes are planned safely; phrase-first, AND, typo repair and OR fallback follow the source behavior. Quotes do not guarantee phrase-only results after fallback. Malformed FTS-like syntax never executes SQL or throws a raw SQLite error to the user.
    - **Data before:** **Sessions** include terminal-related messages with sufficient vocabulary frequency.
    - **Walkthrough:** Search "terminl", a quoted phrase, `foo OR bar` and a string with unmatched quotes/metacharacters.
    - **Data after:** Typo repair reports terminal when eligible; phrase ladder yields legitimate evidence; each remaining query is safely planned and yields results/empty status, not a SQL syntax exception or broadened raw-FTS injection.
14. **SC-14: Operators and filters never widen scope.** repo:/path: narrow by working directory; operator-only queries return newest matching sessions with metadata evidence. Agent/since/path/workspace/project/retention filters compose; unknown scope returns unavailable rather than global results. Paths are bounded and literal.
    - **Data before:** **Project alpha** and **Project beta** contain the same term.
    - **Walkthrough:** Search `repo:alpha`, then the term within beta, then an unknown workspace identity.
    - **Data after:** First returns only alpha; second only beta; unknown workspace returns scope-unknown and neither project's sessions.
15. **SC-15: Stable ranked pages and fork collapse.** Relevance/newest order is deterministic. Equivalent conversation forks collapse to the newest copy with duplicate count. Page cursors bind the query, filters, generation and index incarnation; malformed/wrong-query cursors fail. A write or clear/rebuild makes old cursors stale, and the UI restarts at page one.
    - **Data before:** **Matches** span multiple pages with tied scores/timestamps; **Fork copies** share the required content hash.
    - **Walkthrough:** Page through unchanged results, then append a matching message and request another page with the old cursor.
    - **Data after:** Unchanged pages have no repeats/skips and one newest fork representative; the old cursor returns stale and the UI replaces, not appends to, its result set.
16. **SC-16: Honest availability and limits.** Disabled/not-ready/no-service/unsupported-agent/scope-unknown/connection-error states are distinguishable; unavailable host search falls back only to that host's title browsing where supported. Candidate/query/snippet/freshness limits are reported. No results is distinct from failure.
    - **Screen states:** Search off: title-only notice/Enable. Not ready: retry shortly. Missing scope: switch to All explicitly. Partial limit: narrow query guidance. Connection failure: retry; no invented empty success.

### Session actions and scripting

17. **SC-17: Provider-specific terminal resume and copy command.** Each history agent uses its correct resume form, source identity and original cwd, configured command/arguments/environment/model options and managed account home where required. Resume in worktree/new terminal/tab uses supported placement. Copy command is shell-safe; source absence/unverifiability or nonresumable empty content refuses launch.
    - **Data before:** **Session** lives in a directory containing spaces/apostrophes and has a provider ID/path containing shell metacharacters; its agent has configured launch options.
    - **Walkthrough:** Prepare/copy the resume command and resume using a fake provider executable that logs actual argv/cwd/env to the temporary home.
    - **Data after:** Logged values equal the source/configured literals; no metacharacters execute. New terminal is associated with the correct worktree. No source means no launched session.
18. **SC-18: Inspect and navigate.** Row expansion exposes full first prompt on demand, latest turns and supported Claude/OMP subagents. Copy first prompt/session ID/path, View/Open/Reveal Log and Open Working Directory target the selected source; jump-to-original-pane/worktree/folder uses live identity, not titles. Errors are visible and do not falsely announce copied/opened success.
    - **Data before:** **Selected session** has a long first prompt, five recent turns, one subagent and a live original pane.
    - **Walkthrough:** Inspect, copy prompt, view/reveal the log and jump to the original pane.
    - **Data after:** Full prompt is copied, log is the original source, subagent appears under its parent and the live pane/worktree is focused in daemon state.
19. **SC-19: Safe supported deletion.** Supported local agents move validated transcript companions/main file to OS trash, companions first. Unsupported agents, synthetic DB sources, symlinks, escaped realpaths and nonlocal requests are rejected. Already missing files count as deleted. Confirmation is required unless an explicit yes is passed. Deletion invalidates in-flight list caches and index results.
    - **Data before:** **Supported source** and **Outside sentinel** exist; a source-root symlink points outside.
    - **Walkthrough:** Decline deletion, attempt unsupported/symlink/outside paths, then confirm a valid deletion while a scan is running.
    - **Data after:** Decline/rejections preserve originals and sentinel; valid targets reach trash, vanished source does not return through a stale scan and indexed answers stop reporting it.
20. **SC-20: Keyboard and drag use the same resume contract.** Up/Down changes selection and Enter resumes the selected resumable row. Dragging a session title onto a tab group resumes there, not an arbitrary current group. No drag/Enter launch occurs for unavailable source.
    - **Data before:** **Two tab groups** exist and **History row** is selected.
    - **Walkthrough:** Navigate rows by keyboard, then drag the intended row to the nonactive group.
    - **Data after:** Selection follows keys; exactly one resumed tab is inserted into the explicit drop target and contains the correct provider session.
21. **SC-21: Related features route through their public APIs.** Session Info's Open Vault preselects session ID/agent and opens/focuses history. Hand Off to Another Agent uses the handoff owner's public action with the selected source. If that feature is unavailable, the action says so; it never fakes a handoff or reintroduces native chat.
    - **Data before:** **Live agent session** has a provider session identity; handoff feature is enabled, then disabled.
    - **Walkthrough:** Open Vault from session identity, invoke handoff, disable that feature and retry availability.
    - **Data after:** History is prefiltered to the correct identity; enabled action opens/runs the real handoff flow; disabled action reports unavailable without launching a false continuation.
22. **SC-22: CLI and API cover every action.** Vault has a declared command group for browse/refresh/options/status/search/enable/clear/inspect/resume/actions and UI commands. Search exposes the source flags including fresh, limit, cursor, repeated agent/path, since, scope, sort, debug and JSON. Index-status cannot mix query flags; since requires an offset and paths cap at 64. Invalid input returns a nonzero CLI exit and actionable schema/contract error.
    - **Data before:** **Daemon** runs with an isolated home and source fixtures.
    - **Walkthrough:** Enumerate `quirky api --json`, drive each flow by declared CLI or API, and issue invalid status/query, path-count and timestamp combinations.
    - **Data after:** Every UI action has a schema-visible scriptable equivalent; invalid combinations fail without side effects; valid JSON results match UI state and selected source.
23. **SC-23: Host choices and transport policy are truthful.** With no paired server, Local Mac and All hosts both use only local sources without fictional hosts. When the shared transport supplies hosts, all-host queries preserve host identity/partial failures, enable-all runs local first then servers, unsupported hosts report unavailable, and relayed responses omit source paths/resume commands and root paths. Web-client enablement follows the host policy rather than silently indexing another computer.
    - **Data before:** **Host registry** contains no paired hosts, then authenticated test host endpoints with one unavailable service.
    - **Walkthrough:** List/search local and all, test transport redaction and switch enablement where authorized.
    - **Data after:** No-host mode is equivalent and labelled truthfully; aggregate responses identify searched/skipped hosts and never leak redacted fields. Unauthorized enable requests fail.
24. **SC-24: Lazy lifecycle and packaged runtime.** An unused vault starts no scanner worker or search DB. First browse/search activates the proper contribution and worker. Production build includes its worker entrypoint; disable/shutdown closes resources and pending calls. Worker idle retirement does not strand a live index and worker recovery cannot silently lose a requested action.
    - **Data before:** **Built daemon** starts without vault use.
    - **Walkthrough:** Inspect lazy state, browse, enable/search, deactivate the plugin and shut down.
    - **Data after:** Resources exist only when needed; the packaged changed path works; deactivation/shutdown completes without leaked workers/processes or false success.

## Defects and boundary regressions

The feature document has no separately labelled Orca defect list. Its verified differences are observable requirements, not permission to omit tests: quoted queries can fall back beyond exact phrases (SC-13), first prompt appears above latest turns (SC-18), worktree-aware Resume and configured quoted launch options are preserved (SC-17), and the history-depth control/show-more remain present (SC-03).

Boundary regressions must prove no accidental indexing before consent (SC-05/07), no scope widening (SC-02/14), no stale pagination/cache after changes (SC-04/15/19), no source-loss resume (SC-11/17), no destructive path escape (SC-19), no arbitrary shell execution (SC-17), no raw-HTML snippet execution (SC-12), and no clear-triggered rebuild (SC-09).

## Industry insights

- [SQLite FTS5](https://www.sqlite.org/fts5.html#full_text_query_syntax): bound MATCH parameters still contain FTS syntax. Quote planned terms rather than accepting arbitrary user FTS expressions.
- [SQLite isolation](https://www.sqlite.org/isolation.html): read snapshots do not span unrelated requests. Generation/incarnation-bound cursors make index mutation explicit.
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite) and [Workers](https://bun.sh/docs/runtime/workers): synchronous SQLite belongs off the daemon thread. Worker termination is experimental; graceful resource closure and failure tests are necessary.
- [Bun standalone executables](https://bun.sh/docs/bundler/executables): worker entrypoints must ship explicitly; a source-only test does not prove packaged operation.
- [Claude sessions](https://code.claude.com/docs/en/agent-sdk/sessions) and [Bash quoting](https://www.gnu.org/software/bash/manual/html_node/Quoting.html): resume requires the correct provider identity, original cwd and literal safe argument boundaries.

## Deferred ideas

No feature expansion. Technical choices for parser reuse, Worker protocol, public UI extensions, schema models and packaging belong in the sibling technical spec. Mobile transport/pairing and explicitly dropped native-chat/SSH/WSL surfaces remain with their locked scope owners, not a substitute vault implementation.

## Glossary

- Source: agent-owned transcript plus any metadata/SQLite sidecars required to interpret it.
- Browse cache: disposable parsed metadata that accelerates history discovery independently of search consent.
- Search index: opt-in unredacted derived content in SQLite FTS5.
- Generation/incarnation: index mutation sequence and database identity that make paging invalidation observable.
- Unverifiable: source/root availability cannot be established; distinct from proven missing.
- Handoff: a separate feature's cross-agent continuation, not ordinary same-agent resume.

## Status & amendments

Status: Approved autonomously under LOOP.md after the mandatory Codex promote/refute review. Technical F3/F4 corrections preserve this behavior contract. Tech spec required: crosses plugin/runtime/UI subsystems and more than three source files. Same-token local clients retain user-level consented indexing access under the locked one-API authorization model.

**Amendments:** 2026-10-27 — Initial contract approved after review. The later operator note explicitly narrows this landing to core flows, requires a dependent completion item naming unfinished flows and reasons, and reserves the whole-suite run for `queue.ts land` (decision D34). Dropped native-chat/SSH/WSL and separate mobile transport scope is unchanged.
