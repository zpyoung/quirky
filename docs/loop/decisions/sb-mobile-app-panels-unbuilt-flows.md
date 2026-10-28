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

## D6: Stop, restore and explicitly replan after a phone worker's relative-path writes
- **Question:** can the phone component proceed after reporting two edits landed in the parent's tree?
- **Options:** ignore the contamination; broaden the worker to the parent; stop and verify exact restoration before resuming isolation.
- **Chose:** stopped further parent writes, independently re-read both exact parent files and audited changed paths/worker HEADs. Parent contracts.ts#D8C5 and routes.ts#4FE8 match their committed snapshots, and parent status contains only parent-owned daemon edits/tests and inherited metadata. Explicitly reauthorized the original phone scope only under absolute /tmp/quirky-artifacts-phone-lane2; both worker HEADs remain039896bf.
- **Why:** the worker reported relative edit calls targeting the parent, then restored only its additions before receiving the stop instruction. Final absence of a diff does not mean no contamination occurred; integration needs its own evidence and a renewed scope boundary.
- **Evidence:** PhoneArtifacts IRC exact target report; parent read snapshots, git status and both git rev-parse HEAD results at corrective checkpoint.
- **Reversibility:** easy
- **Confidence:** high for exact restored snapshots; no unobserved cross-tree write claim
- **Revisit if:** wave-end attribution finds any additional unexpected path.
- **Source:** assumed — autonomous

## D7: Give artifact pages scoped RPC/storage/navigation and validate bundle metadata exactly
- **Question:** does the terminal namespace require granting generic terminal driving to artifact pages?
- **Options:** terminal grant on both pages; narrow route-bound artifacts exception.
- **Chose:** paths /terminal-artifacts and /terminal-artifact with exactly rpc/storage/navigate. Page policy admits exact artifact actions/source IDs and existing shared foreground notification polling/cancellation; normal terminal controls remain unavailable. Storage preserves PageApp's DirectNotifications preferences/checkpoints on every active route. Daemon bundle validator admits supported panels with exact paths/grants and mandatory base routes; two-route legacy bundles remain readable.
- **Why:** artifact preview does not drive a terminal, but silently denying the shared notification manager's existing storage is a regression. The active daemon validator only admitted original base2 kinds, so new route delivery needs corresponding producer admission rather than a broken bundle or generic grant wildcard.
- **Evidence:** PhoneArtifacts chosen route contract; apps/mobile/src/shell/bridge-policy.ts:162–168; plugins/quirky.mobile/src/daemon/bundle.ts supported route table; new artifact-bundle boundary coverage.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** native bundle capability versioning introduces a different strict route contract.
- **Source:** assumed — autonomous

## D8: Integrate scoped source with actual producer and transport invariants
- **Question:** which source changes satisfy artifact authority without new phantom contracts or duplicated renderers?
- **Options:** trust worker reports; source-audit their declared scopes and correct concrete contract gaps.
- **Chose:** audited both HEADs at039896bf and exact source paths after the wave settled; committed terminal8ebc1726 and phonec60489ba, integrated both and immediately removed both component worktrees. The service pins canonical path/dev/inode and verifies both descriptor and pathname identity at write boundaries; refresh retains the prior preview approval. Raster bound192KiB yields base64 at most256KiB, matching the phone validator. Reuse the existing MarkdownView with optional inert links, not a second parser. Local authority requires actual session ownership, kernel launch identity/incarnation and live local PTY; no invented hostId field is added to the public Session contract.
- **Why:** a canonical path string alone misses same-path inode replacement, a1MiB raster expands beyond phone frames, and a duplicate renderer would diverge. Session has no hostId field; real local launch/PTY authority is the available locality contract.
- **Evidence:** final worker HEAD/status audits; src/artifacts.ts verifyOpenPath/sourceOf; shared protocol Session; authored inode/expiry/source tests; MarkdownView caller map. New process fixtures isolate provider homes and Git config/pointers.
- **Reversibility:** medium
- **Confidence:** high for source attribution and observed core path; unrun edge tests remain unproven
- **Revisit if:** a real execution-host producer contract replaces local session authority.
- **Source:** assumed — autonomous

## D9: Fix actual registration and saved metadata failures at their source
- **Question:** why did the first physical smoke lack terminal methods, and why did a saved preview show its old byte count?
- **Options:** special-case missing methods or hide errors; correct invalid declaration and the state transition.
- **Chose:** removed unsupported minLength/maxLength/maxItems keywords from this item's manifest declarations; bounds remain enforced by the service and phone admission and described in the schema. Update preview.bytes from the saved UTF-8 content after an acknowledged save, with an authored consumer-visible size assertion. No kernel schema expansion or method-error suppression.
- **Why:** parseManifest reported12 unsupported-keyword errors, causing the entire terminal plugin to be rejected before activation. The first successful rendered save changed disk bytes but still displayed18B. The corrected rendered save displays17B for actual17-byte content.
- **Evidence:** first disposable smoke unknown quirky.terminal/send with cleanup; direct parseManifest diagnostic; final actual CLI list/preview/save receipt; browser PageApp rendered size17B and disk content '# Saved metadata\\n'.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the manifest schema subset or saved-content acknowledgement changes.
- **Source:** assumed — autonomous

## D10: Separate narrow exercised proof from postponed acceptance/native campaigns
- **Question:** what was actually verified under build-first?
- **Options:** call all authored tests or native behavior passing; record only exercised commands and surfaces.
- **Chose:** root+mobile bun run typecheck passed23.94seconds before smoke and23.23seconds after registration/metadata corrections. Final disposable physical daemon/PTY smoke exercised actual CLI list/preview/save across connections, two sealed phone clients and foreign-grant refusal. A390x740 Chromium page mounted production PageApp against an isolated real encrypted-phone RPC adapter: list/open, save17-byte content, authorization refresh without adopting external bytes, stale save refusal, retained draft and shared Back cancellation. Browser error log empty; final real disk held '# External writer\\n' and unprinted private file was unchanged. Browser tabs closed; each owned service exited; final cleanup confirmed daemon home and isolated home removed.
- **Why:** compilation alone cannot prove new consumer behavior, but a narrow component adapter/browser smoke is not native-shell/device or exhaustive acceptance proof. End-phase suites/reviews/dogfood remain explicitly postponed.
- **Evidence:** service lane2-artifact-smoke-final exit0, CLI/source/final/cleanup receipts; browser save/refresh/conflict/cancel observations; screenshot /var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/omp-sshots-15b7f72af21f8583.webp.
- **Reversibility:** easy
- **Confidence:** high for those exercised flows only
- **Revisit if:** end-phase API/native/browser execution contradicts them.
- **Source:** locked by docs/loop/LOOP.md; assumed — autonomous

## Progress
Artifact implementation and acceptance tests integrated; both component worktrees removed. Minimal real CLI/encrypted API/rendered PageApp smoke and corrected root/mobile typecheck passed; owned smoke resources stopped and homes removed. Permanent acceptance tests, native assertions, review rounds and full dogfood campaigns NOT RUN. Next: commit parent admission/docs/corrections, catch up build/roadmap once and read incoming decisions, typecheck, add one implementation-only push/provider prerequisite successor, commit/detach/canonical land. Remove remaining owned scratch only after landing.
