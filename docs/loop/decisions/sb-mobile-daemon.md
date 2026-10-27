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

## Progress
Claimed sb-mobile-daemon on lane 3. New build/sb-mobile-daemon branches from current integration. Read authoritative loop, full relevant feature doc, architecture and roadmap locks. Repository-seam scout running. Next: finish autonomous design/spec and shared contracts, commit, dispatch at most three isolated implementers.
