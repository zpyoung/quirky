# Shared structured runner and checks

## Status & amendments
Status: Autonomous design accepted under LOOP.md; Codex promote/refute reviewed, confirmed findings addressed. Tech spec: requested (cross-subsystem and required by loop).

**Amendments:** 2026-10-27 — initial design, decisions D1–D10 in [item log](../../../loop/decisions/m5-structured-runner.md). Codex review clarified single-owner resume and ask ownership cleanup on plugin shutdown (D12–D13).

## Purpose
Provide the native conversation and bounded command-execution seams that unattended automation, loop and objective plugins consume, without hidden PTYs or duplicated check-process implementations.
## Conceptual model

Background work uses structured sessions rather than hidden terminals. Claude and Codex share Quirky session records, message journals, status and permission asks, but retain their native transports and conversation identities. Codex speaks app-server JSONL, never exec JSON. A completed turn is not an exited process: consumers may send another turn or resume the conversation later.

Checks are separate shell commands, not agent turns. A shared public checks plugin returns bounded evidence; automation, loop and objective policies decide whether/when to run it and what its result means.

## Data flow
Create resolves model/options through the existing agent catalog before registration, saves the applied snapshot, then starts the selected native runner in the resolved workspace. Provider identity is captured through the session API. Messages append to the structured journal; status and settled events identify the actual provider. Permission requests travel through asks and the native reply resumes or denies the operation.

Resume reads the old session, captured provider identity, original folder and stored structured launch options. It creates a new Quirky session pointing at the same provider conversation, with the original launch snapshot and resumedFrom. Old history is untouched. This works after a daemon restart; no in-memory map is the source of truth for resume.

Checks run a command in the selected directory, stream bounded tails, enforce the timeout, and return normalized evidence. Cancel and plugin shutdown stop the whole process group.

## Key decisions & rationale
Native app-server behind the existing runner contract is the recommended approach. An exec JSON adapter lacks bidirectional approvals and violates the locked architecture; the terminal harness allocates a PTY and cannot supply structured lifecycle semantics. A shared checks plugin, rather than duplicated process helpers, lets every consumer use the public plugin API. Decisions and alternatives are recorded individually in D3–D8.

## Decisions Locked
- **Scope:** shared seams only. No new chat view, scheduling or automation/loop editors. Background agents are structured; interactive agents remain terminals. Locked by roadmap/architecture.
- **Input and precedence:** existing catalog model/options and native defaults; raw structured extraArgs refused. Resume replays original options and snapshot. Locked by m1-launch-settings.
- **Output:** append-only messages and actual-provider settled events; completion, approval waits and process exit remain distinct. Assumed — fast-tracked.
- **Recovery:** resume creates a new record in the original cwd and requires native identity; no silent fresh-start fallback. Unsupported fork/options are refused explicitly. Assumed — fast-tracked.
- **Approvals:** asks through existing daemon auth; denied/cancelled/unrecognized answers fail closed. Transport failure is exited, never done. Assumed — fast-tracked.
- **Checks:** common run/cancel API; caller owns policy, default choice and retention. 4000-character stream tails, timeout 1..600 seconds, nonzero/abort/timeout never pass. Assumed — fast-tracked except source-locked tail/timeout behavior.

## Behavior & scenarios
Each AC must have a daemon API or generated CLI test. Provider tests use isolated scripted transports/SDK seams, not paid model calls or real home state. Process tests use fresh temporary QUIRKY_HOME and remove everything they start.

### AC1: Launch Codex without a terminal
Before: a worktree and no structured session. Call structured/create with agent codex and prompt "Summarize". The subprocess completes initialize/initialized, thread/start, then turn/start in the workspace. After: kind structured, agent codex; no PTY; streamed assistant/tool/result evidence is journaled; success settles done with agent codex. Claude creation remains supported; another agent fails before any session is registered.

### AC2: Continue an idle or active conversation
Before: an idle Codex thread whose first turn completed. Send "Continue". After: a new turn starts on the same thread and the user message appears once. During an active turn, send "Focus on tests"; turn/steer uses the current expectedTurnId. A refused send must not be recorded as accepted or leave the session falsely working. Stop during startup or active work prevents later activity and leaves no subprocess.

### AC3: Answer approvals from the API
Before: Codex asks to execute a command or apply a file change. After: session waiting and an ask attached to that session; API allow responds with the correct native accept decision, deny/cancel responds with decline. Multiple pending asks cannot resume working until all resolve. Unsupported server requests get explicit protocol errors instead of hanging. Removing a session or disabling the plugin cancels pending asks and terminates the runner.
Plugin-created approval asks belong to their creating plugin. Disabling/removing the owner cancels its pending asks; ask-plugin shutdown cancels plugin-owned approvals before its store closes. User-created asks retain their existing persistence semantics. Ownership is private ask metadata, not a new visible permission.

### AC4: Persist and resume both native providers
Before: Claude emits native session ID or Codex starts thread T; providerSession is stored. Stop its runner or restart the daemon, then call structured/resume (or session/resume) with the old session. After: a different Quirky ID, resumedFrom old ID, same original cwd/worktree/provider conversation and launch snapshot; Codex uses thread/resume, Claude SDK uses resume. An optional prompt starts a turn; otherwise send starts one later. The old record/journal is unchanged. Missing identity, missing folder, unsupported provider or fork refuse explicitly. A failed native resume never turns into a fresh conversation. A native conversation has at most one connected Quirky owner: resume while the original is connected or another resume owns it is a conflict, including concurrent calls; stopping/exiting the owner releases it.

### AC5: Apply model and effort exactly once
Before: choose a catalog-supported model and effort for Claude or Codex. After create: native SDK/protocol receives those fields, stored launchSettings describes the same selection, and resumed sessions replay them even if defaults change. Unset options are not injected. Invalid effort/model fails before launch; extraArgs remains refused. This is the regression for launch-settings' snapshot-versus-command disagreement: the one resolved selection is both executed and recorded.

### AC6: Surface runner failures honestly
Before: child fails to spawn, exits, sends malformed JSON or a request returns an error. After: diagnostic journal evidence, exited status, rejected pending operations and no surviving child/ask. Failed or interrupted turns do not publish successful done. Normal turn completion keeps the app-server available. Unknown notifications may be journaled/ignored without inventing completion.

### AC7: Execute shared checks in the requested location
Before: an isolated workspace contains marker A. Call checks/run with a shell command that reads A, writes stdout and stderr, exits 0. After: ran true, pass true, exitCode 0 and both tails; no session or PTY was created. A command exiting 7 returns pass false and exitCode 7 with diagnostics intact. Worktree selectors and explicit absolute cwd are supported; conflicting selectors or missing/non-directory cwd fail explicitly.

### AC8: Bound and decode check evidence
Before: a check writes more than 4000 Unicode characters to each stream, split across byte chunks. After: the last 4000 decoded characters of each stream with independent truncation flags; no split UTF-8 corruption. Short/empty outputs are preserved. Output volume does not cause unbounded accumulation.

### AC9: Timeout, cancel and shutdown check process trees
Before: a command and descendant ignore TERM or keep stdout open. After timeout: timedOut true, pass false, TERM followed by KILL after 2 seconds, bounded method completion and no live descendants. Cancel by checkId gives aborted true and never pass, including an exit-0 race. Duplicate active check IDs refuse; completed IDs may be reused. Plugin shutdown cancels and awaits its runs. Invalid timeout never launches a process; pre-aborted internal execution never launches. A spawn failure returns ran false, pass false with an error.

## Defect coverage
- Orca headless background paths are terminal-only and loop check execution is copied: AC1/AC7 exercise no-PTY structured/check seams. Full automation/loop product migration belongs to their downstream items because those plugins do not yet exist.
- Launch-settings provenance can disagree with executed flags: AC5 proves native options and stored snapshot share one resolution.
- Check hangs/orphans on timeout/abort and output overgrowth: AC8/AC9 prove common runner invariants.
- Other defects in automation scheduling/history/host ownership, loop product/UI and launch-setting pickers are excluded with their owning product flows below; this slice does not claim to repair them.

## Scope & non-goals
In scope: Codex native runner, Claude/Codex structured resume, native options, shared local check execution and public schemas/CLI groups. No new UI or native-only scenario exists here.

Non-goals: automation CRUD/schedules/precheck-skip policies, loop presets/markers/evaluators/pacing/steering UI, objectives/evidence identity, remote hosts/SSH checks, provider forks, new provider catalogs/model discovery, account management, interactive structured chat. Existing terminal resume and Claude structured behavior remain intact. Windows/Linux acceptance is not claimed.

## Industry Insights
- [Official Codex app-server protocol](https://developers.openai.com/codex/app-server): initialize once, then native thread/turn methods; approvals are server requests and must receive replies. Stable stdio avoids experimental WebSocket transport.
- [Codex SDK](https://developers.openai.com/codex/sdk) suits one-shot jobs; it does not replace the locked rich-client app-server contract.
- [Node child processes](https://nodejs.org/api/child_process.html): detached POSIX children form a process group; pipes and descendants can outlive the direct shell. Timeouts must cover output drain as well as shell exit.

## Deferred Ideas
Downstream product flows listed under non-goals remain owned by their roadmap items. No additional features proposed.

## Glossary
- Provider identity: Claude native session ID or Codex thread ID, distinct from Quirky session ID.
- Turn: one input and its streamed agent work; completion leaves the conversation resumable.
- Check: bounded shell execution producing evidence, not a scheduling/evaluation policy.
