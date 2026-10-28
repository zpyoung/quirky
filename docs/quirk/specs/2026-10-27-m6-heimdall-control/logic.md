# Heimdall operator controls and fleet

## Status & amendments
Approved autonomously under the unattended night-mode loop. Technical specification is included below. Amendments: none.

## Purpose and conceptual model
Operators need one truthful view of durable watchers and safe controls over their owning kernel. A fleet row is a last-confirmed snapshot, not proof of remote execution. An owner fence identifies the enrollment authority and command revision. A command either applied at a known time, was refused for a specific reason, or has an indeterminate result; a lost reply never means success or safe retry.

## Scope and non-goals
Ship the built-in Heimdall plugin's local fleet/detail/debug APIs, push snapshots, ten serialized commands, CLI management group, two notification transitions, sidebar navigation/counts, fleet table/action history, detail controls/approvals/budgets/workers/traces/activity, worktree status glyph, and debug copy. No New objective sheet, concrete objective/hosted-review algorithms or plan editors, owner-agent runtime, leases, remote mirroring or judgment. CLI kind enrollment forwards to registered kinds; it does not invent their authorization. Existing public plugin contribution APIs only; no private cross-plugin imports. Remote targets are explicitly refused, not treated as local. Native banners are handed off rather than claimed from web verification.

## Alternatives and rationale
1. Recommended: extend quirky.heimdall with an operator layer and use its public RPC methods from CLI and contributed UI. One kernel owns scheduling, storage and command serialization.
2. Rejected: a second controls plugin importing private store/services. Splits transaction/runner authority and bypasses plugin replacement.
3. Rejected: daemon-native Heimdall routes/UI. Violates the feature-plugin boundary and duplicates command semantics.

## Data flow
The operator layer reads enrollments, live runner status and journal projections into monotonically timestamped fleet snapshots. Push replaces older snapshots only. Detail includes pending approvals/questions, real refusal/hold causes and live worker identities. A command rechecks its owner fence inside a per-watcher chain, fences new effects and drains the existing tick where needed, mutates durable state atomically, then schedules reconciliation and publishes. The UI and CLI show the actual command result. Debug reports are bounded diagnostic JSON, not executable recovery instructions.

## Decisions locked
- Visual layout/information density: source column order Workspace, Watcher, Activity, Phase, Status, Active time, Turns, Elapsed, Last tick; sideways overflow. Urgency sort escalated, parked, unreachable/error/unverifiable, held, acting, watching, terminal, disabled; last successful tick descending then name.
- Loading/errors/interaction: keep last confirmed fleet on refresh failure with the source banner. Empty state says No watchers in the fleet. Always-visible Heimdall navigation. Escape detail to list then back. Pending controls disable duplicate submission; delete requires confirmation and explicitly leaves worker terminals running.
- API/errors/authority: discriminated applied/refused/indeterminate; exact owner fence plus revision, local authority only, malformed/read-only fail closed. Ten commands serialize per watcher. Exceptions after dispatch are indeterminate, never falsely applied.
- Scope/idempotency: approval matches actionKind/contentIdentity/evidenceKey/preparedCommitSha exactly. Resume cannot undo explicit disarm or terminal and refuses exhausted budget or pending question. Budget edits accept zero and null, do not implicitly resume. Objective cap integer1..1024 and folders cap1; lowering fences tick first.
- CLI output/flags/exits: human list/show by default; existing global JSON convention respected. debug is bare schema2 JSON, optional --out writes on CLI machine. Manage command names match source; invalid numeric values fail rather than coercing to unlimited. create delegates to registered kinds; explicit flags override spec.
- Notification/recovery: only new awaiting-approval fold1 and transition to terminal, both successive observations live and notifications enabled; delivery failure cannot change watcher state. No notification flood on startup or repeated folded approval.
- Defect visibility: detail always exposes status reason/detail and tick no-action reasons, including operator-edit hold and rejected-plan explanation supplied by a kind, even without an approval card. No special-casing .memsearch or forging a plan explanation.

## Acceptance scenarios
Each public flow uses a fresh temporary QUIRKY_HOME and daemon API or CLI. Focused deterministic tests cover unsafe boundaries; UI scenarios are additionally dogfooded on the actual contributed page.

### AC1 Fleet, detail and push
Before: empty kernel; opening Heimdall shows0 active/0 need attention and empty fleet. Enroll W through a registered fixture kind. After: fleet and detail identify W/authority/revision, budgets/traces/workers; push has a newer generatedAtMs. Older push cannot overwrite newer state. Refresh failure keeps W and displays the error banner. Malformed, paused, disabled, terminal and unreachable remain inspectable.

### AC2 Ordering, buckets and glyph
Before: rows in all eight urgency states, including tick error and unverifiable contact. After: exact urgency order then successful tick descending/name; exactly one bucket per row (Needs you, Lost contact, Active, inactive). Header active excludes paused, disabled, parked and terminal. Worktree row displays its watcher glyph/status, and disappears after deletion. Budget bar warns at80%, unlimited turns render0/∞.

### AC3 Lifecycle and serialized commands
Before: enabled W mid-tick. Pause waits for that tick and prevents a new effect before persisted pause; concurrent command with stale revision refuses stale-revision. Resume works only for paused/automatic-park W with available budget and no question. Explicit disarm cannot resume; terminal cannot resume. Disarm folds open escalations. Delete confirmation cancels harmlessly or removes saved watcher/journal/traces without stopping worker terminals. Missing watcher, foreign authority, malformed/read-only and invalid commands give named refusal details.

### AC4 Exact approvals and explanations
Before: held action scope S, open approval fold1. Approve S acknowledges it, records exact approval, schedules immediate reconcile and shows Applied by the owner at time. Changed scope cannot reuse approval. Approval card shows scope identity/evidence and exact-action warning. Held operator-edit/rejected-plan reasons remain visible even with no card; a supplied reason such as Merge train paused by operator edits: .memsearch/ is shown verbatim. An already-closed approval refuses rather than fabricating success.

### AC5 Budget and concurrency
Before: spent W at budget10. Resume refuses Raise the exhausted watcher budget before resuming. Edit to20 applies without resuming; Resume then works. Edit zero/null, Cancel and turn limits preserve intended semantics. Invalid negative/nonfinite limits refuse. Objective cap1..1024 only; folder caps stay1; non-objective cap refuses unsupported-capability. Lowering waits for tick/fences new starts, does not kill existing workers.

### AC6 Worker controls and answers
Before: pending worker question and exact recorded dispatch/process identity. Resume refuses Answer the pending worker question before resuming. Answer through public orchestration closes that question and un-parks; duplicate answer returns question-already-answered. answer-escalation resolves exact pending owner escalation only. Stop-worker verifies exact worker identity and reports applied/refused/indeterminate; missing/unverifiable identity never kills an arbitrary process. UI offers Stop, question form/Send answer and Open terminal using public UI navigation.

### AC7 CLI and debug
Before: fixture kind registered. CLI list/filter/show, pause/resume/disarm/rm, approve, answer, answer-escalation, budget, set-concurrency, stop-worker all drive the same fenced command path. CLI rejects missing IDs/body and invalid caps/budgets. Debug returns schemaVersion2 enrollment/status/budget/interval/pendingControls/malformed/workers/runner/pointers with at most200 journal entries and20 traces; --out bytes decode to the same report. Copy debug report gives success/failure feedback without exposing a fake copied state. CLI create/objective use public kind APIs rather than hardcoding kind behavior.

### AC8 Trace, activity and command feedback
Before: three consecutive identical gate-held traces19..21 and one changed scope. After: first group Tick19–21 ×3 gate-held; changed trace separate. Saw, Decided including Gate, and Declined shown; Running for unfinished tick; No decision traces yet when empty. Raw watcher activity newest30 first; fleet action history shows actual attempted/settled effect and reason. Applied time, refusal reason and indeterminate detail are visible; debug copy failure leaves watcher unaffected.

### AC9 Notifications
Before: established live snapshots, notifications enabled. New awaiting-approval fold1 emits exactly Watcher approval requested/actionKind is waiting for approval. Terminal transition emits Watcher reached a terminal state/state:reason. Fold2/repeat/startup/unverifiable contact/disabled setting emit neither; notification exception does not affect watcher. Public notification record and routing are verified through daemon API; native banner scenario handed off pending.

## Industry insights
Night mode forbids research swarms. Grounding: supplied heimdall.md Read the fleet, Inspect one watcher, Act on a watcher, Decision trace, Command results, Notifications, CLI, Debug report and Findings; existing public plugin/UI conventions and binding core decisions. No external research claim.

## Deferred ideas
Explicitly excluded source slices only: New objective sheet/concrete kind details, owner agents, leases, remote fleets and judgment. Linux/Windows native integration and notification visuals require platform follow-up. No voluntary in-scope deferral.

## Glossary
Fleet: snapshot of watcher rows. Fence: expected execution host/scheduler/workspace/revision. Park: automatic disabled state awaiting a condition. Disarm: explicit irreversible disable until re-enroll. Scope: exact action/content/evidence approval tuple. Indeterminate: effect cannot be confirmed. Live contact: owner observed, not inferred from stale cached data.

## Technical specification
Type-only src/control-contracts.ts is committed before implementers and imports core types without changing core contracts while dependency is in flight. Operator service receives a KernelControlHost wrapping core store/registry/runner and mutation hooks; no second database. Public methods quirky.heimdall.fleet/detail/command/debugReport plus fleetChanged event. One operation queue per watcher; expectedOwner checked inside queue; pending controls exposed and runner fenced before drain. Parent integrates service/main after the core dependency implementation arrives.

One parallel wave, cap3: T1 control-plane.ts plus its focused tests (all ten commands, store/runner safety hooks); T2 fleet.ts, control-api.ts, control-cli.ts plus API/CLI/notification tests (snapshots, debug, notifications, declarations/registration helpers); T3 ui.ts and ui helpers/tests (public contributed fleet page/sidebar/worktree glyph). Parent owns contracts, integration into core main/manifest/service, spec/decisions/README. Disjoint file ownership; workers do not commit or run build/lint/tests/formatters mid-flight. Parent runs owned commands at barrier, runtime smoke, affected suite, scripts and typecheck once before catch-up/landing. Pending dependencies merged again before final proof. Cross-family reviewer Gemini fallback because Opus/Sonnet probes unavailable. No private plugin imports, protected loop edits or real user profile writes.

Self-review: all included source flows map to AC1..9; concrete enrollment/payload authorization stays kind-owned. Every refusal/unknown outcome has a visible form. No unresolved user questions or placeholder implementation. Core drain/control-fence integration must be proven at runtime before landing.
