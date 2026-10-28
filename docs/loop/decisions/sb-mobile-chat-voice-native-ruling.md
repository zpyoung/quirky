# sb-mobile-chat-voice-native-ruling decisions

## D1: Own only the prerequisite-dependent remainder
- **Question:** What does this iteration own, and which workflow applies?
- **Options:** Rebuild shipped phone flows; infer permission from the follow-up title; assess exactly the remaining prerequisite-dependent flows.
- **Chose:** Assess interactive native-chat transcripts, attachments, queued chat, options and background-task UI; dictation, speech models and voice settings; and actual existing Native browser tab mirroring/control. Preserve terminal/ask, canonical view Sleep, explicit stop/history/resume, origin filters, Markdown and explicit Chrome Watch. Apply the canonical build-first LOOP instructions: autonomous answers, one combined logic spec, no research swarms, tests, dogfood or review round. No human ask.
- **Why:** Canonical queue wait assigned this exact item after the predecessor landed. Its D14 explicitly retained only these unbuilt flows. Earlier busy results were not permission to stop or duplicate another lane.
- **Evidence:** Canonical absolute queue.ts wait --lane 3 returned item sb-mobile-chat-voice-native-ruling; docs/loop/decisions/sb-mobile-app-prerequisites.md D14-D17; git show build/roadmap:docs/loop/LOOP.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The canonical item or controlling instructions change.
- **Source:** locked by docs/loop/LOOP.md

## D2: A follow-up is not an authorized native-chat or dictation ruling
- **Question:** Can this lane implement the structured chat and voice flows by electing an autonomous default?
- **Options:** Interpret parity as authorization; reuse background jobs or terminal injection as a substitute; require an explicit source-of-truth product ruling.
- **Chose:** Require an authorized architecture/roadmap amendment permitting the named interactive native-chat and dictation products and defining their public owners. Do not relabel ask cards as a transcript, background structured jobs as interactive chat, or terminal injection as native chat. Do not add inert voice settings or fake speech models.
- **Why:** Architecture Decisions binds structured sessions to background agents; its session design explicitly drops native chat. The roadmap retains that exclusion and explicitly drops dictation. LOOP locks those decisions and says to block when a design needs them changed. Autonomous defaults settle design ambiguity, not product authority.
- **Evidence:** docs/architecture.md:175-178,302-305; docs/roadmap.md:175-181; docs/loop/decisions/sb-mobile-app.md D5,D24; docs/loop/decisions/sb-mobile-app-prerequisites.md D3,D14.
- **Reversibility:** hard (requires authorized product scope change)
- **Confidence:** high
- **Revisit if:** An explicit binding amendment authorizes these exact flows and their public API ownership.
- **Source:** locked by docs/architecture.md

## D3: Preserve Native identity instead of substituting an engine or host screenshot
- **Question:** What qualifies as actual existing Native browser mirroring?
- **Options:** Silently convert to Chrome Watch; capture the host window or reconstruct the DOM; require supported owned-view Native page pixels and control.
- **Chose:** Require a supported public Native page-frame/control producer bound to the actual hosted worktree/tab/view identity, plus phone-scoped authorization and lease/lifecycle semantics. Do not start Chrome for a selected Native tab, use host screen capture/private FFI, or render a DOM approximation. The explicitly elected Chrome Watch path remains independently supported and unchanged.
- **Why:** Architecture separates the human system webview from the on-demand agent Chrome. The predecessor's D7 explicitly forbids Native conversion on selection; metadata and sandboxed evaluation alone are not page frames or safely authorized phone control.
- **Evidence:** docs/architecture.md:182-200,304-305; docs/loop/decisions/sb-mobile-app-prerequisites.md D7,D14; docs/loop/BLOCKERS.md:287-293.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** The supported Native SDK and public owning producer supply actual frame completion/error and exact-view control semantics.
- **Source:** locked by docs/loop/decisions/sb-mobile-app-prerequisites.md

## D4: Resolve interaction, authorization, data and lifecycle gray areas fail-closed
- **Question:** Which observable defaults apply to Visual, API, Data and Integration gray areas?
- **Options:** Hide missing capabilities or infer success; widen generic mobile authority; preserve truthful availability and exact ownership.
- **Chose:** Preserve truthful unavailable presentation with no successful mutation; keep terminal as the default rather than an unavailable chat view; do not persist pretend voice/model choices. Only authenticated connection/device/worktree/tab authority may access a future stream or chat resource. Errors cannot delete credentials or manufacture completion. Stale identity, hidden/unmounted view, disconnect, takeover and revoke must invalidate future Native delivery/control; no background capture or cross-consumer ACK/input. Keep direct LAN/tailnet E2EE, existing literal method/page grants and current phone rendering unchanged until the actual owning contracts exist.
- **Why:** These resolve loading/empty/error/interaction, auth/versioning/errors, mapping/persistence/idempotency and conflicts/lifecycle without extending the requested scope or weakening existing security. Layout density, pagination and rate-limit tuning do not create the missing product authority or Native pixels.
- **Evidence:** docs/loop/decisions/sb-mobile-app.md D2,D5,D6; docs/loop/decisions/sb-mobile-app-prerequisites.md D4,D7; external mobile.md flows7,9 and Edge cases and failure behaviour.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Newly authorized producer contracts change the supported consumer behavior.
- **Source:** assumed — autonomous

## D5: Current producers do not remove either prerequisite
- **Question:** Did current code supply a genuinely reachable core flow despite the inherited deferral?
- **Options:** Assume all APIs absent; repurpose existing background primitives; inspect actual producers and retain precise distinctions.
- **Chose:** Recognize real structured create/messages/send/options as existing background APIs, not interactive product authorization. Recognize phone Browser frame/control as explicit Chrome CDP Watch, not Native. Native metadata and sandboxed evaluation exist, but no capture/snapshot/screencast declaration is present in the inspected current Native adapter or installed public BrowserView. No authorized later chat/dictation ruling was found in the binding sources or decision search.
- **Why:** Missing mobile glue is normally implementable API growth; that is not the blocker here. The remaining chat/voice scope explicitly contradicts locked product decisions, and Native mirroring cannot generate actual Native page pixels through the supported current contract.
- **Evidence:** MobileRulingPrereqs completed read-only report; plugins/quirky.structured/quirky-plugin.json:1-236; plugins/quirky.mobile/src/daemon/authorization.ts:8-52,223-230; packages/protocol/src/mobile-browser.ts; plugins/quirky.browser/src/runtime/driver.ts:886-943; packages/ui/src/native-browser.ts:52-64,760-807; apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserView.ts:269-274. Specialized capture/snapshot/screenshot/screencast search returned no matches in the latter BrowserView and Native adapter; one optional client-directory search path was missing and supplies no evidence.
- **Reversibility:** medium
- **Confidence:** high for current inspected contracts and exclusions; no native/runtime behavior pass claimed
- **Revisit if:** An authorized scope amendment or supported native page-frame/control contract lands.
- **Source:** assumed — autonomous

## D6: Block the complete remainder without a duplicate follow-up or product mutation
- **Question:** Should any independently reachable flow land, or does the claimed core require blocking?
- **Options:** Re-land shipped terminal/ask/Watch work; add another identical prerequisite item; preserve this complete remainder on its blocked branch.
- **Chose:** Block sb-mobile-chat-voice-native-ruling before implementation. Preserve the combined logic spec and decisions on blocked/sb-mobile-chat-voice-native-ruling; publish the exact blockers only through the canonical queue controller. No runtime code, tests, grants, schemas, native scenarios, dependencies or shipped docs change. No tests/typecheck/review/dogfood were run because no behavioral change is made.
- **Why:** Every requested remaining flow depends on either prohibited product scope or the unavailable supported Native producer. Existing terminal/ask, Sleep/recovery, origins, Markdown and explicit Watch are already shipped and expressly excluded from this item; none can be delivered again as a convenient subset. An identical follow-up would only move the blocker.
- **Evidence:** Combined docs/quirk/specs/2026-10-28-sb-mobile-chat-voice-native-ruling/logic.md acceptance matrix and unblock section; D2-D5; canonical LOOP Blocking an item.
- **Reversibility:** easy (requeue the preserved branch after a real prerequisite changes)
- **Confidence:** high
- **Revisit if:** The authorized product ruling and/or supported Native producer becomes available; independent categories can then be built without falsely completing the remainder.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Prerequisite investigation and combined logic-spec self-review complete. MobileRulingPrereqs returned; no worker, service, test, review or native operation remains running. No requested core flow is reachable under current locked scope and public Native capabilities. Next: commit these two records, rename to blocked/sb-mobile-chat-voice-native-ruling, detach, and publish the external blocker with the absolute canonical queue.ts block command. End the iteration after that one blocked item without calling wait again or printing the global blocked sentinel (wait returned item, not stuck).
