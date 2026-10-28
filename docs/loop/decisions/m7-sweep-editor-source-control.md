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

## Progress
Step4: source mapping complete, combined spec self-reviewed and shared saveAs/workspaceNotes schemas authored. Commit contracts/spec before <=3 implementation components. Parent owns sidebar edge verification and final integration/gates. No current passing implementation claim; original baseline source/test presence is only mapping evidence. Existing native Finder item remains blocked independently.
