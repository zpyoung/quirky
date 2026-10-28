# fix-terminal-dock-unfinished-flows-20261027 decisions

## D1: Retain every named deferred flow as the repair acceptance contract
- **Question:** what remains to deliver after the operator-approved core landing?
- **Options:** narrow to the obvious card defect; complete every flow named by the queue item.
- **Chose:** complete SC14/15 visible session controls and safe refusal; SC16 card interaction/refresh; SC06/08 feature-toggle focus, disable and auto-open; SC04/05 measured rows/hysteresis; SC09/20/21 visible interruption and draft preservation; SC12 acquisition/paste/drop/removal and native handoff; SC02 shell pane menu negative; SC03 direct hook-ended and whole-PTY exit. Existing full dock specs remain normative. Fix-item workflow skips new brainstorming/specs.
- **Why:** the original D33/D40 deferred exactly these flows, not their requirements. User requires one queue item, unattended decisions and no asks.
- **Evidence:** docs/quirk/specs/2026-10-27-m3-terminal-dock/logic.md; docs/loop/decisions/m3-terminal-dock.md D33/D40; authoritative queue title.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public-flow evidence identifies a locked architecture conflict.
- **Source:** locked by docs/loop/LOOP.md fix-item workflow and m3-terminal-dock D33/D40

## D2: Use isolated runtime state and retain native tool limitations explicitly
- **Question:** how to reproduce browser and native acquisition failures without affecting real sessions?
- **Options:** normal user profile; private daemon/HOME with owned deterministic terminal processes.
- **Chose:** fresh temporary HOME and QUIRKY_HOME; no writes to real agent directories; owned processes cleaned after proof. Web-only unattended dogfood. Native OS-dialog scenario remains a native handoff, not a fabricated web pass; inspect the existing blocked native report and reset its status only when an actual fix justifies rerun.
- **Why:** locked loop safety/platform rules; prior native run opened the panel but its driver could not deliver keys.
- **Evidence:** docs/loop/native/m3-terminal-dock.json; terminal-dock feature document; LOOP.md verification rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** current web/native capabilities supply new actual evidence.
- **Source:** locked by docs/loop/LOOP.md; deferred: platform (Linux/Windows remain untested)

## D3: Pair OpenAI implementation with reachable Gemini review
- **Question:** which cross-family reviewer is available on this omp lane?
- **Options:** Opus; next cross-family Gemini; same-family review.
- **Chose:** OpenAI task implementers and Gemini review via pi-watch. Preflight found Opus/Sonnet/Fable/Haiku unavailable and Gemini/Flash reachable. No review result claimed yet.
- **Why:** required pairing with actual availability evidence.
- **Evidence:** pi-watch --check output during this iteration: Gemini google/gemini-3.1-pro-preview:high, Flash google/gemini-flash-latest:medium; Anthropic aliases unavailable.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual Gemini dispatch fails.
- **Source:** assumed — autonomous, following LOOP.md model pairing

## Progress
Claimed in iteration 6 on build/fix-terminal-dock-unfinished-flows-20261027. Read current authoritative LOOP, queue title, original feature/spec and decision log; read native blocked acquisition report. Root-cause mapping is running read-only; no implementation or verification result yet. Next: split disjoint source ownership, reproduce and repair, run actual private daemon/browser flows, affected gates, catch-up/review and queue land. No human asks or protected queue/loop edits.
