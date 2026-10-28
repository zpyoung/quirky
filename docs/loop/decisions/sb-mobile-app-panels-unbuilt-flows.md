# sb-mobile-app-panels-unbuilt-flows decisions

## D1: Complete reachable terminal artifacts without inventing external services
- **Question:** Which of the three follow-up categories can ship on the current foundations?
- **Options:** block all categories; invent credentials/provider data; implement terminal authority and retain external prerequisites explicitly.
- **Chose:** implement real terminal-output-derived artifact discovery, device-bound opaque grants, bounded preview, guarded conditional save, grant refresh and phone navigation. Native push and GitLab/Linear/Jira Tasks remain unbuilt, retained in one implementation-only follow-up before landing.
- **Why:** missing adapters are implementable under roadmap API growth. Terminal CWD/output/path parsing already exist. Push lacks an operator-controlled gateway/native credentials; GitLab predecessor items remain blocked and Linear/Jira lack provider APIs.
- **Evidence:** MobilePrerequisites scout; parent sb-mobile-app-panels D8–D10; canonical queue status; packages/protocol/src/pty.ts:23–79,125–155; plugins/quirky.terminal/src/window/pane/links.ts:59–108.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** external service credentials or provider-owned public contracts land.
- **Source:** assumed — autonomous; preserves sb-mobile-app-panels D8–D10

## D2: Resolve integration, authentication, data mapping and error gray areas with authoritative identities
- **Question:** Which paths and caller identities authorize outside-worktree access, refresh and save?
- **Options:** trust a phone path; alias ordinary editor saves; derive candidates from actual PTY text and bind grants to exact source/caller.
- **Chose:** terminal plugin owns the producer and file capability. Clients supply only worktree/session and opaque artifact/grant identity, never an absolute path. Scan bounded actual unwrapped PTY text; resolve only daemon-derived path candidates against host CWD, retain real file identity, reject remote execution and source mismatch. Mobile identity is authenticated deviceId; local CLI identity must remain stable across its connections without sharing a mobile grant. Grant expiry and invalid/source/file failures are distinct; refresh revalidates authority and never retries a write.
- **Why:** parent D10 forbids minting authority from arbitrary phone paths; normal editor containment must remain unchanged. A grant refresh is not permission to overwrite changed disk content.
- **Evidence:** parent D10; plugins/quirky.terminal/src/window/pane/link-provider.ts:85–108; plugins/quirky.editor/src/daemon/paths.ts; public PluginCaller.
- **Reversibility:** hard (capability contract)
- **Confidence:** high
- **Revisit if:** a producer-owned execution-host artifact API replaces this local contract.
- **Source:** assumed — autonomous

## D3: Preserve bounded phone presentation and drafts across refusal
- **Question:** How do loading, preview formats, editing limits, conflicts and navigation behave?
- **Options:** unbounded file transfer; invisible truncation; explicit bounded preview and read-only limits.
- **Chose:** compact artifact list and source-aware preview routes, worktree/session-scoped back navigation, loading/empty/error/disconnected states. UTF-8 text/Markdown up to48KiB is editable only when complete and writable; larger text is explicitly truncated/read-only. Safe bounded image previews are allowed; unsupported binary formats are metadata-only. Save compares the disk revision and pinned file identity; refusal preserves the draft. Explicit refresh authorization preserves drafts and does not silently adopt a new content revision. Unsaved navigation requires confirmation. No external image/script/HTML rendering.
- **Why:** the bridge admits bounded strings and source only enables Save terminal artifact for writable nontruncated text. Bounded previews avoid a new bulk-transfer protocol for this artifact flow.
- **Evidence:** external mobile.md flow8 Files; upstream behavior recorded parent D10; plugins/quirky.mobile/src/daemon/panel-authorization.ts:48–65.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a concrete consumer needs larger editable artifact transfers.
- **Source:** assumed — autonomous

## D4: Use build-first unattended execution with two isolated components
- **Question:** How should skills, tests, reviews and implementation ownership apply here?
- **Options:** human/research/review gates; autonomous combined spec and contract-first implementation.
- **Chose:** no human questions or research swarm; standard gray areas answered in D1–D3; one self-reviewed logic spec with final technical section. Commit shared DTO/schema/method/route contracts before dispatch. OpenAI omp task implementers, two disjoint component worktrees, parent integrates authorization/docs. No suite, dogfood or review rounds until the end phase; do not probe an unused reviewer. Eventual cross-family reviewer preferred Opus, no availability/pass claimed. Developer-required narrow disposable runtime smoke and root/mobile typecheck after integration; one roadmap catch-up before land.
- **Why:** canonical LOOP build-first section supersedes normal skill gates; higher-priority runtime verification remains required. Existing .quirk/ and .serena/ metadata is inherited and must remain untouched, not stashed or committed.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; current branch initial status; xd://lsp status: no configured language servers.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m7-test-triage starts or controlling policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D5: Preserve platform and feature ownership boundaries
- **Question:** Does this follow-up authorize native service/distribution provisioning or another lane's phone/editor work?
- **Options:** reuse Orca hosted push; fabricate credentials/providers; retain exact prerequisite ownership.
- **Chose:** no upstream push account/service, secret-home inspection, entitlement invention or GitLab override. Do not rebuild working foreground subscriptions/GitHub Tasks/contained files or lane7 native-chat/voice/sleep/tab work. macOS implementation/smoke only; Linux/Windows filesystem semantics and native iOS/Android background push remain platform work, not inferred from headless results.
- **Why:** architecture mobile decision and parent D8–D10 bind this consumer; active editor and mobile prerequisite decisions do not own artifact grants.
- **Evidence:** architecture.md:290–305; sb-mobile-app-panels D8–D10; active build/sb-mobile-app-prerequisites D2–D5; build/m2-editor-build-unbuilt-flows D1.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** authorized platform/service/provider prerequisites change.
- **Source:** deferred: platform

## Progress
Prerequisites mapped. Terminal artifact implementation is authorized; external push and provider flows remain explicit requirements for the single follow-up. Next: commit combined spec and shared public contract, dispatch two isolated implementers, integrate actual source, run narrow disposable smoke and typecheck, catch up once/read incoming decisions, add one prerequisite-only follow-up, commit/detach/canonical land. No tests, review, UI dogfood or native pass claimed.
