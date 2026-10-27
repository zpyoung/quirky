# m3-vault decisions

## D1: Follow the unattended design workflow without human asks
- **Question:** How are brainstorming, spec review and implementation questions answered?
- **Options:** Wait for a person; take recommended choices and record every answer.
- **Chose:** Recorded autonomous choices; markdown logic and technical specs; skip visual companion and ADHD offers.
- **Why:** The lane must complete one item without an observer; LOOP.md explicitly substitutes recorded decisions for interactive approvals.
- **Evidence:** docs/loop/LOOP.md:175-199; docs/roadmap.md:185-186.
- **Reversibility:** easy (records and specs are reviewable).
- **Confidence:** high
- **Revisit if:** The unattended protocol changes.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use omp task implementers with Gemini review when Opus is unavailable
- **Question:** Which verified cross-family model pair should build/review this omp item?
- **Options:** omp tasks plus Opus; omp tasks plus Gemini; same-family fallback.
- **Chose:** OpenAI omp task implementers and google/gemini-3.1-pro-preview through pi-watch, high reasoning.
- **Why:** pi-watch --check resolved codex and gemini, but opus and sonnet had no authed/shipping models. Gemini is the next available cross-family pair. The explicitly required spec review still uses Codex.
- **Evidence:** Preflight `pi-watch --check` on 2026-10-27: codex=openai-codex/gpt-6.1-sol:medium; gemini=google/gemini-3.1-pro-preview:high; opus 0/8 and sonnet 0/6 combinations.
- **Reversibility:** easy (no public contract).
- **Confidence:** high
- **Revisit if:** The selected reviewer cannot execute a real review.
- **Source:** locked by docs/loop/LOOP.md

## D3: Select all relevant observable gray areas
- **Question:** Which brainstorming areas matter for the vault?
- **Options:** Basic list only; resolve Visual, API, CLI, Data and Integration boundaries.
- **Chose:** Visual layout/density/loading/empty/error/interaction; API response/errors/auth/pagination; CLI flags/output/exits; Data duplicate handling/retention/error handling; Integration source mapping/resume/hosts.
- **Why:** The feature is a sensitive local-file browser and an opt-in search service, consumed by people and scripts.
- **Evidence:** ai-vault.md sections Browse past sessions, Turn on full-text search, Search, Act on a session, CLI.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Source requirements expose another observable decision.
- **Source:** assumed — autonomous

## D4: Browsing preserves Orca defaults and remains available without indexing
- **Question:** What layout, filtering, persistence, empty and loading behavior should consumers see?
- **Options:** New global search page; existing panel conventions with source defaults; require indexing before browsing.
- **Chose:** Agents panel, Workspace/Project/All with unavailable scopes disabled; local/all-host selector; grouped virtualized rows; 250 default depth with 500/1000/unlimited, show-more, agent selection, hide-empty, project/folder/agent grouping, browse-created/updated and search-relevance/newest sorts, refresh/progress. Persist stable view options in daemon-owned plugin state, never scope derived from active worktree. Off-state query matches titles and offers consent; empty/error states remain explicit.
- **Why:** These are documented user flows; daemon ownership supersedes Orca localStorage to preserve scriptability.
- **Evidence:** ai-vault.md:18-48; docs/architecture.md:207-220; docs/roadmap.md:31-38; m0-ui-api D10,D15.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** The approved public panel/UI contract cannot express a required interaction.
- **Source:** locked by docs/roadmap.md

## D5: Consent controls index creation; disabling preserves it and clear disables before deletion
- **Question:** What privacy, retention and settings/error semantics apply?
- **Options:** Index automatically; explicit opt-in with complete disclosure; redact content silently.
- **Chose:** Off by default, no search DB open/create/content indexing before explicit enable. Consent discloses full conversations, unredacted content, 3072-character tool output and authenticated-client access. Settings and consent card use the same policy. Disable closes but retains database; confirmed clear disables then deletes only disposable search data. historyDays defaults all with a validated maximum 3650; no new retention UI. Enable failures remain failures, never a false enabled state.
- **Why:** Privacy and lifecycle behavior are source requirements; clearing local cache must not remove original transcripts.
- **Evidence:** ai-vault.md:50-61,155-183,240-254; SQLite FTS5 https://www.sqlite.org/fts5.html.
- **Reversibility:** hard (sensitive data already read cannot be unread).
- **Confidence:** high
- **Revisit if:** Consent/access policy changes explicitly.
- **Source:** locked by docs/roadmap.md

## D6: Search preserves scoped evidence and invalidates cursors across writes
- **Question:** What query contract, pagination and recovery behavior apply?
- **Options:** Raw FTS expressions and offsets; source-compatible query planning with opaque generation-bound cursors.
- **Chose:** Plain text, quoted phrases and repo:/path: operators; source phrase/AND/typo/OR ladder, identifier splitting, role-weighted ranking, duplicate-fork collapse, stable sorting, bounded snippets/highlights and explicit truncation. Use deterministic tie-breaks and generation/incarnation/page-key cursors; stale cursor resets UI page one, malformed cursor stays an error. Unknown workspace scope never widens. Distinguish disabled/not-ready/no-service/unsupported-agent and unreadable/missing/unverifiable sources. UI search debounce 250 ms.
- **Why:** These are documented visible semantics. SQL parameterization alone does not quote FTS expressions, and independent SQLite read requests do not share snapshots.
- **Evidence:** ai-vault.md:63-78,185-211,240-254; https://www.sqlite.org/fts5.html#full_text_query_syntax; https://www.sqlite.org/isolation.html.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A source behavior requires an explicit amendment.
- **Source:** locked by docs/roadmap.md

## D7: Resume uses provider configuration and verified sources, never raw shell concatenation
- **Question:** What session actions and agent mapping are required?
- **Options:** Generic --resume command; preserve provider-specific identity/argv and source restrictions.
- **Chose:** Preserve all 25 documented history sources and provider-specific resume identifiers, titles, sidecars, previews and subagents; use the existing agents launch/resume contract and POSIX quoting. Keep copy/open/reveal/log/navigation/drag/keyboard actions and supported local-trash deletion with confirmation. Source missing or unverifiable blocks resume. Native chat actions and native /resume picker are excluded only because interactive structured chat is explicitly dropped; terminal resume and background structured ownership must not be conflated.
- **Why:** IDs/paths/cwd and configured launch options are provider-specific. Safe arguments containing apostrophes or shell metacharacters must remain literal.
- **Evidence:** ai-vault.md:80-95,111-143,232-254; docs/architecture.md:175-178; m1-providers D5,D9,D12; https://www.gnu.org/software/bash/manual/html_node/Quoting.html.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Required resume semantics conflict with a locked provider decision.
- **Source:** locked by docs/architecture.md

## D8: Build on macOS and record other platform work rather than fabricate verification
- **Question:** What shell/path/OS behavior is implemented and verified?
- **Options:** All platforms now; macOS only with portable APIs where cheap.
- **Chose:** macOS POSIX quoting, roots, OS trash/reveal/open and native scenario handoff. Windows/WSL roots, shell quoting and trash semantics, and Linux packaging/lifecycle verification need platform work.
- **Why:** Platform scope is locked; the requirements' Windows paths do not authorize unverified behavior.
- **Evidence:** docs/loop/LOOP.md:48-49; docs/roadmap.md:282-287; m1-providers D13.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Linux/Windows become approved build targets.
- **Source:** deferred: platform

## D9: Choose a lazy Bun Worker; reject inline scans and forked helpers
- **Question:** Which of the three candidate scan/search architectures should be specified?
- **Options:** Lazy worker owning scanner and disposable SQLite databases; inline daemon scanning; Orca-style scanner child process.
- **Chose:** Worker within quirkyd, plugin-owned public API routing and settings; worker-owned SQLite connections and bounded request/results. Explicit worker build entrypoint and graceful close before termination.
- **Why:** Context and three option researchers found Worker matches the locked boundary. Inline synchronous parsing/SQLite blocks the daemon and violates the worker rule; child processes violate the no-helper rule. Local Bun 1.4.0 successfully created FTS5 and matched an inserted capability-probe row.
- **Evidence:** docs/architecture.md:57-59,242,284; https://bun.sh/docs/runtime/workers; https://bun.sh/docs/bundler/executables; https://bun.sh/docs/runtime/sqlite; local `bun -e` FTS5 probe output `[{"body":"vault capability probe"}]`.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Worker lifecycle or packaging cannot meet the actual runtime contract.
- **Source:** locked by docs/architecture.md

## D10: Exclude only explicitly dropped surfaces, not their surviving vault flows
- **Question:** How do native-chat, SSH/WSL and future mobile integrations affect scope?
- **Options:** Recreate dropped subsystems; omit all dependent vault functionality; retain supported flows and name only explicit exclusions.
- **Chose:** No native-chat UI, /resume chat picker, SSH/WSL scanning/hosts or native-chat extras. Preserve terminal resume, previews/logs, handoff integration, session-info navigation, local and all-host behavior, and authenticated API access. Pairing/non-loopback/E2EE infrastructure remains the mobile side track's responsibility, not a second vault implementation.
- **Why:** The brief explicitly drops native chat, SSH/WSL and native-chat extras. The roadmap keeps the whole vault and gives mobile its own later infrastructure slice.
- **Evidence:** BRIEF.md:67-75; docs/architecture.md:175-178; docs/roadmap.md:246-255; ai-vault.md:256-264.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** Feature review requires a vault-local behavior that the dropped boundary does not actually exclude.
- **Source:** locked by BRIEF.md

## D11: Keep current same-token authorization; do not invent desktop-only enablement
- **Question:** Does Orca's desktop-only local-index toggle carry over literally to Quirky's unified API?
- **Options:** Special-case local web UI as unauthorized; authorize the same local API token consistently.
- **Chose:** All authenticated local clients retain user-level access to enable/disable/clear search, with explicit consent and destructive-action confirmation. Remote-host operations keep their own shared transport policy and redact host-local paths.
- **Why:** Quirky explicitly gives agents the user's full access and uses one API for the UI and CLI. There is no desktop-only privilege in PluginCaller; adding one just for the vault contradicts the locked local authorization model.
- **Evidence:** docs/roadmap.md:31-41; docs/architecture.md:61-80,316-324; packages/protocol/src/plugins.ts:195-205; ai-vault.md:54-59,207.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** A future shared remote transport adds a narrower authenticated role.
- **Source:** locked by docs/roadmap.md

## D12: Use public generic extension points for missing surfaces
- **Question:** How should external-history resume, rich settings, Worker packaging, drag targets and absent integrations be connected?
- **Options:** Private cross-plugin imports or shell special-cases; minimal public API growth in existing owners.
- **Chose:** A session-owned resumeExternal method that reuses prepareResume and normal launch lifecycle; generic settings-section/Worker-entrypoint packaging additions only where needed; public terminal action dispatch for explicit drop targets. Expose vault open/filter now; handoff/session-info call their effective public contributions when installed and report unavailable honestly otherwise. Optional host contributions forward through public methods without creating pairing/E2EE infrastructure.
- **Why:** Ordinary missing APIs are implementable this milestone. The existing resume method requires a Quirky record, the shared settings dialog renders scalar declarations only, and the plugin bundler currently omits worker assets.
- **Evidence:** plugins/quirky.session/src/sessions.ts:229-275; plugins/quirky.agents/src/service.ts:285-297; packages/ui/src/components/SettingsDialog.tsx:1-139; apps/desktop/scripts/bundle-plugins.ts:48-72; docs/roadmap.md:29-30.
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** Spec review finds an existing public capability that avoids an extension.
- **Source:** assumed — autonomous

## D13: Preserve MIT provenance and rewrite only runtime-coupled port boundaries
- **Question:** Which Orca code can be reused and under what terms?
- **Options:** Rewrite every format/query from prose; copy the whole runtime; adapt format folds and query closure with retained notice.
- **Chose:** Adapt source-format interpretation/fixtures and SQLite query/ranking/cursor algorithms; replace discovery/runtime ownership, Node SQLite adapters and Orca resume/native-chat/WSL coupling. Retain MIT notice for substantial copied/adapted portions.
- **Why:** All 25 parser routes and query algorithms are present locally; Orca is MIT licensed. Its runtime/cache/scanner service is not a standalone library and the child bridge contradicts the worker boundary.
- **Evidence:** /Users/zpyoung/PycharmProjects/orca/LICENSE; session-scanner-agent-parser.ts, session-scanner-accumulator.ts and ai-vault-search/session-search-engine.ts under that source tree; parser/search survey outputs.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** An adapted dependency introduces incompatible licensing or unavailable runtime assumptions.
- **Source:** assumed — autonomous

## D14: Accept the two confirmed spec findings and calibrate mechanical observations
- **Question:** What changes does the mandatory Codex spec review require before building?
- **Options:** Ignore findings; treat every heuristic observation as a product defect; fix verified contract defects and record the rest accurately.
- **Chose:** Accept F3 (HIGH): define host-qualified public browsing/action identity, redacted remote source variants and partial-host outcomes separately from scanner-local types. Accept F4 (MEDIUM): keep historyDays in nonvisual plugin policy rather than an auto-rendered numeric setting. Correct src/ui.tsx placement and tighten external cwd/group ownership from the live code survey.
- **Why:** Both confirmed findings were independently upheld and re-resolved. The 52 mechanical observations describe planned new files/types, shorthand references, FTS literals, home paths and a Purpose/Overview naming heuristic; they do not demonstrate 52 implementation defects. The logic spec's conceptual-model heading covers purpose. Planned paths must not be created as stubs just to appease reference heuristics.
- **Evidence:** /var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/m3-vault-standard-review-2jldus7z/verified-report.md; unchanged gate.json/manifest.json. Two real Codex high-effort dispatches; reduced same-family independence as mandated by LOOP.md. F1 independently refuted; F2/F5 failed the evidence gate and are not rerolled.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Integration exposes another host-policy or retention-consumer mismatch.
- **Source:** assumed — autonomous

## D15: Preserve external cwd without registering a project; destination owns the resumed tab
- **Question:** How can a history session outside registered projects resume into an explicit tab group?
- **Options:** Register source cwd as a project; fake renderer-only placement; preserve source cwd and use existing destination ownership plus public adoption.
- **Chose:** session.resumeExternal keeps the original existing absolute cwd, while its worktreeId/repo ownership matches the chosen destination (or existing floating ownership). Terminal adopts the actual returned session through its serialized layout owner after validating the group/workspace match. Do not add repo/worktree records merely to resume.
- **Why:** Existing create already separates cwd from worktree identity. SessionRecords has no worktree/repo FK restriction; reconciliation adopts only sessions matching the workspace ID. NewTab currently creates rather than adopts a session, so a public adoption method is needed.
- **Evidence:** plugins/quirky.session/src/sessions.ts:174-275,520-558; src/records.ts:111-124,182-207; plugins/quirky.terminal/src/layout/service.ts:164-218,405-450; src/layout/reconcile.ts:38-51.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Session/layout owner invariants change.
- **Source:** assumed — autonomous

## D16: The baseline verification gate passes with one reported flaky file
- **Question:** Is the clean production baseline ready for implementation?
- **Options:** Treat initial remote failure as final; use the required runner's isolated-rerun policy and report it.
- **Chose:** Baseline accepted at commit 4565011. Build/typecheck exit0; scripts 41 pass/0fail; required remote suite exit0 after its built-in isolated rerun. No manual rerun to confirm the reported failure.
- **Why:** 406 remote files initially had one host.test.ts child-pid timeout; runner's isolated retry passed 32 tests and reported suite-result ok=true, flaky=[packages/pty-host/test/host.test.ts]. All three macOS-only files passed. Production code was unchanged.
- **Evidence:** baseline command output artifact://39; extended in-memory SQLite FTS5/tokenizer/materialized-CTE/scoped BM25/snippet/vocab probe also succeeded.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A later gate still fails after the runner's allowed isolated retry.
- **Source:** assumed — autonomous

## Progress
Step 4 complete: both specifications drafted, self-reviewed and subjected to mandatory Codex standard promote/refute review; confirmed F3/F4 corrected. Baseline build, remote suite, scripts and typecheck pass (D16 records the one suite-reported flaky file). Next commit specs, establish shared JSON contracts, then build with omp task workers in disjoint external worktrees. No production implementation yet.
