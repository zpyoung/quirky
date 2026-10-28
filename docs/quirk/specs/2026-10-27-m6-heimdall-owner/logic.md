# Heimdall optional owner layer

## Status & amendments
Status: Approved autonomously under LOOP.md night mode. One logic spec with technical decisions; no separate tech.md or spec review.
Amendments: 2026-10-27 — D7 adds opt-in authenticated plugin lifetime on public structured create/resume, required because plugin contexts are revoked before deactivate. Native worker/independent session lifetime stays unchanged.

## Purpose and conceptual model
A watcher remains deterministic on its happy path. An optional resumable Claude owner is woken only to handle a typed deviation. The journal records the deviation, issued brief/report identity, session and intervention outcome. Ownership is not the shadow judgment service and never bypasses ordinary gates.

## Scope and non-goals
Owner configuration, kind deviation handoff, common and kind-specific interventions, owner silence recovery, worker idle/silent detection and exact owner escalation answers are in scope. No judgment, objective/hosted-review policy, leases, remote fleet, new UI or native scenarios. The owner is configurable through the daemon API and generated CLI; UI picker belongs to objective enrollment. Source defects about hidden operator-edits and rejected plans must remain visible as deviation detail/brief and inspectable journal, rather than disappear into a generic held reason.

## Alternatives and rationale
Recommended: modules within the existing quirky.heimdall built-in, using context.call for structured sessions and orchestration. Keeps runner gates/journal authoritative. A separate owner plugin would require cross-plugin access to the kernel's private state; embedding owners in kinds duplicates timeout, dedupe and capability rules. Both are rejected.

## Data flow
Enrollment optionally carries owner {agent: claude, model?, effort?} and a separate owner-intervention capability (off/gated/on, default off). Kind decisions and worker scans produce typed deviations with stable natural keys. The owner step folds each deviation into owner-deviation:<watcherId>:<naturalKey>, issues a bounded brief and private report path, creates or resumes/sends to one structured conversation, then waits without blocking ticks. A ready call accepts only the current issued report identity and validates the bounded JSON. The resulting action still passes owner-intervention and native capability/approval/preflight checks before any write-ahead execution. Invalid reports stay visible and have no effects.

## Decisions locked
- API/CLI output and errors: discriminated refused/accepted/held/applied states, explicit malformed/oversize/stale report errors; no success from uncertainty.
- Owner selection: Claude only per source even though M5 supports Codex. Preserve exact optional model/effort through the public structured create API.
- Mapping/idempotency: all thirteen source deviation kinds; required stable naturalKey; journal folds exact keys, never repeated wake for an already resolved key. New evidence uses a new key. One outstanding owner turn per watcher; other deviations remain durable.
- Authority: private issued report path and opaque report key, never a caller-supplied path. Validate report max64KiB and bound brief state32KiB by UTF-8 bytes. No arbitrary shell evaluation of reports. Common worker effects target only that watcher's recorded dispatch identity.
- Gates: independent owner-intervention plus native capability, ordinary exact approvals, stale evidence and write-ahead uncertainty. Kind-specific intervention is translated by the registered kind's own hook. Off cannot be bypassed by continue or a control command.
- Recovery: persist issue before create/send. Lost create/send reply is uncertainty, not permission to duplicate the turn. Persist native conversation/session; after daemon restart resume through structured/resume, never silently start a replacement conversation.
- Timing: idle at verified prompt for120000ms => stall/idle; no mailbox progress900000ms => stall/silent. Grace recheck capped15000ms. Owner silence900000ms => re-wake once; another900000ms => park owner-escalation. Pause/disarm/shutdown never launch new owner turns or effects; human answer targets exactly the current owner escalation.
- Native lifetime: owner create/resume use `lifetime: plugin`. Structured derives the creating plugin from authenticated caller identity and stops that live owner connection after the creator is disabled/removed; independent sessions remain usable. Daemon shutdown continues to stop all native structured connections through the structured plugin's own teardown. Historical native conversation records remain resumable; each resumed live owner connection explicitly binds its current creator.
- No owner: prose question in final paragraph (question mark plus interrogative/choice cue) => worker-escalation with messageId prose-question:<idleSinceMs>, park. Otherwise record deduplicated worker-idle only; uncertain observation never proves idle/exit.
- Platform: portable Bun/TypeScript; verification macOS only. Linux/Windows lifecycle verification deferred: platform.

## Behavior and acceptance scenarios
Every flow is exercised through the daemon API or generated quirky CLI with isolated HOME/QUIRKY_HOME, a fixture kind and scripted structured provider. Tests must not call paid models or touch real profiles.

### AC1 Optional owner configuration
Before: unowned enrollment. Enroll with Claude/model/effort and explicit owner-intervention mode. After: settings persist/restart and inspect reports them; unknown harness, invalid effort/config and unsafe extra keys refuse. Unowned watchers continue without an owner process.

### AC2 Deviation handoff, dedupe and explanations
Before: kind reports check-failed key check:abc with detailed output. After: exactly one open owner-deviation escalation, bounded brief includes actual failure; repeated ticks fold/no repeated turn. A new evidence key yields a new deviation. All report-rejected/node-failed/retry-exhausted/worker-question/worker-escalation/worker-unverifiable/worker-exited/check-failed/review-blocked/landing-failed/plan-failed/gate-held/stall types are accepted; unknown types rejected. Hidden operator-edit and rejected-plan details remain readable in inspection/brief.

### AC3 Issued report and intervention boundaries
Before: outstanding issued report. Write <=64KiB JSON and submit ready with watcher/report key. After: exact report accepted once; stale keys, unknown intervention, invalid fields, traversal/symlink report, oversize/malformed report fail with no worker/action effect. Report path is issued privately and not accepted from the caller.

### AC4 Common interventions and gates
Before: a valid report for continue, ask-human, abandon, answer-worker, stop-worker or message-worker. After: continue resolves current deviation; ask-human parks with exact question; abandon disarms without killing unrelated workers; answer/message/stop affect only exact enrolled-run dispatch. Owner mode off blocks every intervention; gated requires exact scope approval independently of native capability. Native off/gated and preflight holds still hold; owner on never bypasses them. Attempt is durable before external effect and indeterminate outcome cannot be blindly replayed.

### AC5 Kind-specific interventions
Before: kind declares owner translation hook returning its native action. After: owner report maps through that public namespaced hook, then native gate/preflight/execute. Missing hook/unknown action explicitly refuses. No private kind imports or new policy in the owner layer.

### AC6 Owner conversation and silence
Before: first deviation. After: structured Claude create receives model/effort and brief, later deviations use same live session. Restart resumes captured native conversation through public API. At15min silence one reminder is sent; after second15min park owner-escalation, no third wake. Exact answer-escalation feeds human reply to same owner flow; another escalation ID refuses. Shutdown stops owned owner sessions and pending operations without closing worker terminals.

### AC7 Verified worker idle and silent progress
Before: worker at prompt since T. At T+119999 no deviation; at T+120000 one stall idle with stable key. Activity resets grace; unverifiable/stale/identity-changed signals never become idle. Dispatch with last progress T stalls silent at T+900000; mailbox progress moves boundary. Detection survives restart using journal evidence, not process-only counters. While grace runs recheck no later than15s.

### AC8 No-owner prose question fallback
Before: unowned worker idle past grace with final paragraph 'Which option should I use?'. After: park-worker-escalation with prose-question:<idleSinceMs>, one durable escalation. Non-question final paragraph only records worker-idle. Earlier question followed by final declarative paragraph does not park. Repeated observations do not spam or infer worker failure.

## Industry insights
No research swarms under night mode. Grounding: external heimdall.md owner layer and stall section; roadmap plugin/parity constraints; architecture background structured sessions; m6 core D3/D8/D10 public method hooks, service authority and fenced control seam.

## Deferred ideas
Judgment and concrete kinds remain separately queued, not voluntary omissions. UI picker/owner detail presentation is not this API slice. Linux/Windows verification: platform.

## Glossary
Deviation: typed non-happy-path evidence with stable natural key. Intervention: bounded owner-authored JSON proposal, not authority. Brief: bounded state and current deviation sent to owner. Report key: opaque issued identity binding a single report slot. Native gate: existing action capability/preflight. Idle: positively observed prompt wait, not missing output. Silent: no mailbox progress for15min.

## Technical decisions
Use existing KernelStore journal facts for durable issue/session/report/intervention states; optional owner fields on enrollment persisted by its JSON row. Owner modules live under plugins/quirky.heimdall/src/owner/. Shared owner/contracts.ts committed before workers. Parent owns core contracts and runner/service/manifest/registry/enrollment integration. Worker A owns runtime.ts and runtime.test.ts; Worker B owns detection.ts and detection.test.ts; Worker C, if needed, owns integration tests only after APIs stabilize. No concurrent overlapping writes. OpenAI omp task implementers; Opus unavailable by actual alias probe; Gemini google/gemini-3.1-pro-preview high is cross-family reviewer fallback. Two independent components in one wave, cap3. No worker builds/lint/tests/formatters mid-flight; parent executes tests after barrier. Parent uses real daemon/CLI smoke, affected plugin suite, scripts and typecheck once before final review/land. Incoming core/controls branches are true dependencies; merge pending branches and wait for queue readiness in this same turn. Preserve current landed structured runner when stale dependency history conflicts. Protected loop paths and external research remain untouched.

Self-review: all owner-source flows covered by AC1-8; source-wide fleet/controls/kind UI findings outside the owner slice are explicit. Runtime acceptance evidence is required before completion; no placeholders or human questions.
