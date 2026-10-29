# sa-browser-pane-workspace-preview decisions

Reader: the maintainer supplying the native preview capability — Decision: which host guarantees must exist before this item can be requeued.

## D1: Treat active workspace preview and conversion Back as one security-gated flow
- **Question:** What does the claimed follow-up own, and can ordinary file browsing satisfy it?
- **Options:** direct file browsing; passive file-resource/editor preview; isolated active-document grant preview with conversion history
- **Chose:** the third option is the requirement; neither existing alternative completes it.
- **Why:** the queue title explicitly requires active HTML, in-grant assets, nonpersistent isolated guests, outbound-network/permission/download denial, and Back across convertedFrom/convertedTo. Existing PaneTab.preview contains only path/url; Back delegates ordinary guest history. Conversion state without a safe renderer would not deliver the flow.
- **Evidence:** browser.md section 1 item 10; docs/loop/decisions/sa-browser-pane.md D17/D23; plugins/quirky.browser/src/pane-contract.ts:8-14; packages/ui/src/native-browser.ts:52-63; docs/loop/BLOCKERS.md:280-285.
- **Reversibility:** hard (security and behavior acceptance)
- **Confidence:** high
- **Revisit if:** the operator explicitly changes the active-preview requirement
- **Source:** locked by docs/loop/queue.json and docs/loop/decisions/sa-browser-pane.md D17/D23

## D2: Resolve relevant gray areas without a person or research swarm
- **Question:** Which brainstorming defaults apply before selecting a design in this unattended iteration?
- **Options:** ask a person; external research swarm; use source requirements, locked decisions, and one current-code feasibility scout
- **Chose:** autonomous source-grounded feasibility, no asks, companion, adhd offer, external swarm, or review round. Relevant areas are Visual interaction/error state; API auth/errors; Data lifetime/history; Integration native policy/authority.
- **Why:** all require the same prerequisite: an enforceable isolated guest. A failed capability must not mount active content, mutate conversion history, or claim success. Grants must confine document/assets, guests must not inherit browsing storage/daemon authority, and Back must cross actual completed conversions. Further presentation choices cannot remove the host requirement.
- **Evidence:** current build/roadmap:docs/loop/LOOP.md Build first, Each iteration, Answering a skill's questions; item title; docs/architecture.md:180-203,290-324; docs/roadmap.md:13-53.
- **Reversibility:** easy (resume design when feasible)
- **Confidence:** high
- **Revisit if:** the public host supplies the missing enforcement
- **Source:** locked by docs/loop/LOOP.md

## D3: Preserve the native engine and passive daemon-origin resource boundary
- **Question:** Can API growth, CSP-only HTML loading, a new loopback origin, or Chrome rendering avoid the missing Native policy hooks?
- **Options:** grow protocol types alone; serve HTML from daemon/passive resource URLs; load CSP-restricted HTML or a separate loopback origin; substitute Chrome/iframe; obtain supported Native guest enforcement
- **Chose:** only the last option meets the current contract. Do not loosen MIME/CSP, route arbitrary active HTML onto the daemon origin, expose direct file browsing as grant preview, or silently substitute another rendering engine.
- **Why:** API growth is permitted and required, but a TypeScript contract cannot enforce Native subresource traffic, permissions, or downloads. A separate HTTP origin fixes origin separation, not host egress/permission/download policy. Injected JS guards are not a host security boundary. Source preview uses session request filtering and permission/download denial in addition to CSP; guest policy also denies out-of-grant navigation/popups and applies a WebRTC transport fence. The locked architecture uses a system webview for people and Chrome for agent automation/explicit Watch.
- **Evidence:** docs/architecture.md:180-200,304-305; docs/roadmap.md:29-30,50-53; packages/daemon/src/file-resources.ts:35-94,233-239; /Users/zpyoung/PycharmProjects/orca/src/main/browser/doc-preview-protocol.ts:33-65,126-151; /Users/zpyoung/PycharmProjects/orca/src/main/browser/doc-preview-guest-policy.ts:139-159,178-201; sa-browser-pane D2/D17.
- **Reversibility:** hard (trust boundary and engine choice)
- **Confidence:** high for the inspected boundaries; no claim about private Native internals
- **Revisit if:** a supported equivalent enforces every required guarantee without changing the locked architecture
- **Source:** locked by docs/architecture.md and docs/loop/decisions/sa-browser-pane.md D2/D17

## D4: Block on actual host enforcement, not the missing Quirky wrapper
- **Question:** Does the installed supported SDK expose enough to implement a safe public preview capability here?
- **Options:** add protocol/UI/daemon capability backed by supported hooks; patch private Native pointers/generated devkit; block pending a supported host capability
- **Chose:** block. The installed Electrobun 2.0.4 macOS-arm64 projection exposes sandbox, partition strings, navigation rules, loadURL/loadHTML and observational download events, but no inspected resource-request interception/custom grant-resource handler, per-guest outbound policy, permission denial handler, or download cancellation/denial control. Do not patch generated devkit/FFI or present event observation as prevention.
- **Why:** BrowserView sandbox disables RPC, not browser networking. Navigation rules are navigation controls, not a demonstrated subresource/network firewall. loadHTML accepts HTML without a grant-backed asset handler/base contract. Session provides cookie/storage methods; its generic ephemeral example does not prove this Native guest has a nonpersistent store. Current Quirky persistent partition validation is changeable and is not the decisive blocker. The devkit projects API/language bindings rather than a maintained Native implementation source in this checkout.
- **Evidence:** apps/desktop/.hutch/devkit/projection.json:1 (version 2.0.4, macos/arm64, source manifest ce1bda72ef0e7986bfc1a140f33fdbbb33a6223c4359b2f38ca7e8344f00cdfb); api/sdks/main/core/BrowserView.ts:44-76,276-298,359-374; api/sdks/main/proc/native.ts:3346-3394 (both API paths relative to apps/desktop/.hutch/devkit); packages/ui/src/native-browser.ts:19-40,490-513,913-920; PreviewFeasibility scout current SDK inventory.
- **Reversibility:** medium (requires host support, then ordinary public API implementation)
- **Confidence:** high for inspected public API limits; nonpersistent Native behavior remains unproven rather than asserted absent
- **Revisit if:** a supported SDK provides grant-resource serving plus enforceable no-network/no-permission/no-download policy and proven nonpersistent Native storage
- **Source:** assumed — autonomous

## D5: Ground the current passive-resource boundary with a disposable runtime smoke
- **Question:** Is HTML refusal merely an old decision-log claim, and what does the current implementation actually return?
- **Options:** infer behavior from source; weaken the boundary for a rendering trial; execute FileResourceRegistry on one disposable file
- **Chose:** execute the current registry directly, without modifying production code or starting a daemon/native browser. HTML creation threw TypeError: file resource contentType is not allowed. The same bytes as text/plain returned 200, CSP default-src 'none'; sandbox and nosniff; a sibling /assets.js request returned 404. The response body matched the file. Registry close and temporary-directory removal finished; exit 0.
- **Why:** this proves the intentional current resource boundary without untrusted active execution or real profile/home writes. It is not a native sandbox test, daemon/API acceptance, successful preview, or proof of private Native behavior. No suite, dogfood, review, or typecheck ran; no implementation changed.
- **Evidence:** iteration 11 tool output from the disposable bun --eval registry smoke, 2026-10-28; packages/daemon/src/file-resources.ts:84-95,154-159,227-239.
- **Reversibility:** easy (disposable smoke only)
- **Confidence:** high for the exercised registry behavior only
- **Revisit if:** file-resource policy intentionally changes through a reviewed separate capability
- **Source:** assumed — autonomous

## D6: Halt before specs, contracts, and implementers rather than ship a partial security scaffold
- **Question:** Can a useful independently complete slice of this item land now?
- **Options:** add inert conversion types/UI; write a speculative approved implementation spec; claim direct file/editor browsing; preserve the feasibility result and block the core item
- **Chose:** preserve this decision log on blocked/sa-browser-pane-workspace-preview and block through the canonical queue command. No implementation spec is approved, contracts committed, feature code changed, permanent tests created, follow-up queued, or feature completion claimed. Exactly one item is handled.
- **Why:** every requested conversion/render/Back path depends on the missing safe host. Existing passive preview/direct HTML browsing already belongs to earlier work. A placeholder contract or unsupported-only preview API would not ship the requested behavior.
- **Evidence:** D1-D5; docs/loop/LOOP.md Blocking an item; sa-browser-pane D17/D23.
- **Reversibility:** easy (requeue preserved branch after supplying the host capability)
- **Confidence:** high
- **Revisit if:** supported host guarantees in D4 are supplied and demonstrated
- **Source:** assumed — autonomous

## D7: Limit host conclusions to macOS and preserve platform work explicitly
- **Question:** Does this investigation establish cross-platform preview support?
- **Options:** infer parity; test other platforms now; scope evidence to the installed macOS projection
- **Chose:** macOS only. Linux/Windows preview storage, request interception, permissions, downloads and guest lifecycle need their own supported adapters and verification; no such support is claimed here.
- **Why:** locked platform scope is macOS, and the installed devkit projection is macos/arm64.
- **Evidence:** apps/desktop/.hutch/devkit/projection.json:1; docs/loop/LOOP.md What is already decided.
- **Reversibility:** medium (platform adapters)
- **Confidence:** high
- **Revisit if:** other platforms enter the authorized build scope
- **Source:** deferred: platform

## D8: Supply the missing host capability as an Electrobun fork patch, enforced by public WebKit APIs
- **Question:** How does the item get the host guarantees D4 found missing, without private pointers or a weaker engine?
- **Options:** keep blocking; patch private WebKit SPI; add a public-API isolated preview view to the fork (`patch/isolated-preview-view`)
- **Chose:** the fork patch. `BrowserView` gains `isolatedPreview: { scheme, handler }` and the `<electrobun-webview isolated-preview>` attribute. Natively each view gets a fresh `nonPersistentDataStore`, a `WKContentRuleList` that blocks every load except the scheme, about:, data: and blob: (installed before any navigation runs, fail-closed if compilation fails), Lockdown Mode, navigation and response policies that cancel off-scheme navigation, cmd-clicks and downloads, and delegate denials for popups, file pickers, camera, microphone and location. No views://, appdata:// or RPC bridge.
- **Why:** this is exactly D4's "Revisit if" list, built from public WebKit/AppKit calls and enforced by the host, with CSP only as a second line.
- **Evidence:** fork commit on `patch/isolated-preview-view` (package/src/native/macos/isolated_preview.h, nativeWrapper.mm); fork spec docs/quirk/specs/2026-10-29-electrobun-fork/logic.md.
- **Reversibility:** medium (drops out when upstream merges an equivalent)
- **Confidence:** high for the guarantees the native test exercises (D10)
- **Revisit if:** upstream ships an equivalent API, or WebKit stops honoring content rules or Lockdown Mode for these loads
- **Source:** supersedes sa-browser-pane-workspace-preview D4

## D9: Close WebRTC with Lockdown Mode, measured rather than assumed
- **Question:** Content rules can't see WebRTC, which opens UDP directly (Orca needs a separate WebRTC fence for the same reason). What closes it on WebKit?
- **Options:** a document-start script deleting RTCPeerConnection (page-level, not a host guarantee); the private `peerConnectionEnabled` preference (SPI); a per-store proxy (macOS 14 `proxyConfigurations`); public `WKWebpagePreferences.lockdownModeEnabled`
- **Chose:** Lockdown Mode.
- **Why:** a probe on this Mac with loopback TCP and UDP listeners showed content rules plus navigation policy stopped every TCP connection (16 without fences) but WebRTC still sent STUN datagrams; adding Lockdown Mode made `RTCPeerConnection` undefined and sent zero datagrams. A proxy-only configuration didn't stop loopback loads at all. Lockdown Mode also removes WebAssembly, WebGL and service workers and disables the JIT, which a document preview can live without.
- **Evidence:** scratch probe output 2026-10-29 (baseline tcp=16 udp=3; rules+nav tcp=0 udp=4; +lockdown tcp=0 udp=0; proxy only tcp=16 udp=3); the committed native test repeats the control and fenced runs.
- **Reversibility:** easy
- **Confidence:** high for WebRTC and the load types tested; not tested: DNS prefetch hints (see Progress)
- **Revisit if:** a previewed document needs WebAssembly or WebGL
- **Source:** assumed — autonomous

## D10: Grants are per mount, folder-scoped, and entry-only at the worktree root
- **Question:** What may a previewed document read?
- **Options:** the whole worktree; the document's folder; the entry file only; Orca's folder-when-nested, entry-only-at-root rule
- **Chose:** Orca's rule. The grant reads the document's folder when it is inside a subfolder, and only the file at the worktree root, where `.env` and other secrets sit. Dotfiles and dot-folders are never served or previewed, symlinks are refused, and containment is checked with realpath. A fresh 128-bit grant ID is minted for every mount; storage keeps only the document path.
- **Why:** the egress fences make reading the grant harmless off-machine, but a smaller grant still limits what a page can show the user or put in its title. Per-mount IDs keep grant URLs out of history and persisted rows.
- **Evidence:** /Users/zpyoung/PycharmProjects/orca/src/main/browser/doc-preview-grant-registry.ts (root and request-base comments); apps/desktop/src/bun/workspace-preview.ts; plugins/quirky.browser/src/pane-service.ts documentFor.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** users need "authorize this folder" like Orca's authorized roots
- **Source:** assumed — autonomous

## D11: Conversion is explicit; direct file browsing stays as sa-browser-pane locked it
- **Question:** Does typing or pasting an in-worktree HTML path convert the pane, as Orca's address bar can?
- **Options:** convert every in-worktree HTML path; convert only through an explicit action
- **Chose:** explicit. `quirky.browser/panePreview({pane, path})`, `quirky browser pane preview --pane --path`, and a "Preview as workspace document" button on panes showing workspace HTML directly. Typing any address on a document page converts back to browsing. Back walks guest history first, then crosses `convertedFrom`; Forward walks guest history, then re-crosses `convertedTo`; a new address on a web page drops `convertedTo`.
- **Why:** sa-browser-pane D17 keeps explicit local HTML navigation (including `file://` and outside-worktree files) as direct browsing, and pane.test.ts asserts it. An explicit action gives the same conversion and Back flow without changing that contract.
- **Evidence:** docs/loop/decisions/sa-browser-pane.md D17; plugins/quirky.browser/test/pane.test.ts:120-125; Orca browser-page-conversion.ts and HtmlDocPreview.tsx (Back/Forward fallbacks).
- **Reversibility:** easy (the address bar could call panePreview later)
- **Confidence:** medium (product call made without a person)
- **Revisit if:** the operator wants paste-to-convert
- **Source:** locked by docs/loop/decisions/sa-browser-pane.md D17

## D12: The desktop host serves grants; the daemon only mints them
- **Question:** Which process answers `quirky-preview://` requests?
- **Options:** the daemon over HTTP (D3 forbids active HTML on its origin); the desktop main process through the SDK handler
- **Chose:** the desktop main process. The renderer passes the daemon-minted grant with its claim; the claim accepts it only for a view the SDK created as an isolated preview, installs preview navigation rules, then attaches a handler bound to that grant. Until then every request gets a 404.
- **Why:** it keeps active HTML off the daemon origin (D3) and puts file access next to the native fences. The renderer is Quirky's trusted shell, which already carries file paths.
- **Evidence:** apps/desktop/src/bun/native-browser.ts claim; apps/desktop/src/bun/workspace-preview.ts.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** remote worktrees need previews; the desktop can't read their disk
- **Source:** assumed — autonomous

## Progress

Stopped at LOOP.md step 3, brainstorming/technical feasibility, before approving an implementation specification or committing contracts. Current public SDK inspection and a disposable resource-registry smoke confirm the boundaries above; no supported enforcement capability was found. The one scout completed; no background service or implementer remains. No production code or inherited untracked files were changed. Record the blocker through queue.ts block after preserving this branch as blocked/sa-browser-pane-workspace-preview.

Resume only after supported Native host hooks provide grant-scoped active HTML/assets, isolated nonpersistent storage, request/transport denial, permission/download denial and safe guest lifecycle. Then requeue/restore the preserved branch, read current integration decisions, write a single logic spec with technical final section, commit real contracts, implement conversion and Back plus public API/CLI/UI/acceptance coverage. Do not remove the current passive-resource protections or equate file/editor browsing with completion.
