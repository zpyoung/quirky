# sb-mobile-daemon decisions

## D1: Ship the three claimed parts together, using Quirky's JSON-RPC API
- **Question:** which flows and compatibility contract does this item own?
- **Options:** port Orca's RPC catalog; implement the combined queue scope on Quirky's public API.
- **Chose:** listener, offers/registry/revocation, v2 E2EE, explicit mobile method allowlist, desktop Mobile page/settings and phone-driving overlay. Keep Quirky JSON-RPC 2.0; no Orca RPC aliases or legacy encryption handshake.
- **Why:** the item combines all three parts; architecture explicitly chooses a fork of the phone app onto this API, not reimplementing Orca's roughly 193 methods.
- **Evidence:** docs/architecture.md:298-301; mobile.md Transport, Pairing, Encryption, flows 1,2,7,10.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** the later phone fork needs a different wire contract.
- **Source:** locked by docs/architecture.md

## D2: LAN and tailnet only; no hosted relay or misleading installation links
- **Question:** connection modes, onboarding installation and unsupported platforms.
- **Options:** use Orca's hosted services and store links; accurately show only Quirky-supported direct transport and companion availability.
- **Chose:** LAN/tailnet connection, explicitly unavailable Relay. Desktop installation stage must explain the Quirky phone fork is not yet distributed rather than sending users to an incompatible Orca app. No cloud account dependency. Record Windows firewall and Linux/Windows runtime verification as deferred platform work.
- **Why:** Quirky cannot pair the existing Orca app's RPC contract and may not use upstream's hosted relay. A QR must not promise unsupported cloud connectivity.
- **Evidence:** docs/architecture.md:298-301; docs/roadmap.md:282-286; mobile.md flows 1,2.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** sb-mobile-app publishes a compatible app/build and installation URLs.
- **Source:** locked by docs/architecture.md

## D3: Follow night-mode workflow and autonomous defaults
- **Question:** brainstorming process, gray areas and review requirements without a person.
- **Options:** interactive design/research swarms; source-grounded autonomous decisions and one combined spec.
- **Chose:** select all applicable Visual/API/Data/Integration gray areas; resolve observable defaults from mobile.md and current conventions. No human questions, visual companion, research swarms or separate tech.md/spec review. Write combined logic.md with technical contracts; self-review every in-scope flow. Commit shared contracts before at most three implementers. One affected-suite/scripts/typecheck gate, UI dogfood once, integration catch-up once and final review round/fix batch.
- **Why:** current build/roadmap LOOP.md night mode overrides its ordinary steps.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md, Night mode and Answering a skill's questions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authoritative loop instructions change.
- **Source:** locked by docs/loop/LOOP.md

## D4: Use omp task implementers and Gemini cross-family review
- **Question:** SDD backend preflight when preferred Anthropic reviewers are unreachable.
- **Options:** omp+opus; omp+gemini; reduced-independence OpenAI review.
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini, reasoning high. Maximum three implementation components. Build command bun run build; final commands bun scripts/suite.ts <affected directories>, bun test scripts, bun run typecheck; full merge gate owned by queue.ts land.
- **Why:** pi-watch --check in /tmp reports opus/sonnet unavailable and google/gemini-3.1-pro-preview:high reachable.
- **Evidence:** iteration 3 tool output, pi-watch --check (7/12 ready).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the verified reviewer fails dispatch.
- **Source:** assumed — autonomous

## D5: A separate mobile listener preserves the loopback UI security condition
- **Question:** shared listener, independent RPC proxy, or feature-owned mobile transport?
- **Options:** widen shared HTTP; duplicate dispatcher; plugin listener using public admission API.
- **Chose:** plugin listener and PluginContext.clients.accept, immutable device identity, authorization before every dispatch and cleanup on revocation. UI/static/hooks stay loopback-only.
- **Why:** m0-ui-api D24 assumes loopback for unauthenticated modules; widening shared HTTP would invalidate that assumption.
- **Evidence:** packages/daemon/src/server.ts:73-110; docs/loop/decisions/m0-ui-api.md:238-247.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** another plugin needs a trusted transport.
- **Source:** assumed — autonomous

## D6: Strict v2 and bounded authorization/failures
- **Question:** API authentication/versioning/errors/rate-limits: legacy? arbitrary methods? failed writes? exhaustion?
- **Options:** compatibility plaintext or v2; prefix or literal allowlist; optimistic or durable credentials; unbounded or explicit budgets.
- **Chose:** v2 only, pinned key, strict transcript proof, literal consumer allowlist and safe parameter restrictions, fresh credential validation before cached/nested dispatch, source socket/frame/handshake/buffer/request caps, one toast after three failures in60s.
- **Why:** later phone fork needs no legacy RPC; source supplies exact protocol and resource limits.
- **Evidence:** mobile.md Encryption, RPC authorization and Edge cases; logic.md A3-A5.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** the phone fork requires a version migration.
- **Source:** locked by mobile.md

## D7: Pending reuse, explicit rotation and fail-closed identity
- **Question:** Data format/idempotency/errors: repeated generation, corrupt files and partial persistence?
- **Options:** new token every click or reuse; regenerate identity or fail closed; list pending or scanned only.
- **Chose:** one pending row reused unless rotate, paired rows unaffected, scanned devices only in list, atomic0600 durable transitions, no offer before write and no secret in state/events/logs.
- **Why:** silent replacement unpairs phones and optimistic issuance advertises invalid credentials.
- **Evidence:** mobile.md Pairing and Edge cases; logic.md A3-A4.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** durable storage migrates.
- **Source:** locked by mobile.md

## D8: Preserve desktop flows with API-backed controls
- **Question:** Visual layout/density/loading/empty/error/interaction and CLI output/flags/recovery gray areas.
- **Options:** generic form only; dedicated plugin page/settings using current slots and command routing.
- **Chose:** intro/install/pair/paired, Settings link to declared open-settings command, ranked/refreshed/custom address, automatic page versus explicit settings QR, enlarge/copy/rotate,3s polling plus events, revoke without dialog, persisted name/sidebar/restore. Existing generated CLI JSON/error behavior; daemon layout/reporting.
- **Why:** matches source flows1,2,10 without UI-only control or bespoke shell IPC.
- **Evidence:** mobile.md flows1,2,10; SettingsDialog.tsx; packages/protocol/src/ui.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** source desktop flows change.
- **Source:** locked by mobile.md

## D9: Terminal service owns driver and phone-fit state
- **Question:** Integration conflict/retry/mapping: automatic claim, desktop resize, take back, disconnect and multiple phones?
- **Options:** cosmetic overlay; authoritative terminal lease and saved desktop viewport.
- **Chose:** authenticated connection claim on attach, server-side input and viewport exclusion, desktop fit records without stealing, Take back restores and prevents implicit reacquire, explicit claim permitted, retained fit on disconnect with optional timer, reconnect cancels timer, inspect/take-back/restore/all APIs.
- **Why:** renderer-only lock cannot pause typing and FitAddon otherwise steals phone dimensions.
- **Evidence:** mobile.md flow7 and Terminal streaming; quirky.terminal terminal.ts and TerminalPaneView.tsx.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** actual concurrent phones expose a different required lease policy.
- **Source:** locked by mobile.md

## D10: Defer Windows firewall and non-macOS runtime verification
- **Question:** implement unexercisable OS repair/native dialogs?
- **Options:** assert portable parity; follow macOS-only boundary.
- **Chose:** portable APIs where practical; defer Windows firewall/UAC and Linux/Windows runtime verification explicitly.
- **Why:** locked roadmap platform boundary.
- **Evidence:** docs/roadmap.md:282-286; mobile.md Windows notice.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** these platforms enter the build matrix.
- **Source:** deferred: platform

## D11: Reject contaminated attempts and restart from attributed snapshots
- **Question:** how to handle unsandboxed worker edits outside their assigned worktrees and an omitted CLI helper path.
- **Options:** silently absorb changes; stop, attribute, restore only owned mutations, and explicitly re-plan.
- **Chose:** stopped desktop after relative edit headers targeted parent terminal.ts and SettingsDialog.tsx; transport also acknowledged its initial parent package edit. Surgical inverse edits restored exact original snapshots09A7/7B40/1B5F. Removed this run's generated Serena scaffolds. Fresh desktop and transport snapshots preceded absolute-path-only retries. Explicitly added mobile/cli.ts to transport scope because it is the existing custom-CLI convention and no other component owns it. No contaminated attempt was committed.
- **Why:** tool cwd is independent from a worker's Bash cwd; prompt-only path boundaries failed. Final audit proved all three HEADs stayed5ca8c58, every final path belonged to the corrected component and main remained clean before integration.
- **Evidence:** /tmp/quirky-mobile.gBnEmU/boundary-incident.json, desktop-restart-snapshot.json, transport-before-replan.json, transport-restart-snapshot.json and wave-final-audit.json.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another unsandboxed tool writes outside its declared tree.
- **Source:** assumed — autonomous

## D12: Keep terminal input on Quirky JSON-RPC, not Orca's inbound binary opcodes
- **Question:** whether the generic client-admission API needs a binary input dispatcher.
- **Options:** invent a binary command dispatcher; preserve existing Quirky JSON-RPC input and sealed binary output.
- **Chose:** authenticate binary frames cryptographically but close1003 for unsupported application input; terminal write/send remain JSON-RPC with immutable caller identity. Output streams stay sealed binary. Deny raw backend agent-status/send and agents/deliver to phones because they bypass terminal ownership.
- **Why:** architecture locks a phone fork onto Quirky's API, not an Orca RPC/opcode compatibility layer. Existing local server ignores inbound binary. Trusted plugin backend sends remain unchanged; desktop/user input is lease-checked.
- **Evidence:** docs/architecture.md:298-301; packages/daemon/src/server.ts:120-122; mobile authorization tests and live encrypted smoke.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the phone fork has a measured need for a public binary command consumer.
- **Source:** locked by docs/architecture.md

## D13: Defer signed phone installation links rather than advertise an incompatible app
- **Question:** which real installation URL/QR the desktop can present before the Quirky phone fork is distributed.
- **Options:** use Orca store links; invent a Quirky download; show accurate unavailable distribution and queue the missing flow.
- **Chose:** preserve platform/channel/install stages but state compatible builds are unavailable. Follow-up sb-mobile-install-links depends on this item and sb-mobile-app and must wire real signed iOS/Android artifacts and install QRs when distribution URLs exist.
- **Why:** the existing Orca app speaks an incompatible RPC contract and cannot pair with this daemon. No compatible signed artifact or supported distribution URL is present in repo/context.
- **Evidence:** docs/loop/queue.json sb-mobile-app; mobile.md desktop install flow; architecture.md Mobile decision.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a compatible companion build is published.
- **Source:** deferred: companion installation

## D14: Correct implementation and fixture failures without pinning incidental tests
- **Question:** what the first actual acceptance runs proved and how to fix their roots.
- **Options:** weaken gates; repair real defects and retain consumer-visible regressions only.
- **Chose:** repaired missing key-encoding/equality definitions, invalid self CLI alias/camel-case positional declaration, outbound queue retransmission and duplicate-auth races; explicitly enforce1MiB because Bun's ws compatibility path accepted a larger payload despite maxPayload. Read PTY dimensions through metadata, not a redundant full-screen snapshot. Give the real two-window timer test its15s budget. Remove contradictory paired-token invalidation assertion and mock UI/manifest/default-list wiring tests; actual daemon/API/CLI tests and actual UI dogfood own those flows. Oversized reply test uses a real plugin method producer, not a multi-MiB fake-PTY single-write response.
- **Why:** observed runs failed19 then4 then1 paths; source tracing identified causes. A protocol-size guard must be tested at its actual boundary, and a viewport read needs dimensions rather than screen-copy work.
- **Evidence:** iteration3 artifacts33,36,43; capacity trace passed1/1 after explicit payload guard; corrected targeted lifecycle/storage/reply/lease run18pass0fail110assertions (artifact48).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** platform ws behavior changes or a consumer regression reproduces.
- **Source:** assumed — autonomous

## D15: Publish non-secret view state and support declarative page input
- **Question:** how agents observe and drive Mobile's stage, platform/channel and address without DOM-private state.
- **Options:** private React-only state; use existing ui.view.open input and ui.state slot reports.
- **Chose:** Mobile page input accepts stage/platform/channel/address; entering pair through that API also generates its offer. Page/settings report choices, status, errors and device labels, never QR URLs/tokens. Existing configure/pair/devices/revoke APIs back controls.
- **Why:** locked roadmap makes layout readable and UI actions scriptable; this reuses existing slot and view APIs.
- **Evidence:** docs/roadmap.md:31-38; MobilePage.tsx, MobileSettings.tsx and ui.tsx.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public window-control API changes.
- **Source:** locked by docs/roadmap.md

## D16: Verify against a real isolated daemon and PTY before desktop dogfood
- **Question:** what constitutes smoke proof beyond fake-PTY tests.
- **Options:** test claims alone; actual CLI, encrypted independent peer and real shell/PTY.
- **Chose:** live temporary-home daemon and actual PTY backend. Observed CLI state/devices, pinned-key v2 auth, denied daemon.stop, phone shell input/sealed binary output, rejected desktop typing, take-back, explicit reclaim, retained fit/restore and revoke/reconnect rejection. Corrected the throwaway probe's expectation: mobileState intentionally omits normal desktop-fit terminals, so take-back verification reads actual PTY metadata as well. Packaged build exits0,16 plugins.
- **Why:** fake transports cannot prove actual PTY and encrypted stream behavior.
- **Evidence:** /tmp/quirky-mobile.gBnEmU/live-smoke.ts; actual success output bg15; build output bg14; owned runtime MobileIteration3C.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final review changes these exercised paths.
- **Source:** assumed — autonomous

## Progress
Claimed sb-mobile-daemon on lane 3. New build/sb-mobile-daemon branches from current integration. Read authoritative loop, full relevant feature doc, architecture and roadmap locks. Repository-seam scout running. Next: finish autonomous design/spec and shared contracts, commit, dispatch at most three isolated implementers.
