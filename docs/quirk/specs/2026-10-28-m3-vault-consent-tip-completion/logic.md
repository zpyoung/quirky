# Vault consent marks the search tip seen

## Purpose
Complete ancillary SC-07: successful local search opt-in marks the documented agent-session-search feature tip seen. This is real durable state consumed by the Vault UI, not a marker with no consumer. It never authorizes indexing.

## Scope and non-goals
Own the Vault search tip, its read-only API/CLI state, its existing consent-card presentation, and success/failure/restart proof. Do not add a generic onboarding system, a new plugin, separate promotional cards, arbitrary tip registration/dismiss/reset methods, new remote consent semantics, or the other flows assigned to m3-vault-parity-completion. Do not change the search worker, index format, authorization model or source discovery.

## Conceptual model and data flow
Vault is the canonical owner of its single documented agent-session-search tip. A durable seen bit starts false and transitions only to true. Reading that bit neither starts the scanner nor opens the search database. When the local consent API successfully persists/applies enabled policy and confirms enabled status, it commits seen before returning success. A committed-state event refreshes any mounted UI. A cold UI reads the owner; it does not infer state from localStorage or search being enabled.

## Key decisions and rationale
Use the existing Vault daemon store/API rather than invent an unconsumed marker, import Mobile onboarding, or build a cross-feature registry. Consume the state in the existing full-disclosure consent card: unseen uses the documented feature-tip copy; seen uses the ordinary consent copy. One disclosure/control avoids duplicate promotions. Tip bookkeeping is not a permission check.

## Decisions Locked
- **Ownership:** Vault owns this one tip. Any future global owner must migrate this canonical record.
- **Scope:** Only a successful local portion of setSearchEnabled(true) marks it. Remote-only, disabled policy, display, reads and generic setting writes do not mark it.
- **Consent:** Existing explicit opt-in and full unredacted/local/client-access/tool-output disclosure remain. Seen never implies enabled.
- **Persistence:** Repeated enable is idempotent; disable, clear and restart preserve seen. No automatic migration from enabled policy.
- **Failures:** Invalid params and policy/settings failures leave unseen unchanged. Tip-store write failure rejects the enable with actionable error and rolls policy back off using existing rollback rules, even when policy was already enabled before the request; do not falsely report success. A prior seen record is never cleared.
- **UI:** Unknown tip state shows the normal disclosure; it does not flash an assumed unseen promotion. Failure to load the tip does not remove consent controls. A successful enable retries the active query by the existing search-state effect.

## Behavior and acceptance criteria
### A1: Unseen tip has a real owner and consumer
**Before:** Fresh private home, absent search policy, transcript containing privatezebramarker, unseen tip.
**Walkthrough:** Read the public tip API/CLI; open local history.
**After:** The owner returns id agent-session-search and seen false. The existing full-disclosure card has title Search every agent session, description Find any past conversation by what was said in it, then pick up where the agent left off., and button Turn on session search. Merely reading/opening creates no search database and full-text queries remain disabled.

### A2: Successful local opt-in marks seen and retries the query
**Before:** A1 with an active transcript-only query.
**Walkthrough:** Click the disclosed opt-in action, or call the same public local enable API.
**After:** Policy is enabled, the tip reads seen true, and the active query returns the owned transcript. Other mounted windows observe the committed state. Repeated enable does not undo state. Restart preserves enabled policy and seen true.

### A3: Disable and clear retain seen without hiding consent
**Before:** Successful local enable with seen true.
**Walkthrough:** Disable; remount the history window; then explicitly re-enable and confirm clear.
**After:** Seen stays true. Local off-state shows the ordinary Enable full-text search? disclosure and Enable action, not the promotional tip. Clear leaves search off and derived data absent without deleting originals or resetting seen. The user can still explicitly re-enable.

### A4: Rejected enable never consumes the tip
**Before:** Unseen tip and local disabled policy.
**Walkthrough:** Submit invalid enable input; separately induce a real settings/policy application failure before a successful enable.
**After:** Each operation rejects, local enabled remains false, tip stays unseen, and no content becomes searchable. The UI retains its disclosed opt-in and actionable error. A subsequent genuine successful enable may mark seen.

### A5: Remote-only success is not local consent
**Before:** Local off/unseen, a registered host fixture capable of successful remote enable.
**Walkthrough:** Enable that host only; then enable a selection including local.
**After:** Remote-only result leaves local tip unseen and local search off/no DB. The successful local portion marks local seen, even if a different remote host fails.

## Source defects
The source feature doc lists no tip-specific defect. The recorded Quirky review defect X2 is missing bookkeeping despite explicit SC-07; A1–A5 cover it. Existing no-index-before-consent boundary is retained, not weakened.

## Industry Insights
No external research swarm: this is a bounded internal ownership change; source feature ai-vault.md:12,50-61 and current Vault patterns are the evidence. Source surveys found no generic tip consumer; an isolated marker would not complete observable behavior.

## Deferred Ideas
No new scope. Other Vault parity flows retain their existing queue owner. Cross-feature tip registration/promotion is not needed for this item.

## Glossary
- **Seen:** The documented promotion is satisfied by a confirmed local search opt-in; not a search permission.
- **Consent card:** The complete privacy disclosure and explicit enable control, which remains available whenever local search is off.
- **Tip consumer:** The existing card changes promotional copy using canonical daemon state.

## Verification evidence
- A1–A5: search-tip.test.ts passes8 real daemon/API/CLI cases60 assertions: unseen/no DB; malformed durable JSON; local enable/query/restart; repeated enable/disable/clear; invalid enable; real worker failure/recovery; real tip-store failure/rollback; remote-only versus local/all enable.
- A1–A3 consumer: focused SC-07 window test passes19 assertions, including active-query retry and cold-window ordinary consent after disable. The test exposed and closed a raw-status-event/envelope mismatch; diagnostic output and before/after results are in D5. React unmount warnings remain disclosed.
- Actual packaged surface: guarded web report `.quirk/using-apps-like-a-user/runs/20261028T111325-20fc/report.md` passes the full tip-consent goal in6 actions, with no findings/gates/test overrides/kept-open windows/cleanup errors. This is web evidence, not Native proof.
- Required gates: complete affected Vault suite16/16files with no retries; scripts68pass582assertions; final root typecheck exit0 after4 test-consumer typing corrections; full build29plugins25UI modules exit0 with icon/release-URL warnings. Native-only behavior is unchanged, so no new native scenario is needed.

## Status & amendments
Status: Autonomous design accepted under LOOP.md; reviewed by Codex promote/refute. Parent rejected five scratch-copy-relative prepass path findings because the original sibling logic links resolve. One rollback wording claim was refuted; wording nevertheless made explicit. This same-family review has reduced independence and suppressed its sole model claim, not a clean cross-family assurance. Tech spec required by LOOP and daemon/window boundary.

**Amendments:** 2026-10-28: Explicitly state existing fail-closed rollback also disables an already-enabled policy if a subsequent requested enable fails to persist tip state; no new permission is inferred.

2026-10-28 operator policy: all in-scope behavior is implemented, including the confirmed whole-store rollback repair (focused RED then GREEN before the stop). Subsequent suites/review/dogfood are intentionally not run; typecheck and authoritative landing are the only remaining gates. Earlier broad verification evidence predates that final repair. Final review qualifications and the rejected X1 refutation are recorded in the item decision log D9–D11. No new follow-up is needed for an unbuilt flow.
