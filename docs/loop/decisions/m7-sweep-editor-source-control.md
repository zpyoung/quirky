# m7-sweep-editor-source-control decisions

## D1: Audit all three documents without treating earlier ownership as exclusion
- **Question:** Which flows belong to this parity sweep?
- **Options:** only original M2 slices; every remaining named-doc flow except user exclusions.
- **Chose:** editor.md, sidebar-extras.md and source-control.md, including GitHub and cross-plugin handoffs. Exclude only GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps, Objective runner and PR sitter. Larger flows may become one explicit follow-up as the queue title permits.
- **Why:** prior D4/D7/D35 handoffs explain omissions but do not complete M7 parity.
- **Evidence:** queue item title; docs/roadmap.md:27–38,259–266; m2-source-control-notes-ai D4; m2-source-control-core D7/D35; docs/loop/BLOCKERS.md:27–49.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the user changes exclusions.
- **Source:** locked by queue item m7-sweep-editor-source-control

## D2: Apply unattended night defaults and source-grounded brainstorming
- **Question:** How do design questions/research/spec reviews work here?
- **Options:** human gates/external swarms; autonomous documented defaults.
- **Chose:** no asks; no visual/adhd offers or external research swarms. Three read-only code scouts mapped each doc. Domains Visual/API/CLI/Data/Integration. Material gray areas: interaction, empty/error states, loading, grouping/ownership, response/error contracts, conflict resolution, persistence/idempotency and host identity. Follow existing compact surfaces and public method/CLI conventions; strict invalid inputs fail without mutation, unknown state remains explicit. One combined logic spec with technical final section; self-reviewed against every doc heading.
- **Why:** LOOP night mode; purpose/consumers/success/constraints/scope/primary behavior follow the feature docs and locked architecture. New policy is unnecessary.
- **Evidence:** authoritative LOOP.md; docs/quirk/specs/2026-10-28-m7-sweep-editor-source-control/logic.md; scout reports MapEditorParity/MapSidebarParity/MapSourceParity.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a concrete uncovered observable ambiguity appears.
- **Source:** locked by docs/loop/LOOP.md

## D3: Extend canonical owners with an exact-snapshot note bridge
- **Question:** Which approach closes note/lifetime gaps safely?
- **Options:** duplicate all notes in Git; move editor notes into Git; public aggregation and owning-store settlement.
- **Chose:** public aggregation; Markdown notes stay editor-owned, Git notes stay Git-owned. Add workspace-wide read/exact snapshot settlement so closed-buffer notes survive and appear in Source Control. One mixed send, existing held-note semantics, deletion only after confirmed delivery; changed versions survive. Preserve Markdown rail's excerpt format; shared shelf uses diff-note format plus Source: markdown.
- **Why:** source-control.md:269–294 explicitly shares both note kinds; earlier notes D4 chose separate stores and deferred aggregation. A duplicate table creates synchronization/data-loss risk.
- **Evidence:** editor src/markdown/notes.ts; git src/daemon/notes.ts,targets.ts; git src/notes/useNotes.ts,NotesShelf.tsx; external source-control.md:269–294,489–514.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** exact settlement cannot be provided by the canonical owner.
- **Source:** assumed — autonomous

## D4: Implement real untitled lifetime and preserve editor CAS
- **Question:** How do creation, Save As, cleanup, preview return and shared-draft acknowledgments behave?
- **Options:** rename ordinary files and claim untitled; owned placeholders with guarded retarget; suppress all draft conflicts.
- **Chose:** owned collision-safe placeholder plus untitled/provenance; Save As never overwrites and preserves buffer/tab identity and note paths. Delete only untouched zero-byte non-template placeholders. Preview-to-editor changes that tab role; own acknowledgments are correlated, while real competing CAS failures retain local text and warning.
- **Why:** recorded missing lifetime and UI defects; dirty-save guards must not be weakened to hide a warning.
- **Evidence:** m2-editor D5/D7/D26; BLOCKERS.md:33–36; editor service.ts:235–355,550–655; DocumentSurface.tsx draft/mode handlers.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** actual race/retarget evidence requires a narrower atomicity contract.
- **Source:** assumed — autonomous

## D5: Preserve the native source-path block and macOS boundary
- **Question:** Should this sweep patch native Finder support or infer dropped identity?
- **Options:** guess paths; patch/fork native runtime; preserve binding blocked item.
- **Chose:** preserve m4-editor-drop-open-in-place D1–D6; import policy remains until supported upstream source-path API or explicit native patch approval. No duplicate native follow-up. Only macOS is exercised; Linux/Windows shell/clipboard/trash/key behavior requires later platform verification.
- **Why:** prior executable audit found no supported producer; no change authorizes a native fork.
- **Evidence:** docs/loop/decisions/m4-editor-drop-open-in-place.md; docs/architecture.md:306; docs/roadmap.md:282–287.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** upstream publishes the missing API or approval changes.
- **Source:** deferred: platform

## D6: Use OpenAI implementers and the reachable Gemini reviewer
- **Question:** Which cross-family model pairing is available?
- **Options:** omp-task + Opus; omp-task + Gemini; same-family review.
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini (google/gemini-3.1-pro-preview:high). Maximum three disjoint implementers. Opus and Sonnet probes each found no authed/shipping model; codex/terra/Gemini/flash resolved. No duplicate probes.
- **Why:** LOOP's preferred Opus is unreachable; Gemini is verified cross-family fallback.
- **Evidence:** actual pi-watch --check outputs in iteration5; Bun1.4.0; RUN_BASE7a11959477ec8dce90cdb7388fd1cf7d872d7295.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** dispatch fails; follow the documented fallback ladder.
- **Source:** assumed — autonomous

## D7: Keep unrelated metadata untouched
- **Question:** What should happen to inherited untracked .serena/ preflight state?
- **Options:** stash/delete it; isolate changes by explicit scope and leave it untouched.
- **Chose:** leave user metadata unchanged and uncommitted; workers use distinct component worktrees and absolute file-tool paths. No broad staging/stash operations.
- **Why:** inherited unexpected changes are the user's; no build behavior depends on this metadata.
- **Evidence:** initial git status --short --branch showed only ?? .serena/.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** metadata affects a required check.
- **Source:** assumed — autonomous

## D8: Coordinate Markdown sends in the canonical owner
- **Question:** Can Git-local note holds prevent a simultaneous Markdown-rail send?
- **Options:** rely only on Git-local holds; add editor-owned reserve/release shared with the rail.
- **Chose:** workspaceNotes reserve/release with worktree-bound unique holdId; exact snapshots reserved before delivery; settle with that holder only after confirmed delivery; release in finally. Rail sends use the same map before their first await.
- **Why:** separate local hold maps allow two surfaces to deliver the same note; an owning-store reservation provides the shared fence without private imports.
- **Evidence:** editor markdown/notes.ts:261–308,364–367; git daemon/targets.ts:163–176; ParityMixedNotes proposed contract; committed schema amendment.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** cross-process plugin hosting is introduced.
- **Source:** assumed — autonomous

## D9: Prove missing handlers through an actual isolated daemon
- **Question:** Are the mapped untitled and workspace-note gaps observable at the consumer boundary?
- **Options:** trust source absence; exercise the real daemon before implementation.
- **Chose:** an owned real quirkyd subprocess with private HOME/QUIRKY_HOME, hooks predisabled and a fresh Git worktree. Markdown new returned untitled:false; saveAs and workspaceNotes returned -32009 because their committed schema had no handler. Probe then stopped the daemon (exit0) and removed owned process/home/root state.
- **Why:** a schema without a handler is not implemented behavior. This establishes the missing baseline without touching real user configuration.
- **Evidence:** `/tmp/quirky-l11-parity-before.ts` actual output: MISSING_IMPLEMENTATION_CONFIRMED for both APIs; REAL_DAEMON_NAMED_PLACEHOLDER_BASELINE_CONFIRMED; DAEMON_EXIT0; OWNED_TEMP_STATE_CLEANED.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another source owner publishes an implementation before integration.
- **Source:** assumed — autonomous

## D10: Queue one explicit completion item for larger remaining flows
- **Question:** Which mapped gaps are too large for this landing, and how are they kept actionable?
- **Options:** claim presence from adjacent code; block all useful parity fixes; use the queue item's explicit follow-up allowance.
- **Chose:** one dependent item, `m7-editor-source-control-completion`, added with the authoritative queue tool. It names lossless details/collapsible headings and document-link insertion/completion; edit-tab Changes/Markdown diff preview and hosted preview/permanent/split diff tabs; GitHub fork notices, validated PR-derived push targets and target-specific push-before-PR; permission-aware save/annotation UX; the remaining editor SC-3–22 GUI/setup/media/remount variants and exhaustive sidebar edge audit.
- **Why:** these are concrete implementation/acceptance gaps, not completed flows. The current hosting APIs expose candidates/upstream checks but no validated PR-derived push destination; guessing one risks pushing the wrong repository. Existing Finder-source-path work remains in its separately blocked item, not duplicated here.
- **Evidence:** combined spec coverage table; m2-editor BLOCKERS SC-3–22; m2-sidebar-extras D30; hosting repository/creationEligibility and Git remote owner contracts; `/tmp/quirky-l11-parity-followup.json`; queue add exited0.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the completion item establishes a supported target/capability or finishes a named acceptance variant.
- **Source:** deferred: remaining editor, sidebar and hosted-target flows

## D11: Fix observed integration failures without weakening authority or validation
- **Question:** What caused the required affected gate and typecheck failures?
- **Options:** waive failures; relax schemas/catch owner errors; repair exact contracts and fixtures.
- **Chose:** restore the missing draft-conflict latch and React hook imports; declare every canonical note snapshot field in the strict editor input schema; retain the existing SQLite/BINARY path ordering when aggregating mixed notes; model empty notes and absent optional hosting in generic UI fixtures and wait on enabled publishing rather than implementation wording. Only actual MethodNotFound/unsupported-provider means optional hosting is absent; other errors remain visible/unavailable.
- **Why:** the initial affected gate passed131/138 remote files plus its Mac file; its seven failures identified schema/default-fixture/ordering defects. The corrective gate then exposed an import accidentally removed in the fixture fix. No production deadline, authority check or required assertion was disabled.
- **Evidence:** affected gate artifacts69/82; full typecheck diagnostics14 in DocumentSurface then4 missing React hooks; corrected strict schemas and fixture branches.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the final affected gates expose a further concrete failure.
- **Source:** assumed — autonomous

## D12: Initialize empty rich Markdown as a real document rather than invoking the HTML parser
- **Question:** Why did a newly created blank Markdown show a safe-parse fallback in the real UI?
- **Options:** special-case the eligibility banner; provide the actual empty ProseMirror document to Tiptap.
- **Chose:** headless editor initialization uses an empty doc/paragraph JSON value for empty Markdown; non-empty Markdown keeps its existing parser path.
- **Why:** the diagnostic threw Tiptap's missing-window error from elementFromString/createDoc for empty content. This repairs initialization, not the error message or a fake successful capability.
- **Evidence:** actual UI obs17; pre-fix headless diagnostic stack; post-fix `EMPTY_HEADLESS_MARKDOWN_ROUND_TRIP_PASS`; public lifecycle regression richEligible/canonical empty round-trip. Removed an incidental trailing-newline pin instead of repinning canonical serialization.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an empty or frontmatter-only document fails its real public capability/render path.
- **Source:** assumed — autonomous

## D13: Preserve truthful review and user-flow evidence under the aged-item rule
- **Question:** What remains mandatory after the item reaches LOOP's aged-item landing rule?
- **Options:** begin a new review campaign; finish required gates and land the verified implementation.
- **Chose:** skip the unstarted final cross-family review campaign under the night/aged-item rule selected at claim. Do not claim review clearance. Complete concrete gate fixes, actual process smoke and the changed UI campaign, then catch up once and use queue-controlled landing.
- **Why:** LOOP explicitly prioritizes an aged item's own tests/typecheck and landing over a review or dogfood pass that has not started; the runtime and UI verification required by engineering policy still ran.
- **Evidence:** claim-time night policy D2; local timestamp2026-10-28 04:38:47CDT during final gate; real daemon smoke success; guarded web run20261028T094037-5992.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** queue landing finds a concrete failure; repair it rather than waiving it.
- **Source:** locked by docs/loop/LOOP.md

## D14: Keep cross-owner settlement limits explicit
- **Question:** Can canonical notes in two plugin stores settle in one SQLite transaction?
- **Options:** duplicate the stores or add a distributed transaction protocol; keep public owning-store settlements and report errors truthfully.
- **Chose:** separate exact-snapshot settlements after confirmed delivery, with shared owner reservations and finally-release. A failure after one owner has settled can leave a partial result; no cross-store atomicity or automatic resend is claimed.
- **Why:** each store remains owned by its feature plugin. This preserves the locked public boundary without an unrequested transaction/retry subsystem; failed or unconfirmed delivery before settlement still deletes nothing.
- **Evidence:** git daemon/targets.ts mixed settlement order; editor workspaceNotes transaction; notes component handoff and actual owner-reservation/settlement smoke.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a durable cross-owner transaction requirement is approved.
- **Source:** assumed — autonomous

## D15: Preserve the single catch-up's routing and exact-session contracts
- **Question:** Do the newly landed decision logs conflict with this sweep?
- **Options:** retain the old integration base; preserve the incoming public contracts and verify the merged consumer scope.
- **Chose:** one clean merge after87eff05f. Read every entry in Automations D1–D29, Orchestration UI D1–D15 and Browser profiles/settings D1–D25. Preserve event-time canonical URL routing with MethodNotFound-only fallback, ordinary rich-click editing, exact-session/dispatch navigation without replacement shells, canonical hosted-tab close results, `act`-based headless teardown, atomic fixture replies and the explicit unavailable native-profile operations.
- **Why:** these contracts extend adjacent owners without changing our editor buffer/note identities or authorizing native path guesses. No contradiction with the sweep spec was found.
- **Evidence:** complete incoming-log scout report ParityIncomingBindings; caught-up diffs for MarkdownSurface, terminal workspace controller and headless-window fixture; caught-up actual daemon smoke passed9.62s and full typecheck passed31.48s.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the merged affected or landing gate reports a concrete failure.
- **Source:** locked by docs/loop/decisions/m5-automations-ui.md, docs/loop/decisions/m6-orchestration-ui.md and docs/loop/decisions/sa-browser-profiles-settings.md

## D16: Observe the published and visible primary state in one polling boundary
- **Question:** Why did the caught-up GitHub window regression fail once despite its isolated pass?
- **Options:** weaken the disabled-state assertion; extend a deadline; compare the report and visible control in one observation.
- **Chose:** the existing wait now requires matching label, tooltip, enabled report and visible button state together, then asserts that captured report. Removed the separate live disabled read after the asynchronous report wait.
- **Why:** the old helper could accept an earlier enabled report and then inspect a newer loading control after canonical cache refresh. The consumer requirement is coherent matching state, not two observations separated by a render.
- **Evidence:** caught-up affected suite162remote+1Mac passed with isolated retries for GitHub handoff and Reviews create cancellation; GitHub failure was expected false/received true at the separate disabled read; the same file passed alone. The Reviews cancellation timeout passed its own isolated rerun without changes.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the revised coherent observation fails.
- **Source:** assumed — autonomous

## Progress
Ready for detached queue land. One roadmap catch-up is complete and all incoming decisions are preserved (D15). Post-catch-up affected suite passed162remote+1Mac files with two isolated retries; the own GitHub observation race was then repaired (D16), and its targeted remote file passed without a retry. Post-catch-up actual daemon/CLI smoke and full typecheck passed; full build, scripts68tests572assertions and all five guarded web goals are exercised evidence. All workers, browser and process scopes returned; owned component worktrees/homes were removed. One explicit completion follow-up is queued; native Finder remains independently blocked. Commit this evidence, detach and run the authoritative queue land. No second normal catch-up, new review campaign, repeated green preflight or second work item. Only a concrete landing conflict/failure reopens repair.
