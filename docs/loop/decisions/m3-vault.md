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

## D17: Build four disjoint components in one implementation wave
- **Question:** How should implementation be partitioned without shared-file races?
- **Options:** One sequential implementer; independent scanner/search/service/window components with fixed shared contracts.
- **Chose:** Four omp tasks, width cap four, each in an external /tmp worktree forked from 39c5c2b. Scanner owns parser/discovery/fixtures/package; search owns FTS/index/query; service owns daemon/CLI/manifest plus generic public owner/API/packaging growth; window owns vault renderer and terminal window drop. Parent owns shared types/inventory/consent regression, scope audits, integration and checks. No overlapping files, dependency edges or overlap demotions.
- **Why:** JSON/Scanner/Search boundaries are fixed before dispatch. Service public UI/terminal manifest changes and renderer changes are separated by ownership. Separate worktrees avoid cross-task writes while preserving achievable width. The parent applies the higher-priority rule that workers skip checks mid-flight and runs verification at the barrier.
- **Evidence:** /tmp/quirky-vault-l8-journal.md; worktrees /tmp/quirky-vault-l8-{scanner,search,service,window}, all clean at 39c5c2b before dispatch. Scope and acceptance contracts are recorded in that journal and task prompts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An actual contract dependency invalidates independent implementation.
- **Source:** assumed — autonomous

## D18: Keep a failing-before privacy regression on the real API path
- **Question:** What test proves the new feature is missing before implementation and guards the privacy boundary?
- **Options:** Source-text/wiring test; real daemon browse/index lifecycle with private fixture term.
- **Chose:** consent.test.ts uses temporary Quirky/source home, real builtin API, original Claude-shaped records and checks no search DB before explicit opt-in, then actual content matching after consent.
- **Why:** Consumer-visible privacy is the highest-risk invariant. Before implementation, the assertion expecting enabled=false fails with undefined because the method does not exist; the test cleans its harness/home and environment.
- **Evidence:** `bun test plugins/quirky.vault/test/consent.test.ts`: 0 pass, 1 fail, expected false/received undefined at line21; artifact://47. Test committed at39c5c2b before production implementation.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The real public policy contract changes.
- **Source:** assumed — autonomous

## D19: Lock generic Worker/settings and evidence interfaces before integrating consumers
- **Question:** What exact interfaces bridge the independent runtime and renderer components?
- **Options:** Plugin-specific shell branches and source-path guesses; generic declared Worker entries/settings mounts and one safe evidence encoding.
- **Chose:** Manifest workers maps names to relative entries, bundler rewrites .js paths, and public workerEntrypoint resolves declared entries only. Generic settings-section uses standard MountFunction and UiModel.settingsSections. Evidence reserves raw bracket marks for FTS highlights; literal brackets and U+E002 use injective 0/1/2 escapes decoded once only in text runs.
- **Why:** These interfaces preserve public-only plugins, packaged operation and unspoofable text highlighting without shell special cases or HTML injection.
- **Evidence:** tech.md Worker/public-growth/evidence contracts; explicit service/search interface messages routed to window implementers.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Packaged smoke or producer/consumer tests reject the contract.
- **Source:** assumed — autonomous

## D20: Use one canonical public result envelope and remove renderer guessing
- **Question:** Should independently written UI code accept several possible service response shapes?
- **Options:** Wrapper/raw compatibility fallbacks; exact declared schemas and migrated consumers.
- **Chose:** Direct HostedSession/null, HostedSession[], ViewState and Session results; firstPrompt uses prompt wrapper; searchStatus/enable use status+hosts wrapper; clear uses cleared/status/hosts; openSource uses ok; deletion uses deleted/trashed-count/alreadyMissing/reason. setView takes a flat partial ViewState. Parent privacy regression and window consumers migrate to these canonical shapes.
- **Why:** There is no installed legacy vault contract to preserve. Guessing hides interface errors; one schema makes real CLI/API/window behavior verifiable.
- **Evidence:** tech.md canonical public result contract; service implementation interface report and completed UI call-site inspection.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A confirmed public consumer requires a documented contract amendment.
- **Source:** assumed — autonomous

## D21: Prepare external resume records from public effective configuration without trust side effects
- **Question:** How does external history use configured launch flags and managed Codex homes without changing existing record-backed resume semantics?
- **Options:** Pass null record; call prepareLaunch merely to copy; get effective public agent fields and pass a real LaunchRecord.
- **Chose:** Use quirky.agents/get command/args/env, overlay source CODEX_HOME where present, and feed existing prepareResume/session-owned launch. Do not change null-record planner behavior and do not invoke trustFolder for a copy/prepare action.
- **Why:** buildResumePlan deliberately maps null record to catalog defaults/no custom args, while prepareLaunch calls trustFolder. Both would violate the external history configuration/pure-copy contract in different ways.
- **Evidence:** plugins/quirky.agents/src/core/plan.ts:433-447; src/service.ts:265-282,469-490; src/core/types.ts:110-142.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Provider owner adds an explicit side-effect-free external-history planner.
- **Source:** locked by docs/loop/decisions/m1-providers.md

## D22: Repair module seams and invalid fixture oracles without narrowing parser/search contracts
- **Question:** How are failed component acceptance checks handled before integration?
- **Options:** Suppress errors or repin outputs; diagnose actual module bindings, source behavior and persisted state.
- **Chose:** Fixed scanner helper bindings/internal typing and corrected source-aligned Cursor fixture/oracles. Scanner passes9 tests/251 assertions. Search engine bindings and fixture timestamps are corrected; replacement publication now preserves the candidate file's last_seen_scan so the same sweep cannot erase newly indexed content. Fork fixtures share all eight hashed messages rather than incorrectly expecting a shared two-message prefix to collapse differing third messages. Search passes10 tests/96 assertions; both component typechecks passed.
- **Why:** These checks exposed actual binding/transaction defects and invalid fixture assumptions. No production behavior was weakened to satisfy an invalid title, path-body or fork oracle.
- **Evidence:** scanner artifacts56/58/60/63 and final9pass0fail251assertion output; search artifacts68/69/72 and final10pass0fail96assertion output; replacement diagnostic observed the emptied index before the file-row preservation fix.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Integrated CLI/API scenarios expose another actual source-format mismatch.
- **Source:** assumed — autonomous

## D23: Assemble audited components before accepting cross-component behavior
- **Question:** How can the service and renderer acceptance run when their isolated trees deliberately lack the independently implemented scanner/search and public UI extensions?
- **Options:** Fake dependencies or claim isolated tests pass; assemble the audited code with explicit unverified checkpoints and accept only after real integration checks.
- **Chose:** After every worker returned, verify all five HEADs remain39c5c2b and audit all actual changed paths. Commit scanner/search with observed component acceptance, and checkpoint service/window without claiming acceptance. Merge the disjoint checkpoints into build/m3-vault, install the new workspace package, then run real integrated API/CLI/window/owner checks before any completion claim or landing. The desktop worker-bundle test is explicitly owned by the service slice as bundle-plugins-workers.test.ts; no other component touches it.
- **Why:** Service/window runtime verification genuinely depends on the other components. Mocking those dependencies would prove less than assembling the real feature. Checkpoint commits preserve every returned result; they are not claims that an item is complete. No unverified code can land through the final gate.
- **Evidence:** authoritative barrier status artifact89 and five matching full HEAD outputs; per-component scopes in /tmp/quirky-vault-l8-journal.md. Temporary dependency symlinks and generated Serena configs were removed rather than committed. Parent-only diff is limited to this log, tech contract refinements, native handoff and the canonical privacy-test envelope.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The assembled tree reveals a contract conflict requiring re-plan rather than an implementation fix.
- **Source:** assumed — autonomous

## D24: Keep the locked flat schema dialect and document nullable response fields honestly
- **Question:** Can concrete vault schemas use references, unions, boolean enums or typed-map additionalProperties?
- **Options:** Silently extend the dialect; retain opaque models; describe concrete fields within the existing subset.
- **Chose:** Populate concrete model properties and flat kind discriminants, add required yes parameters, and use the established description form only where nullable/owner-defined values exceed the dialect. No union/reference/type-map extension in this item.
- **Why:** m0-scripting D4 deliberately fixes the supported keywords, and D6 leaves response validation unchecked. The vault can document its nullable fields and extensible owner results without changing that locked public language.
- **Evidence:** docs/loop/decisions/m0-scripting.md D4-D6; schema-completion task inspected the shared validator and CLI consumers. Nullable values and per-kind required-field limitations are explicit rather than fabricated supported keywords.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A future approved feature requires a union that descriptions cannot document adequately.
- **Source:** locked by docs/loop/decisions/m0-scripting.md

## D25: Add four history resume capabilities in the existing provider owner
- **Question:** How should history sources resume when the launch catalog has no template?
- **Options:** Skip those sources; construct a second vault launcher; extend the canonical agent entries from the vault's source forms.
- **Chose:** After strict real-client reproduction, add only the missing Hermes --resume, Rovo --restore, OpenClaw --resume and Cline --id templates in quirky.agents. Existing templates, launch behavior, planner quoting and recorded-launch replay remain unchanged. Do not weaken the 25-source test.
- **Why:** m1-providers D9 ported launch-catalog values, but the vault source separately defines these additional history resume forms. M3 now needs those capabilities; central owner data keeps one planner rather than hiding a separate vault command builder.
- **Evidence:** ai-vault.md:232-234; strict public prepare/copy-execution regression artifact133 reports all four nonresumable entries and failures. This is a bounded catalog completion, not a change to stack/trust or an existing successful template.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Supported installed CLI versions require a different evidenced history resume form.
- **Source:** supersedes m1-providers D9

## D26: Recover Gemini roots only from genuine project metadata
- **Question:** How can Gemini history obtain an original cwd without inventing it from a hash or the current process?
- **Options:** Guess current cwd; declare all Gemini history unresumable; join genuine project markers/registry and retain unknown when absent.
- **Chose:** Read project-directory .project_root and Gemini's nested projects.json projects map, associate them with tmp/project/chats sources and freshness, and preserve unknown cwd when no valid mapping exists. Shared registry/marker files are metadata dependencies, never deletion targets.
- **Why:** Official Gemini source writes the root marker and registry. A project hash is not invertible. Original Orca and the initial port omit this join; strict source-resume acceptance exposes the gap.
- **Evidence:** https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/projectRegistry.ts ; https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/storage.ts ; chatRecordingTypes.ts and chatRecordingService.ts in that repository. Failing-before daemon metadata tests are artifact132; the strict 25-source failure is artifact133.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Gemini changes its documented project metadata format.
- **Source:** assumed — autonomous

## D27: Avoid Bun's observed asymmetric-matcher mutation when reusing API payloads
- **Question:** Why did a negative Gemini action test send a non-string ID immediately after asserting it was a string?
- **Options:** Change the API to accept objects; suppress validation; fix the test's received-object mutation.
- **Chose:** Use scalar assertions and fresh primitive projections for reusable RPC records; remove incidental exact error wording. Preserve the actual missing-cwd refusal and positive metadata regressions.
- **Why:** A standalone Bun1.4 probe showed toMatchObject with expect.any(String) replaces the received string with a matcher object. The production API correctly rejects that object. Changing app validation would hide a test-framework corruption.
- **Evidence:** observed probe output idType=object and row.id={}; the Gemini helper was migrated before rerunning the genuine red phase. This does not weaken metadata expectations.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Bun fixes asymmetric received-object mutation and project test conventions change.
- **Source:** assumed — autonomous

## D28: Stop and serially integrate the overlapping discovery correction before commit
- **Question:** How should an out-of-scope discovery edit from the SQLite fix be combined with the Gemini discovery owner?
- **Options:** Commit both and trust an automatic merge; discard the needed correction; transfer it to the single file owner before checkpointing.
- **Chose:** Halted the overlapping commit, copied the two typed-SQLite discovery hunks into the Gemini-owned file with anchored edits, and restored the SQLite tree's discovery file exactly to baseline (snapshot E764). Other scopes stay disjoint. All eight HEADs remain4736bdc at the repair barrier; generated tool configs are removed.
- **Why:** Correctness does not excuse two independently edited versions of a shared file. One serial integration owner produces the combined version that the assembled gates will test.
- **Evidence:** actual changed-path audit showed discovery.ts in both trees; the isolated diff had two hunks. Anchored integration transferred them and restored the baseline hash before any component commit.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Another changed path crosses a declared ownership boundary.
- **Source:** assumed — autonomous

## D29: Keep logical SQLite identity separate from its physical public source path
- **Question:** Why do present OpenCode-family sessions fail resume and raw-source actions?
- **Options:** Treat synthetic strings as files; bypass all source checks; materialize the physical backing path while preserving logical IDs and index keys.
- **Chose:** Match original Orca: candidate/index identity stays dbPath#sessionId, public session.filePath is the physical backing DB, and fresh scanner validation checks that DB/current row/root/kind. Normalize cache hits and rebuild disposable stale search schema. Classify SQLite candidates by metadata, never an arbitrary # in a normal filename.
- **Why:** The strict consumer test proved three valid source families were rejected by a format-blind lstat. A physical path invariant fixes the producer contract instead of suppressing the action error or inventing a second launcher.
- **Evidence:** artifact133; original session-scanner-opencode-sqlite.ts:265-273; Quirky scanner get/validateCurrentFile; actual source action research in VaultSyntheticSemantics.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A provider uses a source that cannot be represented by a physical backing resource and logical identity.
- **Source:** assumed — autonomous

## D30: Test genuine macOS Trash only on an owned disposable volume
- **Question:** How can an actual OS-trash test avoid changing or littering the user's real Trash?
- **Options:** Fake acknowledgement; move a generic fixture into user Trash without cleanup; use an owned temporary APFS image and validate its Trash destination.
- **Chose:** Disposable APFS sparse-image fixture, noninteractive/nobrowse mount, source and Quirky home on that volume, Foundation destination safety check, finite owned commands and guaranteed rig/unmount/image cleanup. Non-macOS reports a real skip, not a passing no-op.
- **Why:** The feature needs actual filesystem effect, but tests must never modify unrelated real state. This also provides a safe failing-before case for currently rejected directory-backed session targets.
- **Evidence:** test/support/trash-volume.ts and actions.test.ts prepared in the isolated scanner tree. Actual macOS execution remains pending; no pass is claimed from tool availability alone.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** This host cannot safely create or detach the disposable volume.
- **Source:** locked by docs/loop/LOOP.md

## D31: Verify every copied resume command through an owned executable
- **Question:** How can 25 history sources be verified without starting installed agents or using their credentials?
- **Options:** Mock planner returns; run real credentialed CLIs; configure an owned collector and execute actual public API-prepared commands.
- **Chose:** Real scanner and daemon APIs, optional fixture cwdRoot under an owned home, restricted PATH/HOME/QUIRKY_HOME, finite collector processes recording actual argv/cwd/env, original-source/trust snapshots and an injection sentinel. Source paths also contain spaces, #, apostrophes and dollar text.
- **Why:** This exercises the consumer's copied command and provider identity rather than a forwarding echo. It found the missing templates, Gemini root gap and synthetic source error before any feature acceptance claim.
- **Evidence:** test/resume.test.ts; actual red output artifact133, after correcting the fixture's missing Cursor transcript binding. Existing owner tests plus a later real PTY smoke cover session launch separately.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A provider's copied command has a documented execution contract the collector cannot represent.
- **Source:** locked by docs/quirk/specs/2026-10-27-m3-vault/logic.md

## D32: Bound new indexing starts without starving an in-flight one-shot read
- **Question:** How can a valid source that parses for longer than the pass budget ever become searchable?
- **Options:** Restart and abort forever; add resumable state to every parser; finish the current bounded-memory read and apply the budget before starting another.
- **Chose:** The last option. Keep the 20-second cadence, owed-work bookkeeping, bounded buffers/transactions, explicit shutdown/cancellation abort and independent five-second fresh-search deadline. One already-started read may overrun the pass target; no new reader-state framework is introduced.
- **Why:** A real SQLite/timer probe with a valid abort-aware six-second reader observed four starts, zero completions and four budget aborts, leaving the file due and unsearchable. The current one-shot boundary cannot preserve partial parser state, so killing it at every target deadline is a liveness defect, not a useful bound.
- **Evidence:** VaultIndexProgressProbe output and search/index.ts pass/controller/publication paths. The probe models a slow valid reader; it is not a huge-file memory benchmark. The sibling tech spec now states the start-budget policy; a controlled gate regression also verifies freshness and explicit cancellation.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** An approved strict read-time share requires checkpointable parser state rather than a start budget.
- **Source:** assumed — autonomous

## D33: Preserve expected deletion target kinds across the Worker boundary
- **Question:** How should validated directory-backed sessions and Claude companion directories reach OS Trash without weakening kind checks?
- **Options:** Allow any directory by agent name; discard the directory flow; return each validated path with its expected file/directory kind.
- **Chose:** Internal DeleteTarget objects carrying path and kind, migrated through scanner, Worker result and action consumer with no string-array compatibility path. Keep final lstat/symlink/exact-kind checks and existing root validation.
- **Why:** The real private-APFS test proved Claude file trash and repeat deletion work, then failed on Grok because the action assumes every target is a file. Agent-wide allowance cannot distinguish a valid companion directory from a file path swapped to a directory.
- **Evidence:** artifact157:4 pass/1 fail, Grok result deleted=false/trashed=0 with non-file rejection. The disposable volume initialized, probed Foundation, moved Claude and cleaned up. Optional missing Claude companions also exposed and corrected first-delete alreadyMissing semantics.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A supported source needs a different explicit filesystem target kind.
- **Source:** assumed — autonomous

## D34: Land the core slice and queue explicit parity completion
- **Question:** Does the original full-flow acceptance remain this item's landing requirement after the operator's deadline ruling?
- **Options:** Keep expanding every advanced flow; land unverified parity silently; land the working core and name every unfinished flow in a dependent queue item and BLOCKERS.md.
- **Chose:** The operator's third option. Core is public browse/resume, explicit consent, real transcript search and disable/clear without source loss. Fix blocking findings only. Preserve the original scenario catalog as the follow-up contract rather than claim all 24 scenarios passed.
- **Why:** The user explicitly authorized this narrower landing, required the follow-up before land, selected scripts/typecheck/affected-package gates, and reserved the whole suite for queue.ts land.
- **Evidence:** Operator note in this iteration; scope.test.ts's two unfinished positive fixtures at commit75445e6; the remaining three unknown-scope boundary tests stay active. The positive cases are removed from this landing, not marked passing or skipped.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The dependent parity item finds a core flow cannot meet its documented contract.
- **Source:** locked by the operator note in this conversation

## D35: A command drag carries a window-local single-use capability
- **Question:** May arbitrary external MIME data name a registered UI command?
- **Options:** Parse raw command JSON; trust the MIME name; mint and consume an opaque capability in the trusted UI host.
- **Chose:** One active window-local capability, immutable argument snapshot, issuer cancellation, consume-before-await, owner revocation and no legacy raw-JSON path. Target worktree/group remain validated by the terminal owner.
- **Why:** The mounted-window negative probe actually opened a registered menu from forged external JSON before this fix. The positive drop, replay/target checks and host capability tests now pass.
- **Evidence:** artifact165 failing-before; artifact197:132 pass,0 fail across host and positive/negative mounted-window drop files.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A future cross-window drag needs an authenticated transfer protocol.
- **Source:** assumed — autonomous

## D36: Tool results cannot also enter uncapped conversation text
- **Question:** Why was a unique term beyond the disclosed 3,072-character tool limit searchable?
- **Options:** Weaken the cap test; cap conversation text; exclude structured tool blocks from conversation extraction and retain their separate capped tool rows.
- **Chose:** Reuse the existing text-block extractor for Claude/Qoder conversation text and CodeBuddy; only text/input_text/output_text blocks enter user/assistant rows. Tool-use/results still use the existing tool extraction path.
- **Why:** The generic content extractor copied tool_result.content into a user row, bypassing both the role filter and tool cap. Long actual user messages must remain searchable, so truncating user text would hide the producer defect.
- **Evidence:** artifact198 failing unique beyond-cap term; artifact205: all8 public flow tests pass after the extraction fix, with long user text, tool-only role filtering and cap assertions intact. Typecheck exits0 after migrating the remaining UI context fixtures.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Another provider's mixed-content format contains structured tool blocks in its conversation extractor.
- **Source:** assumed — autonomous

## D37: Preserve semantic assertions instead of stale warning and catalog copies
- **Question:** Which affected-suite failures represent behavior changes versus copied implementation details?
- **Options:** Re-pin new warning strings/counts; suppress failing files; retain behavior assertions while deleting incidental wording/catalog copies and correcting physical fixtures.
- **Chose:** Warning identity/presence and working settings remain asserted; copied resume-array/count checks are deleted while actual per-provider argv executions remain. The unavailable-root test physically moves its owned source root. Large list/paging integration cases use a finite30-second deadline.
- **Why:** The affected run failed on old warning prose, a copied25-agent catalog count after four supported resume additions, a fake unavailable root whose source was still readable, and implicit5-second deadlines under load. None justifies changing production semantics or adding retries.
- **Evidence:** artifact199; isolated corrected eight files:180 pass,0 fail,1297 assertions (artifact307). Absent DataTransfer was a separate real event-boundary defect, fixed without a raw command fallback; three drop/tab files then passed27 tests (artifact305).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A corrected assertion no longer detects its consumer-visible boundary.
- **Source:** assumed — autonomous

## D38: Serialize new calls behind idle retirement rather than replay or strand them
- **Question:** How should a browse request arriving while an idle Worker closes be handled?
- **Options:** Keep posting to the closing Worker; reject all concurrent calls; wait before posting and start the next Worker once retirement finishes.
- **Chose:** The last option, with bounded graceful close, shutdown handling and stale-generation isolation. Already-issued operations are never automatically replayed.
- **Why:** Final spec review S1 found the race; the parent reproduced a concurrent operation remaining unsettled after the old Worker acknowledged close. Failing a valid caller merely because an internal idle timer fired avoids the hang but does not fix the lifecycle boundary.
- **Evidence:** final review S/gate.json under the recorded m3-vault-final-g3ziied1 scratch directory; owned actual-Bun-Worker probe /tmp/m3-vault-retirement-red.ts printed outcomeSTRANDED after one second and cleaned up. Fix/regression verification is pending and will be recorded before land.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Queued calls are posted twice, shutdown leaves them pending, or a retired Worker affects its successor.
- **Source:** assumed — autonomous

## D39: Use an explicit owned executable, not PATH, for packaged resume proof
- **Question:** Why did the first smoke reach a Claude Code trust screen instead of the fake collector?
- **Options:** Confirm the trust screen; assume the PATH shim ran; stop, preserve the limitation, and configure an absolute owned command in a fresh isolated profile.
- **Chose:** Stop without confirming trust. The repeat smoke must set owned HOME/XDG_CONFIG_HOME/QUIRKY_HOME/source roots and configure the absolute fake command through the public agents API before starting UI actions.
- **Why:** The login-shell path did not establish fake-provider selection: the collector log was absent and the screenshot visibly showed Claude Code's trust screen. No credential entry, trust confirmation or file side effect was observed; that is not proof none occurred, nor proof the collector ran.
- **Evidence:** built-web report20261027T194621-0706, obs31/35; agent correction of its earlier overstrong no-real-CLI claim. The first run's daemon/browser/temp root were cleaned up. Public agents configure command/args/env is declared in plugins/quirky.agents/cli.ts:227-235.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An explicitly configured absolute executable is not the actual resumed process.
- **Source:** locked by docs/loop/LOOP.md isolated-state rule

## D40: Clear the local index through its declared local-only API
- **Question:** Should the UI's rejected host parameter be added to the clearing API?
- **Options:** Broaden the API to remote clearing; ignore unknown parameters; remove the unsupported selector from the local UI caller.
- **Chose:** Remove host from the confirmed clear call. Keep local policy-disable ordering, derived-file deletion and the existing strict schema.
- **Why:** The first packaged user run reproduced params.host-is-not-allowed twice. Clearing is explicitly local-only; adding a remote contract would expand scope and obscure which computer's private copy is removed.
- **Evidence:** SearchSettings.tsx:191; component0ee1d08; three mounted-window tests pass13 assertions (artifact339). Focused built-web run20261027T201423-c17a passes clear and shows the success toast, disabled search and zero counts in obs8.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An approved feature requires remote derived-index deletion.
- **Source:** locked by the existing public clearSearchIndex declaration

## D41: Record the one final review round without overstating security assurance
- **Question:** How do the final lenses affect this operator-authorized core landing?
- **Options:** Run additional discovery rounds; treat every PASS as a clean bill; adjudicate the one round, fix blockers once and retain nonblocking obligations explicitly.
- **Chose:** C passes with no findings; S1 is accepted HIGH, reproduced and fixed by the retirement barrier; X1 is rejected under the locked shared-authenticated-API model; X2 is retained as a LOW unfinished consent-tip flow rather than accept its requirement-based refutation. No second final round.
- **Why:** LOOP.md specifies one final round/fix batch, and the operator requires only blocking fixes. The security round suppressed2/2 candidates, which limits assurance; hiding that would misrepresent the review.
- **Evidence:** shared review directory /var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/m3-vault-final-g3ziied1, C/gate.final.json, S/gate.json and X/gate.json. Reviewer google/gemini-3.1-pro-preview:high, full cross-family independence. All lenses have zero contested/unreviewed paths; bun.lock15 lines excluded. S1 actual-Bun regression/lifecycle/public-flow check passes13 tests143 assertions and typecheck (artifact383).
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** Completion-item or native-run evidence contradicts a dismissal or exposes another core failure.
- **Source:** locked by docs/loop/LOOP.md and the operator note

## D42: Packaged core UI and owned provider execution have direct evidence
- **Question:** Which visible flows can this landing actually claim?
- **Options:** Treat source tests as UI proof; count the initial failed clear/blocked resume as success; require the corrected built surface and actual owned process.
- **Chose:** Keep both reports. First run proves browse/title-only/consent/transcript-only search and disable, and exposes clear's real schema mismatch. Focused corrected run proves clear plus actual absolute-command fake-provider resume. Advanced flows remain explicitly queued, not inferred passing.
- **Why:** A fake daemon result or copied command alone cannot prove a built Worker, visible consent action or real terminal process.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261027T194621-0706/report.md and runs/20261027T201423-c17a/report.md. Focused obs8 shows clear; obs13 shows OWNED_FAKE_CLAUDE_PTY_OK and exit0. Retained fake-provider.log proves absolute executable, canonical original cwd and --resume claude-fixture-session. Both runs cleaned owned daemon/browser/temp roots. Packaged Worker src/worker.js and full MIT NOTICE were observed; no separate LICENSE is claimed. Configure uses an unreserved OWNED_FAKE_CLAUDE_LOG key, preserving QUIRKY_* guards.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The final packaged build differs on a core surface from the verified components.
- **Source:** locked by docs/loop/LOOP.md verification requirements

## D43: Final affected verification runs on the operator's16-core host
- **Question:** How should verification proceed after the old host timed out and the operator prohibited a local multi-package run?
- **Options:** Continue the local override; weaken/skip failed gates; cancel local work and use the configured test host.
- **Chose:** Cancel the local multi-package job immediately. Direct plain bun test is single-file only. Use bun scripts/suite.ts with the ten affected directories and the updated shared host configuration; do not change protected runner code or duplicate the whole suite manually.
- **Why:** The operator reported Mac load80 and supplied the remote-only priority. The old remote run had no final verdict, so it was never counted passing. A local ownership check found no remaining cancelled multi-package Bun process at lane8.
- **Evidence:** Final run on quirkyci@34.122.38.64, jobs8/slots16:323 remote files pass,2 macOS-only files pass,0 failures,flaky[] (250.52s). Final build exits0; scripts49 pass285 assertions and typecheck exits0 (artifact390). The old run1793132772472-82913 matched both exact source fingerprints; its worker/guardians were disposed and its owned directory removed, without touching another lane's queue owner. Actual assembled retirement smoke returns completed/value1 after the earlier stranded reproduction.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The land-owned whole-suite gate reports a blocking integration failure.
- **Source:** locked by the latest operator test-host instruction

## D44: Preserve external resume and landed session naming after the first land conflict
- **Question:** How should the land-reported conflict with m1-agent-status-scripting be resolved?
- **Options:** Keep only vault's resumeExternal; keep only the landed setName; retain both independent methods and registrations.
- **Chose:** Both. Resolve the shared insertion point with separate complete method bodies/comments, and expose both in main.ts. Preserve upstream name/unread fields and migrations6/7 unchanged.
- **Why:** These are additive public operations, not competing implementations. Dropping either would remove a verified flow. This catch-up is the mandatory LOOP7.3 response to the failed first land, not an additional optional pre-land merge.
- **Evidence:** Newly landed m1-agent-status-scripting log read completely, D1-D47; D20-D22/D38 bind naming and migrations. Post-resolution typecheck and packaged build exit0. Remote session/vault/terminal/agent-status verification passes142 remote files and2 macOS-only files; terminal features-search passes its isolated retry and is recorded as the one flaky file, not hidden or changed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Land's integration gate identifies another actual contract conflict.
- **Source:** locked by docs/loop/LOOP.md step7.3 and m1-agent-status-scripting decisions

## D45: Parse real module syntax rather than regex-match embedded native text
- **Question:** Does ObjC.import('Foundation') in the native Trash script violate the public plugin import fence?
- **Options:** Declare a fake JavaScript dependency; special-case Foundation or member names; parse actual TypeScript module references.
- **Chose:** Use the existing TypeScript compiler dependency to visit import/export declarations, import-equals, type imports and direct require/dynamic-import calls. Remove regex/comment stripping. Ignore strings, regex literals and ordinary member calls while still inspecting executable template interpolations.
- **Why:** The land-owned whole suite reproduced an import-fence false positive on the JXA template at actions.ts:9. This is Objective-C bridge loading, not a Swift or JavaScript package import. A package allowlist or renamed native expression would hide the scanner defect.
- **Evidence:** Whole gate464remote files initially462pass/2fail; PTY host passes32/32 isolated, import fence fails again. New single-file regressions reproduce non-module false positives before the fix (artifact419). After the AST fix, all4 fence cases pass, including real private type-only/require/export/interpolation references, and typecheck exits0. No runtime/native deletion code or dependency declaration changed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A supported module syntax bypasses the fence or valid non-module text is flagged.
- **Source:** locked by the public-only plugin boundary and the operator's blocking-findings-only instruction

## Progress
Core implementation, packaged smoke, review/fix batch and affected gates are complete; both completion items are queued. The additive session conflict is resolved and144 integration files pass under runner policy. Land's whole gate found the import-fence false positive; D45 fixes it with4 passing regressions/typecheck. Runtime code is unchanged by that repair. Whole-suite success and done status remain owned by queue.ts land; no manual whole-suite run is claimed.
