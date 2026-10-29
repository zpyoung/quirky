# m7-native-notification-and-signed-terminal-host decisions

## D1: Preserve the exact two conditional native flows
- **Question:** What are the purpose, consumers, success criteria, constraints, scope and primary behavior at brainstorming's essential-coverage gate?
- **Options:** Rebuild VM/registered-host features; treat requested banners as lifecycle completion; implement only the two prerequisite-gated native flows.
- **Chose:** This item serves desktop users needing authoritative native permission/click/dismiss behavior and operators needing production signed terminal-host launchd/TCC/admission/upgrade packaging. Success requires real OS evidence and an authorized production identity. Native Browser, remote automation/model retirement, VM provisioning and registered-host workspace flows retain their canonical owners.
- **Why:** The claimed title and parent D14 define precisely these remaining flows; other source flows already have owners.
- **Evidence:** docs/loop/decisions/m7-vm-and-owner-bound-host-workspaces.md:148-155; notifications.md:157-171,201-223; term-daemon.md:83-87; docs/roadmap.md:13-41.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The queue's authorized scope changes.
- **Source:** locked by docs/loop/decisions/m7-vm-and-owner-bound-host-workspaces.md D14

## D2: Do not infer notification permission or lifecycle from a void banner request
- **Question:** How do API response/error, CLI reporting and integration event-mapping gray areas resolve without native callbacks?
- **Options:** Infer delivered from no exception or timeout; inject web/plugin events as OS callbacks; retain explicit unavailable capabilities until supported public SDK hooks exist.
- **Chose:** Preserve permission/click/dismiss capabilities as false. A banner request, missing error, generic event emitter, screen-recording permission API or web Notification permission is not native notification authorization, display acknowledgement, target click or dismissal evidence. No retries or fabricated success are added.
- **Why:** Public NotificationOptions contains only title/body/subtitle/silent, and showNotification returns void. Existing public event sources expose no notification lifecycle hooks. Exact pane activation and retirement require real notification identity/events, not a guessed event.
- **Evidence:** apps/desktop/.hutch/devkit/api/sdks/main/core/Utils.ts:66-122; apps/desktop/src/bun/index.ts:361-365; apps/desktop/src/bun/native-browser-preload.ts:24; packages/protocol/src/desktop-capabilities.ts:23-28; apps/desktop/README.md:79-81.
- **Reversibility:** medium
- **Confidence:** high for the inspected SDK surface
- **Revisit if:** A supported public SDK supplies notification authorization, click and dismiss hooks with usable notification identity.
- **Source:** locked by docs/loop/decisions/m7-terminal-runtime-native-and-worktree-parity.md D3,D9

## D3: A stable SDK upgrade does not currently supply the missing callbacks
- **Question:** Is a currently published supported release an available integration path rather than a private SDK patch?
- **Options:** Use pinned 2.0.4; upgrade only if stable public hooks exist; fork private SDK/native code.
- **Chose:** Keep the pin unchanged. The npm latest endpoint reports 2.0.5 at d06abc9edf0b4e55116129cabbfe17bf89e11791. A source-only executable inventory compared its Utils.ts and all six main/events TypeScript files with the installed SDK: all seven files are byte-identical, and none of the event sources contains notification lifecycle declarations. This is not OS delivery acceptance or an exhaustive audit of every possible future SDK.
- **Why:** An upgrade with identical relevant APIs cannot provide the missing authority; private patches are forbidden by the item.
- **Evidence:** apps/desktop/hutch.config.ts:6-8; apps/desktop/.hutch/devkit/.complete:1-4; https://registry.npmjs.org/electrobun/latest ; https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/sdks/main/core/Utils.ts#L66-L122 ; lane9 iteration16-evidence/capability-inventory.json and seven source snapshots.
- **Reversibility:** easy
- **Confidence:** high for the pinned and latest stable relevant sources
- **Revisit if:** A supported public release changes these notification contracts.
- **Source:** assumed — autonomous

## D4: Production signing requires an authorized identity, not an ad-hoc substitute
- **Question:** Which authentication, identity selection, admission, upgrade and failure-recovery defaults are authorized for terminal-host packaging?
- **Options:** Generate an ad-hoc/self-signed identity; choose any discovered certificate; require an explicitly authorized production signing/packaging identity.
- **Chose:** Require the authorized production identity and its intended app/helper bundle and designated-requirement policy before implementing production launchd/TCC/admission/upgrade integration. Do not request credentials, import keys, change keychain/TCC/launchd state or claim unsigned packaging as completion. Current packaging remains unchanged.
- **Why:** The inherited zero-valid-identity observation is binding and no credential/authorization was supplied. This iteration also ran security find-identity -v -p codesigning once, which returned `0 valid identities found`, exit0. That repeated inventory was unnecessary given the inherited ground truth and is not evidence of production authorization. The inspected build config names dev.quirky.app but provides no signing identity.
- **Evidence:** docs/loop/decisions/m7-vm-and-owner-bound-host-workspaces.md:36-45; docs/loop/decisions/m7-terminal-provider-host-and-worktree-remainder.md:58-67; apps/desktop/electrobun.config.ts:3-27; apps/desktop/README.md:25-26,81; term-daemon.md:83-87.
- **Reversibility:** hard
- **Confidence:** high for the missing prerequisite; no production TCC/signing behavior exercised
- **Revisit if:** An authorized usable signing/packaging identity and app/helper identity policy are supplied.
- **Source:** locked by docs/loop/decisions/m7-vm-and-owner-bound-host-workspaces.md D4

## D5: Block this prerequisite-only item before specifications or implementation
- **Question:** Which approach can complete the core under the unattended loop's constraints?
- **Options:** Supported public callbacks plus authorized production signing; fabricate hooks or use private FFI/ad-hoc signing; implement scaffolds while leaving the actual native flows unbuilt.
- **Chose:** The supported approach is required, but both prerequisites remain unavailable. Block the whole item at step 3 after bounded feasibility research. Do not create contracts, implementation stubs, native acceptance placeholders or another successor. Existing source behavior and capability refusals remain untouched.
- **Why:** These two missing flows are the item's entire core, not an optional slice. The title expressly makes their outside prerequisites mandatory. There is no reachable independent implementation to land without substituting a different task.
- **Evidence:** Claimed queue title; parent D4,D14; LOOP.md Blocking an item; D2-D4 above.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Either flow's prerequisite is supplied; reassess that flow independently without inventing the other.
- **Source:** assumed — autonomous

## D6: Record bounded evidence without claiming native acceptance
- **Question:** What workflow and verification are meaningful for this feasibility-only disposition?
- **Options:** Run unrelated suites/native UI; claim delivery from a source audit; record source inventory and actual identity output, then use the canonical blocker protocol.
- **Chose:** Resolve brainstorming defaults autonomously under LOOP.md; no human questions, visual companion, research swarm or cross-family implementation review. One targeted read-only scout mapped inherited evidence. The source inventory executed successfully and retained exact hashes/snapshots in the lane's ignored notes folder. No production code changed; no suite, build, typecheck, notification display, permission prompt, real click/dismiss, signed helper or TCC/launchd acceptance is claimed.
- **Why:** No implementation was attempted because the locked feasibility gate failed. Unrelated checks cannot manufacture the missing SDK callbacks or authorized identity. The queue's block command, not manual shared-file edits, persists the disposition.
- **Evidence:** Lane9 iteration16-evidence/capability-inventory.json; NativePrerequisiteMap result; D3-D4; authoritative LOOP.md Orient/Blocking an item.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The item is resumed with the required outside capability and authorization.
- **Source:** assumed — autonomous

## Progress
Blocked at step 3, after autonomous scope/gray-area resolution and prerequisite feasibility inventory, before specs/contracts/implementation. Both remaining native flows require unavailable outside prerequisites. Commit this log, retain it on blocked/m7-native-notification-and-signed-terminal-host, detach and run the absolute canonical queue.ts block with the external blocker entry. End this one-item iteration after the command returns; no queue-wide completion or stuck marker is warranted by this item claim.
