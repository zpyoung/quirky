# Chat input redesign

The composer under a chat transcript becomes one card: the message editor, a toolbar inside its bottom edge, and the queue and suggestion list attached to its top edge. It gains `/` commands, `@` pills, live markdown styling, working image paste and a visible Stop, and it stops hiding which mode is active.

The before state, walk and scores are in [current-state.md](current-state.md). This spec is for whoever builds and checks the redesign. It says what the person typing sees and does, not how it's built.

## The model

The composer is **one card** under the transcript in the Structured session view (`view:quirky.session/structured`). Everything about the next message lives inside the card or is attached to its top edge.

- **The editor** holds the message as plain markdown text. Styling, pills and chips are a view of that text. The agent receives exactly the text, plus the paths of any attached images.
- **The toolbar** sits inside the card's bottom edge. Left to right: the agent chip (fixed for the session), the settings chip, mode badges when a mode isn't the default, + for attaching images, then the round action button at the right.
- **Attached above the card**, top down: the suggestion list while `@` or `/` is open (covering what's below it), then queued messages.
- **The action button** has one job per state: Send when idle, Stop while working, and Stop plus Send (queue) once you type mid-turn.

The card has four states that replace each other in place: **idle**, **working**, **ended**, and **idle with a send error**. The same composer serves all four agents (Claude, Codex, pi, omp). It shows what each agent supports and disables the rest, with the reason on hover.

The New chat dialog and the agent prompt dialog keep their own plain box.

## Glossary

- **Composer**: the card under a chat transcript where you write the next message.
- **Settings chip**: the toolbar chip showing model and effort ("Opus · Medium"). It opens the settings popover.
- **Settings popover**: the one-panel popover holding model, effort, permission mode and Plan mode.
- **Mode badge**: a toolbar badge shown only while permission mode or Plan mode is not the default. Clicking its ✕ returns that setting to the default.
- **Pill**: an inline token for an `@` file or an agent `/` command or skill. It is deleted as one unit and sent as its text.
- **Chip**: an attachment above the text: an image, or a long paste turned into a file.
- **Queued message**: a message waiting for the current turn to end.
- **Steer**: hand a message to the agent at its next tool call instead of waiting for the turn to end.
- **Quirky command**: a `/` command Quirky handles itself and acts on at once: /model, /effort, /mode, /plan, /new, /stop, /resume.
- **Agent command** and **agent skill**: `/` entries the agent reports. They're inserted as a pill and sent with the message.

## Screens

The signed-off mock is [mock/mock.html](mock/mock.html), with its inventory in [mock/screens.md](mock/screens.md) and review history in [mock/review.json](mock/review.json). It was approved at v1 with no pins. The mock is the visual target for layout and flow. Its neutral palette is not the product's: the build uses Quirky's tokens.

| Screen | State | Acceptance |
|---|---|---|
| Composer, idle | empty | matches mock: placeholder names the agent and hints `/` and `@`; Send disabled |
| Composer, idle | draft | matches mock: image chip, long-paste chip, `@` pill, faded markdown syntax, code block background |
| Composer, idle | failed | matches mock: draft restored, one-line error under the card with Retry |
| Composer, agent working | running | matches mock: accent border, pulsing dot with elapsed time, round Stop fully visible |
| Composer, agent working | queued | matches mock: queued rows on the card's top edge with drag handles; a steered row shows it's waiting; Stop and Send both visible |
| Suggestion list | mention | matches mock: file list attached above the card, first row selected |
| Suggestion list | slash | matches mock: Quirky, agent commands and agent skills groups, each row marked acts now or sent |
| Suggestion list | no-match | matches mock: "No commands match" line; Enter sends as text |
| Settings chip | popover | matches mock: model list, effort segmented control, permission list, Plan switch, a disabled row with its reason on hover |
| Settings chip | badges | matches mock: chip shows model and effort; Plan and Accept edits badges with ✕ |
| Session ended | default | matches mock: dashed ended card with Resume and New chat; read-only queued row with Delete |

### Open questions from the mock's gaps

These mocked elements have no matching Quirky component yet. The build either adds one to the design system or builds it locally. Either way, each must meet its screen's acceptance item.

- **Composer card**: the card container with an inner toolbar and attached rows above it.
- **Message editor**: the markdown-styling editor with pills.
- **Drag handle** for reordering queued rows.
- **Effort segmented control**.
- **Plan mode switch** with a visible on state.

## Behavior and scenarios

### SC-1 Send a message

- **Given** an idle composer
- **When** you type text and press Enter, or click Send
- **Then** the message is sent exactly as typed, the editor and its chips clear, and the card switches to working. Shift+Enter inserts a new line. Send does nothing while the box is empty or only whitespace.

### SC-2 Enter never sends during IME composition

- **Given** you're composing text with an input method (for example Japanese or Chinese)
- **When** you press Enter to confirm the composition
- **Then** the composition is confirmed and nothing is sent. The next Enter, after composition ends, sends.

### SC-3 Send with Cmd+Enter preference

- **Given** the setting *Send with Cmd+Enter* is on
- **When** you press Enter, then Cmd+Enter
- **Then** Enter inserts a new line and Cmd+Enter sends. While the agent works, Cmd+Enter queues and Shift+Cmd+Enter steers. The setting applies to every chat.

### SC-4 Markdown is styled as you type

- **Given** an idle composer
- **When** you type `**pure**`, `` `useElapsed` ``, a fenced code block, a `-` list or a `#` heading
- **Then** each is styled in place (bold, monospace on a tint, code background, indented list, larger heading) and its syntax characters stay visible but faded. Cmd+B, Cmd+I and Cmd+E wrap the selection in `**`, `*` and a backtick. The text sent is exactly the characters in the editor.
- **Screen states:**

     | You type | You see |
     |---|---|
     | `keep it **pure**` | "keep it" then a faded `**`, bold "pure", faded `**` |
     | `` rename `useElapsed` `` | "rename" then faded backticks around monospace "useElapsed" on a tint |
     | a ```` ```ts ```` block | the block on a code background, fence lines faded |

### SC-5 Mention a file with @

- **Given** an idle composer in a session whose worktree holds `README.md` and `hello.txt`
- **When** you type `Look at @REA`, then press Enter or Tab
- **Then** the suggestion list opens above the card while you type, filtered to README.md. Picking it replaces `@REA` with a README.md pill. Backspace right after the pill removes the whole pill. The agent receives `@README.md`.
- **Data before:** **Draft**: "Look at @REA"
- **Walkthrough:**
  1. You type `@REA`: the list shows ✓ README.md, selected
  2. You press Tab: the list closes
- **Data after:** **Draft**: "Look at " then a README.md pill; ✓ sent text would be "Look at @README.md"

### SC-6 Pick a / command

- **Given** an idle composer in a Claude session that reports /review and /compact as commands and brainstorming as a skill
- **When** you type `/` at the start of the message
- **Then** the list shows three groups, Quirky (/model, /effort, /mode, /plan, /new, /stop, /resume), Claude commands, and Claude skills, and each row says whether it acts now or is sent. (a) Picking a Quirky command acts at once and leaves the rest of your text alone: /model and /effort open the settings popover at that section, /plan toggles Plan mode, /mode opens the permission list, /new starts a new chat with the same agent and settings, /stop stops the turn, and /resume resumes an ended session. (b) Picking an agent command or skill inserts it as a pill. You can type arguments after it, and it's sent with the message. (c) When nothing matches, the list says so and Enter sends the text as typed.
- An agent that reports no commands shows only the Quirky group.

### SC-7 Attach images

- **Given** an idle composer and an agent that accepts images
- **When** you (a) click + and choose a PNG, (b) drop a PNG on the card, or (c) press Cmd+V with a screenshot on the clipboard that has no file on disk
- **Then** each adds an image chip with a thumbnail and a remove button above the text, and sending includes the images. The same image added twice appears once.
- **Given** an agent that doesn't accept images, **then** + is disabled with the reason on hover, and a dropped or pasted image is refused with that reason inline under the card.

### SC-8 Drop a non-image file

- **Given** an idle composer in a session on worktree `demo-repo`
- **When** you drop `demo-repo/src/app.ts`, then a file from outside the worktree
- **Then** the first becomes an `src/app.ts` pill and the second becomes a pill for its absolute path. Neither becomes an attachment.

### SC-9 Long paste becomes a chip

- **Given** an idle composer
- **When** you paste text longer than 2,000 characters
- **Then** it appears as a chip ("Pasted text · 412 lines*") instead of text in the editor. Removing the chip removes the text. Sending includes the full pasted text after your typed message.

### SC-10 Drafts are kept per session

- **Given** a half-written message with an image chip in session A, and Opus chosen for the next turn
- **When** you switch to session B, type there, switch back, then quit and reopen Quirky
- **Then** session A shows its own draft, chip and Opus choice. Session B shows only its own draft. Sending clears that session's draft.

### SC-11 Working state and Stop

- **Given** you've sent a message and the agent is working
- **When** you look at the composer
- **Then** the card has an accent border, the placeholder reads "Queue a follow-up…", and the toolbar shows a pulsing dot with the elapsed time ("Working 14s") beside a round Stop button that nothing covers. Clicking Stop, or pressing Esc in the editor when no suggestion list is open, stops the turn.

### SC-12 Queue and steer while working

- **Given** the agent is working
- **When** you type a message and press Enter, then type another and press Cmd+Enter
- **Then** a Send arrow joins Stop as soon as you type. The first message becomes a queued row on the card's top edge. The second becomes a steered row reading "Steering · waiting for next tool call" until the agent takes it; then it shows in the transcript. When the turn ends, the first queued message sends on its own.
- **Data before:** **Queue**: empty; agent working
- **Walkthrough:**
  1. You type "Then give it a title." and press Enter: **Queue** gets row 1, queued
  2. You type "Keep it under 1000 words." and press Cmd+Enter: it shows as steering, waiting for the next tool call
  3. The agent makes its next tool call: the steered message moves into the transcript
- **Data after:** **Queue**: ✓ row 1 "Then give it a title.", queued; ✓ steered message delivered

### SC-13 Manage queued messages

- **Given** two queued messages
- **When** you drag the second above the first, click Edit on one, click ✕ on the other, or press Up in an empty editor
- **Then** dragging reorders them and they send in the new order. Edit moves that message into the editor. ✕ deletes it. Up pulls the last queued message back into the editor. Steer now on a row steers it.
- **Given** an agent that can't steer, **then** Cmd+Enter and Steer now are disabled with the reason on hover, and Enter still queues.

### SC-14 Queued messages after Stop

- **Given** the agent is working with one queued message
- **When** you click Stop
- **Then** the turn stops and the queued message stays queued and held. It sends only when you click Send next on its row or send a new message.

### SC-15 Change settings from the chip

- **Given** a Claude session on Fable, Low effort, default permissions, Plan off
- **When** you click the settings chip and choose Opus, then Medium
- **Then** a one-panel popover opens above the toolbar with the model list, effort as a segmented control, the permission list and a Plan switch. Each choice applies at once to the next turn, the chip reads "Opus · Medium", and Esc or a click outside closes the popover. If the agent rejects a change, the chip reverts and an inline error under the card says why. The model list gets a search field once it passes 8 entries.
- An agent without effort levels shows the model alone on the chip, with the effort control disabled and its reason on hover.

### SC-16 Mode badges

- **Given** default permissions and Plan off: no badges
- **When** you turn Plan on and choose Accept edits in the popover
- **Then** two badges appear after the chip, "Plan ✕" and "Accept edits ✕". The Plan switch shows a visible on state. Clicking a badge's ✕ returns that setting to its default and removes the badge.
- **Data before:** **Next turn settings**: Fable, Low, default permissions, Plan off; badges: none
- **Walkthrough:**
  1. You turn Plan on: ✓ "Plan" badge appears
  2. You choose Accept edits: ✓ "Accept edits" badge appears
  3. You click ✕ on "Plan": Plan goes off and its badge goes away
- **Data after:** **Next turn settings**: Fable, Low, Accept edits, Plan off; badges: ✓ "Accept edits"

### SC-17 Session ended

- **Given** a session that has ended, with one message still queued
- **When** you look at the composer
- **Then** it's a dashed "Session ended" card with Resume (only when the agent can resume) and New chat. The queued message is a read-only row ("Queued · runs on Resume") with Delete only. Resume brings back the normal composer with the draft intact and sends the queued message. New chat opens a chat with the same agent and settings.

### SC-18 Failed send

- **Given** an idle composer
- **When** you send and the send fails
- **Then** the text and attachments come back into the editor and a one-line error with Retry appears under the card. Retry sends again. Editing the text clears the error.

### SC-19 Sent messages render markdown

- **Given** you sent a message containing a fenced code block, inline code, bold and a README.md pill
- **When** you look at your bubble in the transcript
- **Then** it shows the code block, the inline code and the bold, and the pill as the file name, matching what the editor showed.

### SC-20 Agent replies keep line breaks

- **Given** an agent reply with numbers on separate lines and no blank lines between them
- **When** it renders in the transcript
- **Then** each number stays on its own line.

## Capabilities

Every capability from [current-state.md](current-state.md#capabilities):

| Capability | Decision |
|---|---|
| Type a message, Shift+Enter for a new line | kept (SC-1) |
| Send with Enter or the Send button | kept, Send moves inside the card as the round action button (SC-1) |
| Queue while working (Enter or Queue button) | kept, the Send arrow beside Stop queues (SC-12) |
| Edit, delete or steer a queued message | kept, rows attach to the card's top edge (SC-13) |
| Stop the running turn | kept, round Stop inside the card plus Esc (SC-11) |
| Elapsed time of the running turn | kept, beside Stop (SC-11) |
| Mention a file: `@`, arrows, Enter/Tab to pick, Esc to close | kept, list attaches above the card and picks become pills (SC-5) |
| Attach images by drop or paste; remove a chip | kept, paste now works for clipboard images (SC-7) |
| Attach hint | moved to the + button, which opens a file picker instead of a hint (SC-7) |
| Choose model (built-in plus live models) | moved to the settings popover (SC-15) |
| Choose effort | moved to the settings popover (SC-15) |
| Choose permission mode | moved to the settings popover, with a badge when not default (SC-15, SC-16) |
| Toggle plan mode | moved to the settings popover, with a badge when on (SC-16) |
| See which agent the session uses (fixed) | kept, agent chip in the toolbar |
| Disabled controls explain why on hover | kept |
| Failed send restores the draft and images | kept, error moves inline under the card with Retry (SC-18) |
| Ended state | kept, gains Resume and New chat (SC-17) |
| Resize the textarea | cut: the editor grows with its content up to about half the pane, then scrolls |

## Redesign checks

The after pass runs these on the branch. They are part of the build, not a later step.

### Goals

None are removed. Every goal in [goals.json](goals.json) replays on the new UI:

| Goal | New path |
|---|---|
| g1 Write a two-line message and send it | type, Shift+Enter, type, Enter or the round Send button (SC-1) |
| g2 Queue a follow-up while the agent works, then stop the turn | type mid-turn, Enter; then the round Stop (SC-12, SC-11) |
| g3 Mention a file with @ and pick it from the list | `@` + filter, Tab; a pill appears (SC-5) |
| g4 Attach an image, then remove it before sending | + › choose a PNG, or paste a screenshot; ✕ on the chip (SC-7) |
| g5 Switch model and effort, change permission mode, turn on plan mode | settings chip › popover; badges appear (SC-15, SC-16) |
| g6 See what the composer shows once the session has ended | ended card with Resume and New chat (SC-17) |

### Before scores

| Surface | Dark | Light |
|---|---|---|
| Structured session view | 41 | 41 |

From [scores/before.json](scores/before.json). The reviewer judged the whole view against the golden shell (panel gaps, sidebar selection, tab and status-bar styling) and barely looked at the composer. The full `quirky.session` scoring run fails because the empty Chat dialogs overlay times out on capture, so only this view is scored. No surface is new or removed.

### Gates

1. **Scores:** the Structured session view scores at least 85 and at least its before score (41) in dark and in light.
2. **Goals:** every goal above replays successfully on the new UI, with likeuser evidence that its effect happened.

The first gate may not be reachable from composer changes alone, because most of the score comes from the surrounding shell. If the after pass scores the view below 85 while the composer itself matches the mock, the after pass reports that and leaves the decision to the user. It doesn't widen this redesign to the shell.

### Real-app goals

All six goals are tagged real-app: the fixture can't start a chat session. The after pass walks them in the real Quirky build after the user says yes on screen.

## Walk bugs

| Bug | Decision |
|---|---|
| Stop is covered by the layout toggle button in the working state | fixed by this redesign: Stop is the round action button inside the card (SC-11) |
| Pasting an image file never attaches ("has no file path") | fixed by this redesign: paste attaches clipboard images, including screenshots with no file on disk (SC-7) |
| Plan mode has no visible on state | fixed by this redesign: the Plan switch shows its state and a badge appears (SC-16) |
| A queued message on an ended session still offers Steer now and Edit | fixed by this redesign: leftover rows are read-only with Delete (SC-17) |
| Agent replies collapse single line breaks | fixed by this redesign (SC-20) |

## Decisions locked

**Shape**
- One card with an inner toolbar. The turn settings collapse into a single summary chip.

**Settings chip**
- The closed chip shows model and effort.
- Permission mode and Plan are set in the popover, with a badge in the toolbar when not default. Clicking the badge turns it off.
- The popover is one panel: model list, effort segmented control, permission list, Plan switch.
- Unsupported controls stay disabled with the reason on hover, as today.

**Working state and queue**
- One round button becomes Stop with the elapsed time. A Send arrow joins it once you type.
- Enter queues and Cmd+Enter steers at the next tool call.
- Queued rows attach to the card's top edge with Steer now, Edit and Delete. Up pulls the last one back. Steered rows show pending until the agent takes them.
- After Stop, queued messages stay held.

**Attachments and mentions**
- + opens a file picker for images. Drag and paste also work.
- Non-image files become `@` mentions, as an absolute path outside the worktree.
- Mentions render as inline pills, deleted whole. The agent gets `@path`.
- The suggestion list attaches above the card, full width.

**Ended and errors**
- An ended card with Resume (when supported) and New chat.
- Leftover queued messages become read-only rows with Delete. Resume picks them up in order.
- A failed send restores the draft and shows an inline error with Retry.
- Drafts are kept per session, with images and next-turn settings, through restart.

**/ commands**
- Quirky's own commands plus the agent's commands and skills where the agent reports them, grouped by source.
- Quirky commands act at once. Agent commands and skills insert as a pill and send as the message.

**Inline markdown**
- Styled as you type with syntax visible but faded. Cmd+B, Cmd+I and Cmd+E wrap the selection.
- Sent messages render markdown in the transcript.

**Scope**
- Only the composer under a chat. The New chat and prompt dialogs keep their box.
- The transcript newline bug is fixed here.
- In scope: an Enter vs Cmd+Enter preference, drag to reorder queued messages, long pastes becoming a file chip.
- Out: voice input.

**Approach**
- The editor is built on CodeMirror 6, already a Quirky dependency. It styles markdown with the syntax visible natively, and pills are atomic widgets.

**UX review**
- Looks right at v1: all five screens visited, no pins.

## Industry insights

- **Steer is becoming the default mid-turn send elsewhere, with queue as the modifier.** VS Code, Conductor and Devin made that switch in 2026, and Claude Code's CLI still queues. We keep queue on Enter and steer on Cmd+Enter. — [VS Code chat](https://code.visualstudio.com/docs/chat/chat-overview), [Conductor 0.86.0](https://www.conductor.build/changelog/0.86.0-share-your-loadouts), [Devin changelog](https://docs.devin.ai/desktop/changelog)
- **A steer takes effect at the next tool call**, so showing it as applied when sent misstates what the agent has seen. — [Cursor changelog](https://cursor.com/changelog/08-19-26), [Claude Code desktop](https://code.claude.com/docs/en/desktop)
- **Queued messages need edit, reorder and removal**, and Up pulls the last one back in Claude Code. — [Cursor help](https://www.cursor.com/help/ai-features/agent), [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode)
- **Queue and Stop opacity is a top complaint**: late or duplicated queued delivery, and a Stop that needed several clicks. — [claude-code #105577](https://github.com/anthropics/claude-code/issues/105577), [claude-code #34449](https://github.com/anthropics/claude-code/issues/34449)
- **Enter during IME composition sends half-typed text** unless the handler checks composition. — [codex #23440](https://github.com/openai/codex/issues/23440), [robota #3286](https://github.com/woojubb/robota/issues/3286)
- **Clipboard images pasted in Electron have no file path**, so paste must read the image data itself. — [Electron #30124](https://github.com/electron/electron/issues/30124), [Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils)
- **Toggles that only set aria-pressed are invisible to sighted users.** — [remote-server #1183](https://github.com/arii/remote-server/issues/1183)
- **Drafts leak or vanish when they aren't keyed per conversation.** — [QwenPaw #8351](https://github.com/agentscope-ai/QwenPaw/issues/8351), [Osaurus #2723](https://github.com/osaurus-ai/osaurus/issues/2723)
- **Mentions render as pills in apps that document it**, and long pastes become removable file chips. — [Devin changelog](https://docs.devin.ai/desktop/changelog), [LibreChat upload as text](https://github.com/LibreChat-AI/librechat.ai/blob/main/content/docs/features/upload_as_text.mdx)
- **CodeMirror 6 handles pills as atomic replace widgets and styles markdown with visible syntax.** In return we own image paste and drop, auto-grow, the Enter vs accept-suggestion keymap and the accessible name, and IME next to a widget still has open browser bugs. — [CodeMirror decoration example](https://codemirror.net/examples/decoration/), [IME next to widgets](https://discuss.codemirror.net/t/ime-input-may-break-when-cursor-is-adjacent-to-widget-due-to-cm-widgetbuffer-reconstruction/9799)
- **TipTap's markdown round-trip isn't lossless, and a textarea overlay can't hold atomic pills or bold without caret drift.** Both were rejected for this reason. — [TipTap markdown](https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage), [overlay pitfalls](https://helgesver.re/articles/syntax-highlighting-textarea-overlay)

## Scope and non-goals

**In:** the composer under a chat in the Structured session view, for Claude, Codex, pi and omp, plus two transcript changes: markdown in sent messages (SC-19) and agent replies keeping line breaks (SC-20).

**Out:**
- The New chat dialog and the agent prompt dialog. They keep their own box.
- Voice input.
- Hiding markdown syntax as you type.
- New agent capabilities. The composer exposes what each agent already supports and disables the rest.
- Shell styling outside the composer, even though it drives most of the view's score.

## Deferred ideas

- Voice input.
- The new composer in the New chat and prompt dialogs.
- [tech-spec] Where each agent's `/` command and skill list comes from. Claude reports `slash_commands` in its init message, which `plugins/quirky.structured/claude-runner.ts` ignores today. Codex, pi and omp need their own source, or show only the Quirky group.
- [tech-spec] How drafts persist across restart, and where.
- [tech-spec] How a pasted clipboard image without a file path becomes something the agent can read.

## Status & amendments

**Status:** Approved 2026-11-16 · Tech spec: written ([tech.md](tech.md))

**Amendments:**
- 2026-11-16: SC-12's steered row has no Cancel. Steering hands the text to the agent at once, so nothing is left to cancel. Asked on the run's live view, and the default was applied after no answer within 10 minutes.
