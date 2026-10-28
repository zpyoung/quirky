# Terminal dock with its own composer

## Overview

An opt-in composer below each supported terminal agent lets a person edit a prompt without typing into the agent TUI. The terminal stays visible and remains the fallback. The dock sends terminal input; it does not create a native-chat session. A CLI/API consumer can read and perform every dock action through the same daemon authority.

The requirement is [terminal-dock.md](/Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/terminal-dock.md), subject to [roadmap M3](../../../roadmap.md#m3-agent-extras). The explicit 2026-10-27 ruling includes slash commands and skills, excludes dictation and input-quarantine refusal. It resolves decision D8.

## Scope & non-goals

In scope: feature settings; recognized-agent auto/manual dock lifecycle; fixed gutter and hysteresis; focus and passthrough; independent multiline composer with emphasis, history, slash-command/skill and file pickers; file/image attach, paste and drop; session permission/model/effort controls and context usage; agent question/permission cards; serialized acknowledged PTY sends, cancellation, delivery evidence and draft recovery; bounded persistence, reconnect and split-pane isolation; schema-declared plugin API and CLI group.

Non-goals: native chat or its structured interactive UI; standalone skills-catalog management; microphone/dictation; input quarantine; SSH/WSL implementation and remote-host compatibility; telemetry; Windows/Linux execution. Existing mobile driver ownership must be honored if present and can be represented through the public dock ownership API, but this item does not build a mobile client, pairing or relay. No global agent configuration is edited.

## Conceptual model

A pane has a remembered dock choice, gutter size, draft, history and attachments. Recognition resolves supported terminal agents against the live public catalog without changing canonical `Session.agent`; a persisted identity may bridge transient evidence loss only while the dock remains requested and no confirmed exit exists. The daemon owns durable choices and sending. The terminal plugin owns its pane and the lifecycle of an embedded dock view. The independently replaceable dock plugin owns the composer and feature policy.

A dock being requested is distinct from it being mounted: insufficient pane height temporarily removes the composer without treating that as a manual close. Passthrough exists only while mounted and belongs to the active window reporting that pane's focused host. A send has a queue position, cancellable preparation/body/submit phases and a final delivery outcome; cancellation never retracts bytes already accepted.

## Data flow

Recognized session and status changes reconcile pane dock state. The window renders that state and reports measured geometry and focus through public UI contracts. Composer edits update the pane draft; send snapshots that draft and its attachments into a per-terminal serialized operation. Clear input, body paste and delayed Enter use acknowledged public terminal writes. Screen/status/transcript evidence informs the result. A failed or uncertain operation restores its snapshot before any newer draft; no path automatically resends uncertain text. Other clients receive canonical state changes and cannot overwrite unrelated panes.

## Key decisions & rationale

Choose daemon-authoritative dock state and per-terminal send queues with a terminal-owned embedded view host. Renderer-only state cannot serialize sends from another client; putting the feature in the kernel prevents replacing it as a plugin. The existing public embedded-view pattern avoids importing another plugin's private code or inspecting its DOM. Prior option research is recorded in item D7/D9.

Positive evidence of delivery wins over a stale screen recognizer. Transport acceptance is not proof the agent consumed the prompt. Unknown delivery remains explicit and never triggers a retry. Session controls use session-only supported TUI interactions; a control cannot claim confirmation based only on write acceptance. Claude effort must use its session-only picker action, not the globally persistent `/effort <level>` command.

## Decisions Locked

### Layout and interaction

- Feature default off; auto-open default on; automatic and manual opening only for recognized agent terminals — locked by feature doc.
- Three to fifteen rows, default five; height 80 + 20 times rows; drag step 20 px, handle 6 px; no resize on text edits — locked by feature doc.
- Low-height unmount threshold gutter + 60; remount at gutter + 100; freeze during drag — locked by feature doc.
- Closing is remembered; agent exit is not a manual close. Feature-off is a no-write kill switch — locked by feature doc.
- Focus changes only in the active pane; passthrough dims but does not erase the composer — locked by feature doc.
- Empty draft uses the documented placeholder; picker loading/empty/error states are visible and leave the draft intact — assumed — fast-tracked.

- Pickers and question/permission cards appear above the composer, are bounded by the pane's available height, and leave the compact default five-row editor usable.

### API, CLI and concurrency

- Methods and CLI commands use existing schema registration, JSON/text output and errors. Invalid pane/session/attachment requests fail without writes — assumed — fast-tracked, existing kernel conventions.
- Every draft/picker/history/attachment/question/session-option action has an API equivalent; window commands route through the daemon. Transient selection/cursor state can remain local — locked by roadmap.
- Revision-aware updates prevent stale clients replacing newer drafts; different-pane writes never clobber one another — assumed — fast-tracked.
- A terminal has one serialized send queue across clients. Cancel affects only the requested/current operation; shutdown/exit cancels pending Enter — assumed — fast-tracked.
- No automatic retry after accepted input; errors preserve a recoverable draft and explain what is known — locked by feature doc.

### Data and integration

- Canonical daemon persistence replaces Orca's competing host/localStorage copies. Restore against the same live pane after daemon/window restart; prune retired panes. No legacy Orca localStorage import — assumed — fast-tracked.
- Retain per-pane history limits of 200 entries and 200,000 characters; consecutive duplicates dropped; seed from available user-prompt/status history; bound draft/history/attachment caches to 128 inactive scopes and pin mounted scopes — locked by feature doc.
- Validate persisted panes independently; reject unsafe object keys and enforce bounded row counts. Keep at most 64 records per tab and evict retired panes first — locked by feature doc.
- Skill discovery is read-only, agent-aware and local to the dock. No catalog install/remove/sync operations — locked by roadmap ruling.
- Attachments are real files available to the agent. Browser-upload bytes must be acquired through a public daemon method and stored only under the current Quirky home; never claim a browser fake path is usable — assumed — fast-tracked.
- Session picker controls never write real or isolated global agent settings; unconfirmed changes remain labelled unconfirmed, and unsafe/unrecognized picker states refuse without guessing — locked by roadmap; assumed — fast-tracked for feedback.

## Behavior & scenarios

Each scenario is an acceptance criterion. Every flow has an API/CLI scenario test; actual visible interaction is additionally exercised in the web UI. Isolated fake TUI processes may drive deterministic protocol edges; they must really consume PTY input and produce observable output, not mock-echo RPC calls. All processes use fresh temporary HOME and QUIRKY_HOME and are stopped.

### SC-01: Enable and auto-open

Given feature off and recognized agent panes plus a plain shell, when enabled with default auto-open, then supported agents dock and the shell does not; experimental settings show the indented auto-open setting. Turning auto-open off prevents new panes auto-docking but does not close existing ones.

- **Data before:** **Agent pane** closed; **Shell pane** closed; **Dock setting** off.
- **Walkthrough:** 1. Person enables Terminal dock. 2. Person disables automatic opening and launches another agent.
- **Data after:** **Agent pane** open; **Shell pane** closed; **New agent pane** closed.

### SC-02: Manual toggle and remembered close

Given a recognized agent, when Mod+Shift+K or its context menu toggles the dock, then close sets the remembered manual choice and reopen clears it. The menu exists only while enabled and recognized, with its shortcut label. Remount, status reconciliation and restart do not override manual close.

- **Data before:** **Agent pane** automatically open, draft `review this`.
- **Walkthrough:** 1. Person closes the dock. 2. Window reconnects. 3. Person opens it.
- **Data after:** **Agent pane** open with draft `review this`; manual-close choice cleared.

### SC-03: Agent exit, relaunch and transient status

Given a supported terminal agent, when status momentarily disappears, then the requested dock's identity latch preserves the composer and draft. Eligibility comes from public `quirky.agents/list({all:true})` catalog membership, regardless of installed/enabled state, and applies only to terminal sessions. Identity priority is fresh non-restored status-hook `row.agent` or explicit `programStatus.app`, then managed-launch metadata, then a strict catalog-backed terminal title, then the persisted `record.agent` latch only while requested and without confirmed exit. Ignore restored identity and never mutate canonical `Session.agent`. A confirmed agent/terminal exit clears the latch and undocks without setting manual close; fresh evidence from a relaunch can auto-open when enabled. Transient evidence loss preserves the manual-close choice and draft.

- **Data before:** **Pane** docked with recognized Claude.
- **Walkthrough:** 1. Status disappears. 2. Agent exit is confirmed. 3. A new agent starts.
- **Data after:** **Pane** docks for the new agent; transient loss did not erase draft or preference.

### SC-04: Fixed geometry and drag

Given five rows, when typing multiline text, then gutter stays 180 px and no text-driven PTY resize occurs. Dragging by 40 px changes two rows; clamp to 3..15. Mount/unmount and each applied row change flush one final terminal fit, not intermediate competing sizes.

- **Data before:** **Gutter** five rows, 180 px.
- **Walkthrough:** 1. Person types ten lines. 2. Person drags upward 40 px.
- **Data after:** **Gutter** seven rows, 220 px; terminal is resized for the applied geometry only.

### SC-05: Short pane hysteresis

Given the default gutter, when pane height drops below 240 px, then dock unmounts without changing its remembered open choice; it stays unmounted at 260 px and remounts at 280 px. A live drag freezes this reevaluation.

- **Data before:** **Pane** 300 px tall, dock mounted.
- **Walkthrough:** 1. Resize to 239 px. 2. Grow to 260 px. 3. Grow to 280 px.
- **Data after:** **Pane** dock mounted only after step 3; draft retained.

### SC-06: Pane-scoped focus and selection

Given two docked splits, when a background split mounts or changes state, then focus stays in the active pane. Opening its dock focuses its composer; closing it focuses its terminal. Clicking terminal text while docked preserves selection and returns focus to composer; paste routes to composer. Plain-shell shortcuts are not intercepted.

- **Data before:** **Left pane** owns composer focus; **Right pane** remounts.
- **Walkthrough:** 1. Right dock mounts. 2. Person selects terminal text on left. 3. Person closes left dock.
- **Data after:** **Left pane** terminal owns focus; selected terminal text was not erased; right never stole focus.

### SC-07: Passthrough and its Orca notice defect

Given a mounted composer, when Mod+Shift+P enters passthrough, then keyboard focus goes to terminal, composer is dimmed and reads `Passthrough active — terminal has keyboard focus`. No mobile-device/Take back warning appears unless a real foreign driver owns input. Passthrough belongs to the active window reporting this mounted, focused pane; explicit `set.passthrough` true/false values are absolute, not toggles. Toggling returns focus. Working-to-waiting/blocked/done hook transitions, unmount and agent exit clear passthrough.

- **Data before:** **Pane** mounted, no foreign driver.
- **Walkthrough:** 1. Person toggles passthrough. 2. Hook reports working then waiting.
- **Data after:** **Pane** composer active; no false mobile notice at either step.

### SC-08: Kill switch

Given remembered dock states and a send waiting on delayed Enter, when feature is disabled, then docks hide, focus is not stolen, pending Enter is cancelled and no further dock-originated PTY/state cleanup writes occur while off. Re-enable may reuse remembered state.

- **Data before:** **Send** body accepted, Enter pending.
- **Walkthrough:** 1. Person disables Terminal dock. 2. Submit delay expires.
- **Data after:** **Send** cancelled; no delayed Enter written; preference retained.

### SC-09: Composer editing and keyboard dispatch

Given a mounted composer, when typing, Shift+Enter inserts a newline and emphasis follows Markdown without altering literal text. Enter sends a nonempty draft once. Empty Enter does nothing; Cmd+Enter does normal send, not an invented steer queue. Escape first closes an open picker, otherwise cancels pending submission and interrupts a running turn, or sends raw Escape when idle.

- **Data before:** **Draft** `Review **this**`.
- **Walkthrough:** 1. Person uses Shift+Enter and types `please`. 2. Person presses Enter.
- **Data after:** **Send** contains literal `Review **this**\nplease`; draft cleared into recoverable send state.

### SC-10: Slash commands and skills

Given a supported agent and locally discoverable commands/skills, when `/` opens the picker, then it filters agent-appropriate slash commands and skills, supports keyboard selection and inserts the chosen invocation. No skills is an explicit empty result, not an error; discovery failure is shown and never destroys the draft. The picker overlays above the composer, is bounded by available pane height, and leaves the compact default five-row editor usable. Escape dismisses. Sending a chosen command uses the same acknowledged, serialized terminal send lifecycle.

- **Data before:** **Draft** `/rev`; **Skill** `review` available in the agent's workspace.
- **Walkthrough:** 1. Person opens picker. 2. Selects review skill. 3. Sends it.
- **Data after:** **Terminal** receives the selected agent invocation once; **Skill source** unchanged.

### SC-11: File mentions

Given a workspace, when `@` opens file mentions, then results are workspace-relative and agent-aware. Selecting a path inserts a correctly encoded mention without replacing surrounding draft. Missing workspace, no matches and read failure are explicit. Queries do not traverse outside the workspace through symlinks.

- **Data before:** **Draft** `Check @src/mo`; workspace includes `src/model.ts`.
- **Walkthrough:** 1. Person selects model.ts.
- **Data after:** **Draft** `Check @src/model.ts `, cursor after mention.

### SC-12: Attach, paste, drop and remove

Given file/image input through Attach file, clipboard or drop, when acquisition succeeds, then a named removable chip represents a real daemon-readable file. Existing draft stays. Image sends paste image paths individually, settle 300 ms, then text. Generic files use the agent's supported path mention. Removal changes only the requested chip; acquisition refusal preserves text and reports its reason.

- **Data before:** **Draft** `Explain this`; **Attachments** empty.
- **Walkthrough:** 1. Person drops diagram.png. 2. Sends. 3. A second file acquisition fails.
- **Data after:** **Terminal** sees the real diagram path and text; failure does not erase a newer draft.

### SC-13: Bounded prompt history

Given per-pane history, when Up is pressed on an empty draft or during browsing, then it recalls prior prompts; Down advances and restores the unsent draft at the newest edge. Normal editing exits browsing without losing the recalled text. Consecutive duplicates collapse, newest entries survive the 200-entry/200,000-character caps; available transcript/status prompts seed history without duplicates. Histories never leak between panes.

- **Data before:** **Left history** `first`, `second`; **Right history** `other`; **Draft** empty.
- **Walkthrough:** 1. Person presses Up twice on left. 2. Presses Down twice.
- **Data after:** **Left draft** empty restored; right history unchanged.

### SC-14: Session option controls and context usage

Given an agent whose options can be reported, when opening permission/model/effort controls, then available choices and context usage come from that session's provider/status/transcript, not another pane or a fabricated confirmed value. Preserve the reported `model` even when it is absent from the preset choices; do not replace it with null or a default. A supported change uses the session-specific TUI/option-key bridge; native `/effort` handling remains scoped to the selected session, and while awaiting evidence it reads `Sent to the agent — not confirmed`. Unsupported choices are explicitly unavailable with a reason. No control silently changes global defaults.

- **Data before:** **Session** reports model and context usage.
- **Walkthrough:** 1. Person opens model/effort picker. 2. Chooses an available session option.
- **Data after:** **Session control** shows confirmed report or explicit unconfirmed state; context ring reflects the reported fraction, or unknown when no usage exists.

### SC-15: Claude effort global-settings defect

Given a Claude session and a sentinel global settings file, when selecting Low effort, then use only the documented session-only picker interaction (the `s` action after selecting the option). Never submit a persistent named effort command or press the default-saving confirmation. If the expected picker/session-only action cannot be observed, refuse safely and keep the global file byte-identical. The same boundary applies to model changes.

- **Data before:** **Claude global settings** sentinel bytes; **Effort** medium.
- **Walkthrough:** 1. Person chooses Low. 2. Agent exposes or fails to expose session-only confirmation.
- **Data after:** **Global settings** identical in both branches; effort is session-confirmed or the request is refused/unconfirmed without a persistent fallback.

### SC-16: Question and permission cards

Given a transcript-supported agent that asks a user question or permission, when the request appears, then an overlay above the composer displays the actual question, choices and collapse/dismiss controls; collapsed state has a strip; send is disabled while a card is active. The card is bounded by available pane height and its actions remain usable without covering the compact default five-row editor. Answering uses that agent's real terminal interaction, including sequential questions, and does not send a normal prompt. Dismiss hides only the card, not permission enforcement or the actual pending request. Stale answers are refused; closed/answered requests do not reappear as new cards.

- **Data before:** **Agent question** choose A/B; **Draft** `next prompt`.
- **Walkthrough:** 1. Person collapses and expands the card. 2. Answers B.
- **Data after:** **Agent** receives B; draft remains `next prompt`; resolved card closes and send becomes available.

### SC-17: Send availability and foreign driver

Given no terminal, connecting/recovering/disconnected/offline or ended state, or a foreign client driver lease, when sending is attempted, then no prompt bytes are written and an ordered reason is shown: `No terminal session`, transport reason, then `Mobile device is composing`. Editing and attaching remain available. Local passthrough is not foreign ownership. No SSH/quarantine notice is invented for this local-only item.

- **Data before:** **Pane** foreign driver; **Draft** `wait`.
- **Walkthrough:** 1. Person presses Send. 2. Foreign lease is released.
- **Data after:** **Draft** retained; first request refused; Send is enabled only after release.

### SC-18: Serialized prompt protocol

Given two rapid sends to one terminal, when they execute, then all clear/body/submit phases of the first precede the second. Input clear uses Ctrl+U and Ctrl+K, each repeated 2n-1 where n=min(40,line count+8), chunked to at most 31 bytes with 16 ms gaps. Verified agents wait 140 ms for a screen check and, if uncleared, perform maximal clear before continuing. Single-line text replaces literal Escape with its visible symbol; multiline normalizes endings to CR and uses bracketed paste. Enter is a separate acknowledged write after 500 ms. A refused write stops subsequent phases.

- **Data before:** **Queue** empty; **Requests** `one`, `two\nlines`.
- **Walkthrough:** 1. Two clients send concurrently. 2. TUI records each accepted input phase.
- **Data after:** **Terminal** receives two intact ordered prompts, never interleaved clear/paste/Enter.

### SC-19: Delivery evidence and Codex false-warning defect

Given a verified Claude/OpenClaude/Codex send, when positive screen, matching prompt/status or transcript evidence proves it was consumed, then outcome is observed-cleared and the old prompt is not restored, even if a stale screen recognizer misses. Without evidence, poll up to four times immediately then at 900 ms intervals; four misses mean may-not-have-sent. Other agents use unobservable without a false failure warning. Never auto-resend.

Catalog-recognized agents without one of the eight provider transcript adapters still use the acknowledged generic send path and return `unobservable`, not a false delivery failure. Missing an adapter withholds provider-specific transcript controls; it does not disqualify the terminal from dock recognition or generic sends.

- **Data before:** **Codex draft** `Reply with only PONG`.
- **Walkthrough:** 1. Send is accepted. 2. Codex echoes prompt and answers PONG while an old composer glyph remains on screen.
- **Data after:** **Outcome** observed-cleared; **Draft** empty; no false warning or restored duplicate.

### SC-20: Failure, uncertainty and concurrent typing

Given an in-flight send, when a write is rejected, cancellation occurs or delivery cannot be established, then restore its text and image chips in front of any newer draft, separated by a blank line, and show `Send may not have completed. Check the terminal before retrying.` when input might already have landed. A definite pre-write refusal does not claim delivery. Newer text and chips survive. No automatic retry occurs.

- **Data before:** **Send snapshot** `first`; **New draft** `second`.
- **Walkthrough:** 1. Body is accepted. 2. Delivery becomes uncertain.
- **Data after:** **Draft** `first\n\nsecond`; one warning; only one body was written.

The 200,000-character recoverable-text budget covers the current draft, all queued/in-flight snapshots and their restoration separators together. An edit or enqueue exceeding it is refused visibly without changing acknowledged text; an unsynchronized local edit remains displayed and copyable, never silently truncated. Attachment limits likewise include queued/in-flight chips. A recovery therefore always fits without losing either accepted draft.

- **Boundary example:** **Send snapshot** 150,000 characters; **New draft** 49,998 characters; a blank-line restoration yields exactly 200,000. A further character is refused before acknowledgement, remains visible as an unsynchronized local edit, and cannot erase the stored draft.


### SC-21: Stop and queued cancellation

Given a running agent, current send or queued send, when Stop/Escape cancels it, then queued work never begins, pending Enter is suppressed, and interrupt is sent according to the running agent's public terminal stop behavior. Current accepted bytes are not represented as undone. Cancel affects the selected pane, not another terminal. Terminal exit and plugin disposal cancel outstanding work and settle callers.

- **Data before:** **First send** body written, Enter pending; **Second send** queued.
- **Walkthrough:** 1. Person stops first. 2. Client cancels second.
- **Data after:** **Terminal** no delayed Enter from either; both callers settle with recoverable drafts.

Before waiting for completion, a client can supply its own unique send identifier and inspect queued identifiers. Cancelling the second queued identifier leaves the first operation running; an unknown identifier is an explicit not-found result.


### SC-22: Reconnect, restart and revision conflicts

Given canonical dock state, when a renderer reconnects or daemon restarts, then live-pane state and draft are restored. A stale client revision cannot replace newer text and gets a conflict with current state. Different panes update independently; closing a pane prunes it while rehoming preserves its identity. Malformed persisted entries are ignored individually, unsafe keys rejected and bounded retention enforced.

- **Data before:** **Left draft** `new`, revision 2; **Right rows** 5.
- **Walkthrough:** 1. Old client submits left revision 1. 2. Current client changes right to 7 rows. 3. Window reconnects.
- **Data after:** **Left draft** `new`, stale update refused; **Right rows** 7, both restored.

An explicit or revisionless stale clear is a replacement too and is refused. Recovery-only snapshots survive a daemon crash even with no renderer: a queued prompt and a body-awaiting-Enter prompt return to the draft in original order, with a check-terminal-before-retrying notice. Restart never replays either operation or schedules its old Enter.

- **Crash example:** **In-flight snapshot** `first`; **Queued snapshot** `second`; **New draft** `third`. After crash/restart, **Draft** is `first\n\nsecond\n\nthird`, and **PTY writes from restart** are none.


### SC-23: Scriptable actions and inspectable state

Given a running daemon and window, when a CLI/API client configures, toggles, edits, queries pickers, attaches, browses history, resizes, changes passthrough, reads/answers cards, changes a session option, sends or cancels, then it exercises the same daemon methods the UI uses. The state report includes dock request/mount state, rows, passthrough, draft/attachments, recognized agent, disabled reason, active send and question/options. A non-UI composite `set` containing `passthrough` routes through public `ui.command.run` and `command:quirky.terminal-dock/set` before any mutation; its true/false value is absolute and is checked against the active window's own pane host. Focus resolution uses the exact report fields `focused`, `focusSequence` and `focusedPane` (never `focusWithin`): prefer focused reports, then a unique highest nonzero sequence, then a sole pane candidate; ambiguity or missing window fails explicitly without mutation.

- **Data before:** **Pane** recognized, dock closed.
- **Walkthrough:** 1. CLI opens dock and sets a draft. 2. API reads state. 3. Window applies the state.
- **Data after:** **Reported pane** and visible dock agree; CLI group and command schemas are discoverable.

## Industry Insights

Prior context and option research is retained in decisions D6/D7/D9: [xterm fit/terminal APIs](https://xtermjs.org/docs/api/terminal/classes/terminal/) favor geometry-edge fits rather than per-keystroke resizes; [xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) distinguish bracketed paste from submission; [Readline killing commands](https://www.gnu.org/software/bash/manual/html_node/Commands-For-Killing.html) do not make a transport write proof of TUI consumption. [Claude model configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level) distinguishes globally saved effort from its session-only picker action. These findings determine the send/cancel/geometry and safe-session-option boundaries, not extra features.

## Deferred Ideas

Linux/Windows key encodings and ConPTY verification are recorded as platform work in D5. No extra feature ideas are added. Public API growth and ownership details belong in the sibling tech spec.

## Glossary

- **Requested dock:** remembered open choice, independent of whether geometry permits mounting.
- **Mounted dock:** visible composer consuming the pane gutter.
- **Passthrough:** local keyboard ownership by the terminal, not a mobile lease.
- **Verified tier:** agent with observable delivery evidence; not a guarantee from a successful transport write.
- **Unobservable:** input accepted for an agent without reliable consumption evidence; not a failed send.
- **Skill:** existing local agent instruction invoked through its supported slash picker, not a managed catalog entry.

## Status & amendments

Status: Autonomous approval after the required combined Codex review and confirmed-finding amendments; see item D17/D18. Tech spec required by LOOP.md and subsystem-crossing complexity.

**Amendments:** 2026-10-27 — initial spec incorporates the user's dock-local scope ruling, superseding D8's block. Autonomous design/default approval follows LOOP.md; no human ask is issued.

**Amendments:** 2026-10-27 — Codex spec review F2/F3/F5/F6/F7: all draft replacements require revisions; queued sends have early-known identifiers; write failures distinguish zero/possible acceptance; durable recovery-only snapshots never replay; combined recoverable-text/attachment budgets make restoration lossless. Shortcut-precedence F1 and provider-source F4 are recorded in the tech spec and item decision log.

**Amendments:** 2026-10-27 — F1 requires completing D30's anticipated palette command/shortcut migration into an overridable contribution; shell rendering remains unchanged. Dock-context Mod+Shift+P performs passthrough only; outside that context it opens the palette. No dual dispatch or silent alternate chord is permitted.

**Amendments:** 2026-10-27 — final contract sync records dynamic full-catalog terminal recognition and its evidence/latch boundaries; exact public command routing, focus-report fields and pane/window ownership; compact-editor overlay bounds; reported-model preservation and the session-local native effort bridge. All 23 scenarios and all three Orca-defect requirements remain normative; this amendment is not an implementation-pass claim.
