# Browser native profile clearing: completion and storage isolation

## Status & amendments
Blocked at feasibility, 2026-10-28. Requirements and recommended defaults resolved autonomously under build/roadmap:docs/loop/LOOP.md. Self-reviewed combined logic/technical spec; no implementation, separate tech spec, external spec review or runtime acceptance claim.

**Amendments:** None. This spec retains predecessor sa-browser-profiles-settings D9/D21 rather than superseding their native safety requirements.

## Purpose and conceptual model
Complete browser.md section2.5's Default cookies/site-data clear and inactive isolated-profile removal across both engines. A profile combines a native Browser partition with the plugin's Chrome directory and profile metadata. Completion means native website data is gone before the Chrome-side clear/removal and success response. Invoking a native function is not this completion signal.

Consumers are Browser Settings, authenticated plugin API callers and the generated CLI. The same confirmation, active-profile checks and transaction outcome apply to all three.

## Scope and non-goals
Own only native Default/site-data clear, isolated-profile removal and their prerequisite safety proof. Profile creation/switching, imports, native identity, design mode, routing, paired hosts and unrelated browser parity remain with their existing items. Do not modify the SDK projection, invent private native bridges, substitute Chrome for Native, erase arbitrary filesystem paths or alter protected loop files.

The item cannot ship a standalone remainder: isolated-profile removal needs native completion, and Default clearing additionally needs independently proven native storage-root isolation. The predecessor already ships safe refusal; preserving that guard is not completion of this item.

## Decisions locked
- Use existing public plugin profile methods, generated CLI and Settings controls; no new parallel profile store or success shape.
- Destructive requests require existing confirmation/--yes and refuse active/pending profile use before native dispatch.
- The native clearing capability stays unavailable until a supported public completion/error acknowledgement or documented barrier exists.
- Reject unavailable native clearing before claiming the one-use confirmed request or invoking Session; preserve Chrome data, profile metadata and native state.
- An already-claimed uncertain completion keeps profile admission closed as the existing lifecycle specifies; do not reinterpret timeout as cancellation.
- Default always exists and cannot be removed. Default native testing must not even create its guest before native storage-root isolation has been proven.
- Temporary QUIRKY_HOME/helper HOME and a partition identifier do not establish the actual WKWebView websiteDataStore root.
- No external research swarm, human decision gate, native deletion probe, tests, dogfood or review during this blocked build-first item. Record exact evidence and queue-block this existing owner.

## Behavior and acceptance scenarios
These are the required end-to-end flows after the public prerequisites exist, not completed implementation claims. Each is scriptable through the existing plugin API/CLI; native storage outcomes require the real native surface in an owned environment.

### SC1: Public native capability preflight
Before: configured/projected Electrobun 2.0.4; no supported native completion signal or proven isolated native root. Walkthrough: inspect the public Session/BrowserView contract before any native view/deletion call. After: clearing remains unavailable; Default/native data, Chrome directory and profile list remain unchanged. No success toast, capability enablement or real Session invocation. Current source already supplies this refusal.

### SC2: Clear Default after safe root and completion support exist
Before: an independently verified run-owned native website-data root contains Default fixture cookies/site data; its Chrome profile also contains owned fixture data, and no pane/page/admission uses it. Walkthrough: confirm the existing Default clear request; prevent new admissions; await supported native deletion completion, then quiesce/clear Chrome storage. After: both engines' fixture data is absent, Default metadata still exists, admission reopens and only then the API/UI reports successful clear. No unrelated profile or storage root changes.

### SC3: Remove an isolated profile after native completion
Before: a fresh UUID profile Review has owned native/Chrome fixture data and no users. Walkthrough: confirm removal, claim the one-use request and await acknowledged native deletion before Chrome maintenance and metadata removal. After: Review is absent from profileList, its owned Chrome storage is gone and a real native fixture confirms its data is removed. Default and another fresh UUID profile remain unchanged. A failed native acknowledgement preserves the Chrome directory and Review metadata.

### SC4: Cancellation, active use and unavailable/uncertain completion
Before: Review contains fixture data. Walkthrough: cancel confirmation, attempt removal with an active pane or pending admission, or attempt clear with native capability unavailable. After each: refusal/cancellation leaves native data, Chrome directory and metadata intact; unavailable capability refuses before request claim/invocation. If a future supported operation is claimed but its completion becomes uncertain, no Chrome/metadata mutation or success occurs and admission remains closed under the existing lifecycle rule. Never repeat a timed-out deletion speculatively.

### SC5: Native nightly isolation boundary
Before: no native guest exists for the run. Walkthrough: prove the configured native root using a supported public setting and independently observed owned storage; only then create Default fixtures. Without this proof, mark Default scenarios blocked. Fresh UUID partition-isolation scenarios may use two newly created profiles per predecessor D21, but do not bypass unavailable clearing or claim their native data was deleted. After: no real user Default, app-shell partition or unrelated native state was touched.

## Defect and safety regressions
- Void-returning native invocation, await-void and timers must never produce an acknowledged clear.
- Visible cookie/DOM-storage polling is not proof that all native cookies/site data was removed.
- No Chrome/profile-metadata mutation occurs without the genuine native completion acknowledgement.
- One-use confirmed requests cannot be bypassed by direct window command invocation; active/pending use and late completion retain existing admission protection.
- No native scenario treats QUIRKY_HOME or helper-process HOME as proof of actual native website-data isolation.
- Browser design/annotation defects in browser.md are outside this profile-only item.

## Evidence and industry insights
No external research swarm under the current loop policy. Local sources establish the blocker:
- browser.md:80-85 defines profile and clear/remove outcomes; docs/architecture.md:180-203 retains separate human Native and agent Chrome engines.
- apps/desktop/hutch.config.ts:6-8 and .hutch/devkit/package.json:1 identify configured/projected Electrobun 2.0.4.
- SDK api/sdks/main/proc/native.ts:3360-3366 exposes clearStorageData(...):void; ABI :1102-1105 has only two cstring arguments and returns FFIType.void. Public Session :3373-3394 adds no completion barrier.
- SDK api/sdks/main/core/BrowserView.ts:44-78 provides partition, not a native storage-root override. No websiteDataStore/storageRoot/storagePath/userDataPath surface was found in the inspected SDK API projection.
- packages/ui/src/native-browser.ts:990-1008 keeps clearing unavailable; plugins/quirky.browser/src/preferences-ui.tsx:19-30 checks it before claim. preferences-lifecycle.ts:52-87 requires claimed acknowledgement before Chrome/metadata mutation.
- Predecessor decision log D9/D21 and docs/loop/native/sa-browser-profiles-settings.json require the same safe boundaries. Read-only scout NativeStoragePrereqs independently confirmed both missing prerequisites. No inference about private native implementation is needed.

## Deferred ideas
None beyond this item's explicit missing public prerequisites. Do not create a duplicate follow-up; this item remains their owner.

## Glossary
Completion acknowledgement: supported evidence native removal finished, including errors, not method invocation. Native root isolation: proven placement of the actual native website data beneath a run-owned root before guest creation. Partition: pre-creation native profile identifier, not proof of filesystem-root isolation. Profile admission: the existing lifecycle gate protecting pane/page creation and switching during storage maintenance.

## Technical decisions and feasibility outcome
Retain existing NativeBrowserCapability.clearPartitionAvailable and clearPartition contract, one-use UI claim and ProfileLifecycle sequencing. No public types/signatures or callsites need changing to record the blocker. Do not dispatch implementers against a nonexistent SDK completion API, add arbitrary waits, add mocks to stand in for native proof, patch generated SDK files or execute destructive native probes.

Unblock only when (1) the configured public native SDK provides supported deletion completion/error acknowledgement or a documented barrier; and (2) supported pre-creation native storage-root configuration plus independent safe evidence establish the real owned root for Default scenarios. Then implement against those real contracts and add the API/CLI acceptance/native scenarios above under the loop policy in effect at that time. Until then, queue-block this item, preserving all predecessor code and pending native handoffs.
