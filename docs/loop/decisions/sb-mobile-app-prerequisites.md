# sb-mobile-app-prerequisites decisions

## D1: Handle only the claimed prerequisite follow-up
- **Question:** Which work and workflow does this iteration own?
- **Options:** Resume the previously blocked preview item; claim another item; handle the canonical lane 7 claim only.
- **Chose:** Handle only sb-mobile-app-prerequisites on build/sb-mobile-app-prerequisites. Canonical queue deps reports ready with no pending dependencies. Use the current integration queue.ts from this worktree. No human questions, research swarms, review rounds or unrelated source changes.
- **Why:** The preceding iteration already blocked sa-browser-pane-workspace-preview. Its blocker does not authorize resuming it. LOOP.md requires one item and autonomous source-grounded decisions.
- **Evidence:** Canonical queue.ts wait --lane 7 returned this item; queue.ts deps sb-mobile-app-prerequisites returned {ready:true,pending:[]}; git show build/roadmap:docs/loop/LOOP.md, Each iteration and Build first sections.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The queue explicitly reassigns the item or the controlling loop policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D2: Preserve every deferred category and its explicit condition
- **Question:** What is the consumer, purpose, primary behavior, success criterion and scope of this follow-up?
- **Options:** Rebuild the working companion; implement only one convenient control; assess and retain all prerequisite-dependent flows.
- **Chose:** The paired phone is the consumer. The requested behavior is real interactive native chat with attachments, queued messages, options and background tasks; voice dictation/models/settings; reversible workspace Sleep/Hide sleeping; genuine automation/other-client origin filters; and Browser/Markdown session tabs. Each category must satisfy the prerequisites named in the claimed title and parent D5/D8/D21/D24. Keep the shipped terminal/ask companion unchanged. Separately owned panels, push, signed distribution and source-control/files/tasks/accounts/history are not new work here.
- **Why:** This is the single grouped unbuilt-flow follow-up registered by sb-mobile-app, not a new approval of dropped products or a request to relabel unavailable controls as successful implementations.
- **Evidence:** Canonical claimed item title; docs/loop/decisions/sb-mobile-app.md:47-56,80-89,223-232,256-265; docs/quirk/specs/2026-10-28-sb-mobile-app/logic.md:6-18,67-68; external mobile.md flows 6,7,9.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** An authorized ruling changes the requested conditions or a real prerequisite lands.
- **Source:** locked by docs/loop/decisions/sb-mobile-app.md

## D3: A follow-up title cannot override the locked native-chat and dictation exclusions
- **Question:** May the unattended lane authorize the requested interactive structured chat and speech products?
- **Options:** Treat general parity or the follow-up as an override; expose background structured jobs as interactive chat; require the explicit ruling named by the follow-up.
- **Chose:** Require an authorized architecture/roadmap ruling and real public APIs before implementing native interactive chat or dictation/model/settings. Do not widen mobile authority to create structured interactive sessions, fake a transcript with asks, add inert settings, or repurpose terminal command injection as native chat.
- **Why:** Architecture Decisions limits structured sessions to background agents; its structured-session section explicitly retains interactive Claude/Codex in terminals because native chat was dropped. Roadmap explicitly says dictation was dropped. LOOP.md locks those decisions and requires blocking a design that needs them changed.
- **Evidence:** docs/architecture.md:164-178,290-305; docs/roadmap.md:175-181; docs/loop/decisions/sb-mobile-app.md D5/D24; literal policy plugins/quirky.mobile/src/daemon/authorization.ts:8-52,223-230.
- **Reversibility:** hard (only an authorized scope ruling can change the product boundary)
- **Confidence:** high
- **Revisit if:** The authorized architecture/roadmap ruling explicitly permits interactive native chat and voice, with a corresponding owned API contract.
- **Source:** locked by docs/architecture.md

## D4: Resolve safety and interaction gray areas without inventing provenance or destructive substitutes
- **Question:** What defaults apply to API authorization/errors, visual interactions, data mapping/persistence and cross-client lifecycle?
- **Options:** Guess identities/statuses and broaden generic authority; preserve precise public boundaries; silently hide deferred categories.
- **Chose:** Preserve exact connection-scoped terminal driving, literal phone method and route grants, credential-free producer projections, explicit unavailable descriptions and authoritative errors. Do not infer automation from createdBy=api, infer other-client ownership from a caller label, map Sleep to close/kill/delete/status, alias Browser/Markdown tabs to terminal session IDs, or use agent Chrome as an unapproved human renderer. Keep historical unknown origin unknown. Missing adapters alone are implementable work, not proof of an outside blocker; evaluate upstream ownership and actual capability separately.
- **Why:** The parent decisions require real provenance, reversible history/resume and safe phone data/renderers/public identity. Grant checks and a label are not implementations of those features. They must not damage the independently working companion.
- **Evidence:** docs/loop/decisions/sb-mobile-app.md D8,D10,D11,D13,D18,D21,D24; docs/architecture.md:302-305; external mobile.md flows 6,7,9.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** New producer-owned contracts establish real identities, lifecycle and safe rendering.
- **Source:** assumed — autonomous

## D5: Build the permitted prerequisites rather than block on missing adapters
- **Question:** Does the absent chat/voice ruling make every category impossible?
- **Options:** Block the grouped item immediately; invent chat authorization; implement the independent permitted producer lifecycles and phone consumers.
- **Chose:** Implement reversible Sleep, trustworthy origins and safe nonterminal phone tabs in three disjoint components, retaining only genuinely locked/outside-limited flows in one follow-up before land. Commit shared public DTOs and the one combined spec before dispatch. OpenAI omp task implementers; review dispatch is disabled by the controlling build-first policy, so no reviewer availability or review pass is claimed.
- **Why:** The read-only scout found existing PTY restore/history, worktree persistence, editor buffers/UI tab identities and Browser public APIs. Missing public operations can be built in this milestone under roadmap19-53; only native chat/voice has a confirmed scope prohibition. Browser streaming must satisfy the existing Native-human/Chrome-agent boundary.
- **Evidence:** MobilePrerequisites completed report; packages/protocol/src/pty.ts; plugins/quirky.session/src/sessions.ts; plugins/quirky.worktree/src/daemon/store.ts; plugins/quirky.editor/src/types.ts; docs/quirk/specs/2026-10-28-sb-mobile-app-prerequisites/logic.md.
- **Reversibility:** medium
- **Confidence:** high for authorization distinction; implementation proof remains required
- **Revisit if:** A concrete producer limit prevents a specific flow without overriding a locked decision.
- **Source:** assumed — autonomous

## Progress
Implementation authorized for the independent permitted categories under the combined spec; native chat/voice remain forbidden pending a ruling. Direct current authorization-function smoke exited 0: terminal/send and ask/answer admitted; structured/create, speech.dictation.start, speech.models.list, worktree/sleep, browser/list and editor/preview denied. This is policy-function evidence only, not daemon/CLI/native execution and not proof missing APIs cannot be implemented. No suites, dogfood, review rounds, builds or typecheck ran. Next: commit contracts/spec, dispatch at most three isolated implementers, integrate real APIs and phone controls, smoke, typecheck, catch up once and land.
