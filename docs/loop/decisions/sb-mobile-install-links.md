# sb-mobile-install-links decisions

## D1: Keep signed Quirky installation as the complete item boundary
- **Question:** what must this follow-up ship, and who consumes it?
- **Options:** desktop UI wiring alone; publish compatible native apps and wire their real installation destinations; reuse Orca's existing apps.
- **Chose:** the full claimed flow: signed Quirky-compatible iOS Preview, iOS Stable and Android artifacts with supported installation URLs, desktop open/copy links and installation QRs, plus the Android installation guide. Preview is the default iOS channel. Desktop users must be able to obtain the companion before pairing.
- **Why:** the claimed title explicitly requires installable compatible builds, and mobile.md flow 1 defines the channel, install, QR and guide behavior. The existing pairing QR is not an install destination.
- **Evidence:** canonical queue wait --lane 11 returned sb-mobile-install-links; research/orca-features/mobile.md:28–44,13–14; docs/roadmap.md:246–257; plugins/quirky.mobile/src/window/MobilePage.tsx:214–242.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the queue owner explicitly changes the item boundary.
- **Source:** locked by docs/loop/queue.json

## D2: Preserve the Quirky identity and reject incompatible upstream destinations
- **Question:** can Orca's public App Store, TestFlight and Android links unblock installation?
- **Options:** link upstream apps; invent Quirky destinations; retain truthful unavailable installation until compatible distributions exist.
- **Chose:** retain truthful unavailability. Do not use Orca's store links, pair URLs as install URLs, guessed domains, Expo development URLs or unsigned/JavaScript exports as published companion builds. Preserve the existing Quirky identity rather than silently renaming it for distribution.
- **Why:** the architecture requires a phone fork onto Quirky JSON-RPC, and daemon D2/D13 explicitly prohibit sending users to an incompatible Orca app. Source identifies the app as dev.quirky.mobile with quirky://pair; the successful dependency export only proves JavaScript/Hermes bundling.
- **Evidence:** docs/architecture.md:298–301; docs/loop/decisions/sb-mobile-daemon.md:14–23,135–144; docs/loop/decisions/sb-mobile-app.md:179–188,267–276; apps/mobile/app.json:3–6,10–12,26–35; plugins/quirky.mobile/src/window/MobilePage.tsx:229.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** a compatible Quirky native release is published under an explicitly supported identity and destination.
- **Source:** locked by docs/architecture.md

## D3: Block at distribution readiness rather than manufacture a partial install flow
- **Question:** can this item continue autonomously with the repository-provided prerequisites?
- **Options:** implement links/QRs against placeholders; add speculative release scaffolding; block the core item with exact distribution prerequisites.
- **Chose:** block the whole item at the readiness/brainstorming step. No product code, contracts, speculative EAS configuration, install QR, or runtime behavior changed. No second follow-up: this item already owns the missing flow.
- **Why:** a read-only readiness scout and direct source inspection found no published compatible signed artifact URLs, signing/distribution configuration, or EAS release profiles in the examined repository. The app declares local Expo run/export commands, not a supported release destination. Dependency decisions explicitly retain unsupported distribution. Canonical queue deps reports ready:true with pending:[], which proves feature dependencies landed, not publication readiness. There is no independent useful remainder: platform/channel selection and accurate unavailable messaging already ship.
- **Evidence:** MobileInstallReadiness completed read-only report; apps/mobile/app.json:1–45; apps/mobile/package.json:6–11; docs/quirk/specs/2026-10-28-sb-mobile-app/logic.md:18,32,68; docs/loop/decisions/sb-mobile-daemon.md D13; canonical queue deps sb-mobile-install-links output {ready:true,pending:[]}.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported signed native distribution artifacts and channel URLs are supplied.
- **Source:** assumed — autonomous

## D4: Require owned distribution inputs without inspecting credentials or publishing externally
- **Question:** what specifically unblocks a real release rather than a cosmetic link change?
- **Options:** infer release ownership and search real credential stores; expose upstream services; record the missing owned release inputs.
- **Chose:** require signed, installable builds of this Quirky Expo fork plus supported Quirky iOS Preview/TestFlight, iOS Stable/App Store, and Android APK/download destinations and installation-guide URL. If publication is to be performed by a lane, it additionally needs an authorized distribution owner, signing/provisioning access, channel/listing identifiers and hosting/publishing access. None is supplied by the examined source or dependency records. No keychain, real app state, signing secret or external publisher was inspected or modified; no native publication was attempted.
- **Why:** Expo metadata and local run commands cannot establish release ownership, obtain Apple provisioning/listings or supply a supported public artifact host. Guessing these would violate the compatible-build prerequisite and create misleading installation instructions.
- **Evidence:** apps/mobile/app.json:1–45; apps/mobile/package.json:6–11; docs/loop/decisions/sb-mobile-app.md D6,D25; research/orca-features/mobile.md flow 1.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the release owner supplies these inputs or existing published compatible distributions.
- **Source:** assumed — autonomous

## D5: Apply unattended blocked-item protocol without new verification claims
- **Question:** which skill questions and gates apply before a core prerequisite is met?
- **Options:** ask a person; continue speculative implementation/spec/review; record autonomous readiness decisions and block.
- **Chose:** classify this as Integration/Visual distribution work. Resolve compatibility, identity, channels, empty/error behavior and publication authority from the feature doc and binding dependency decisions above. No asks, visual companion, research swarm, implementation dispatch, finished-feature spec or review round. One bounded read-only source scout settled readiness. Commit the decisions on build/sb-mobile-install-links, preserve them on blocked/sb-mobile-install-links, detach and use the canonical queue block command. No suite, dogfood or typecheck result is claimed: only documentation changes are committed for the blocked item, with no significant behavioral change to exercise.
- **Why:** authoritative LOOP.md requires autonomous decisions and blocking when the core cannot ship, while the build-first policy prohibits premature testing/debugging. No implementation design can supply absent signed artifacts or external release ownership. Never claim a runtime, native-device or release pass from source inspection.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md, Build first / Answering a skill's questions / Blocking an item; MobileInstallReadiness report; direct source reads recorded above.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the item is unblocked with concrete distribution inputs.
- **Source:** locked by docs/loop/LOOP.md

## D6: Retain platform limits rather than claim native build parity
- **Question:** what platform evidence carries forward while publication is blocked?
- **Options:** infer native parity from Expo source/export; preserve the existing platform obligations.
- **Chose:** retain the macOS-only host boundary and app dependency's pending native scenarios. No iOS signed build/device launch, Android native build/runtime, or Linux/Windows host execution is claimed. No native scenario file is changed because this item adds no behavior; existing sb-mobile-app scenarios remain authoritative.
- **Why:** portable source and an iOS JavaScript export do not execute platform signing, SecureStore, camera or native WebView integration.
- **Evidence:** docs/roadmap.md:282–287; docs/loop/decisions/sb-mobile-app.md D25; docs/loop/native/sb-mobile-app.json.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported platform runners and signed companion builds become available.
- **Source:** deferred: platform

## Progress
Blocked at distribution readiness/brainstorming: no supplied compatible signed companion artifacts or supported channel installation URLs. Readiness research completed; no product/test changes or runtime/release verification claims. Preserve this decision log on blocked/sb-mobile-install-links and append the prerequisite evidence through canonical queue block. Resume only after the release inputs in D4 exist; then write the combined logic/technical spec, commit contracts, implement actual links/QRs, and follow the then-current loop gates. Do not start a second queue item in this iteration.
