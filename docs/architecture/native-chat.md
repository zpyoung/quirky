# Native Chat (the experimental "Chat UI" view)

> Engineer onboarding reference for the `experimentalNativeChat` feature — the
> chat surface an agent terminal can be opened into.
>
> This is a fork-maintained doc. Fork-authored behavior is marked inline with its
> feature name and `fork-<feature>/` directory; everything unmarked is upstream.
> Code is cited by **file and symbol**, never by line number — line anchors rot
> within a sync or two, which is what stranded the previous revision of this doc.

## 1. What it is (the one-paragraph version)

**Native Chat renders a running coding-agent's conversation as a real chat UI —
message bubbles, a composer, tool-call cards, diffs, interactive approval cards.**
There are now **two runtimes** behind that one view:

- **The bridge path** (the original, and the subject of most of this doc). The
  agent keeps running unchanged inside its PTY. Native Chat never launches or owns
  the runtime: it **reads** the agent's on-disk JSONL transcript (plus live hook
  state) to reconstruct the conversation, and **writes** your replies back into the
  same PTY as if you had typed them into the TUI.
- **The structured path** (`mode: 'structured'`, gated on
  `experimentalStructuredNativeChat`). A host-owned Codex runtime that does not
  mirror a terminal. See §13.

The mental model for the bridge path — and *only* that path:

> **The terminal is the source of truth. The chat view is a read/write skin over
> it.** History comes from the transcript file; live progress comes from the
> agent status hook; your input goes out as framed keystrokes to the PTY.

## 2. Feature gating

### The settings

All native-chat settings are declared in `src/shared/global-settings-types.ts`
and defaulted in `src/shared/default-global-settings.ts`. (`src/shared/types.ts`
no longer exists — upstream split it into per-domain modules.)

| Setting | Type | Default | Role |
|---|---|---|---|
| `experimentalNativeChat` | `boolean` | `false` | Master switch. |
| `openAgentTabsInChatByDefault` | `boolean` | `false` | "Default view" — the only way a tab opens in chat. |
| `experimentalStructuredNativeChat` | `boolean` | `false` | Route new chat tabs to the host-owned structured runtime (§13). |
| `nativeChatWidth` | `NativeChatWidthTier` | `DEFAULT_NATIVE_CHAT_WIDTH_TIER` | Reading-column cap (§10). `fork-native-chat-width` |
| `nativeChatSessionOptions` | `PersistedNativeChatSessionOptions` | `{}` | Per-model launch defaults (§9). `fork-native-chat-session-options` |

The first three are surfaced in **Settings → Experimental → "Chat UI"**
(`src/renderer/src/components/settings/NativeChatExperimentalSetting.tsx`). The
master switch reveals a **Default view** `Select` ("Terminal chat" vs "Chat UI")
writing `openAgentTabsInChatByDefault`, and — only when that reads "Chat UI" — a
nested **"Use updated structured native chat"** switch.

Two further settings gate the *terminal dock*, a sibling surface that is mutually
exclusive with chat view on the same pane. They live in §12.

### Eligibility

`canToggleNativeChat()` in
`src/renderer/src/components/native-chat/native-chat-availability.ts` is the
single eligibility gate. It returns `true` only when **all** of:

1. `experimentalNativeChatEnabled === true`, **and**
2. `contentType === 'terminal'` (never editor/browser/other surfaces), **and**
3. the tab runs a **supported agent** — resolved with precedence
   `detectedAgent ?? launchAgent ?? resolvedAgent`:
   - `detectedAgent` — live agent-status identity (authoritative; covers
     manually-started or resumed agents),
   - `launchAgent` — what Orca launched in the terminal,
   - `resolvedAgent` — terminal-title resolution, filling only the pre-hook gap.
4. for an agent needing a **locally readable transcript**, that the transcript
   actually is one (below).

A pane already in chat mode (`isChatViewMode === true`) short-circuits to `true`,
so a pane that lost live hook identity across a dev/app restart can still leave.

> The function's name is now a small lie: nothing in the product *toggles*. See
> §11 for how a pane actually enters chat view.

### Supported agents

`NATIVE_CHAT_SUPPORTED_AGENT_LIST` (`src/shared/native-chat-agent-support.ts`) is
an ordered array — the order the settings pane advertises them in — backing the
`NATIVE_CHAT_SUPPORTED_AGENTS` set:

```
['claude', 'openclaude', 'codex', 'grok', 'omp']
```

The *transcript format* is resolved separately by
`resolveNativeChatTranscriptAgent()` into one of four:

- `claude` and `openclaude` → **`claude`** format (OpenClaude writes the Claude
  transcript layout while keeping its own launch/UI identity),
- `codex` → `codex`, `grok` → `grok`, `omp` → `omp`.

Each format has its own line decoder,
`src/main/native-chat/transcript-line-decoders-{claude,codex,grok,omp}.ts`,
dispatched by `nativeChatLineDecoderForAgent()` in `transcript-tail-reader.ts`.
Gemini and plain shells never qualify.

### Locally readable transcripts

`nativeChatRequiresLocalTranscript()` returns `true` for **`grok` and `omp`** —
agents whose hook discloses no transcript path, so the file is only reachable by
scanning a sessions root on a disk *this* process can read. On a plain `ssh:`
connection that disk is the wrong host, so the chat view stays closed rather than
loading forever. `isNativeChatTranscriptLocalReadable()`
(`src/renderer/src/lib/native-chat-transcript-readability.ts`) answers that per
connection; it returns `false` for any plain `ssh:` id. Runtime-owned SSH targets
stay readable because their transcripts are read on the runtime host (§14).

### Structured eligibility

`canUseStructuredNativeChat()`
(`src/renderer/src/lib/structured-native-chat-availability.ts`) additionally
requires `experimentalStructuredNativeChat`, a **local** execution host, and
neither Windows, WSL, nor a repair-required runtime. Critically it also requires
`openAgentTabsInChatByDefault`, because — in its own words — *"Structured chat has
no entry path of its own — it reuses the Chat UI default view."*

## 3. The conversation model (the heart of the feature)

Everything renders from one IPC-serializable contract in
`src/shared/native-chat-types.ts`. It must stay plain JSON (no class instances,
`Map`s, or `Date`s) because it crosses the process boundary.

```ts
type NativeChatMessage = {
  id: string                 // stable across re-reads/appends → dedup + list key
  role: 'user' | 'assistant' | 'tool' | 'reasoning' | 'system'
  blocks: NativeChatBlock[]  // text | tool-call | tool-result | image-ref
  timestamp: number | null   // epoch ms, null sorts first (some scrape segments)
  source: 'transcript' | 'hook' | 'scrape'
  turnId?: string            // same turnId ⇒ same turn, regardless of id
}
```

### Three representable sources, ranked

`NATIVE_CHAT_SOURCE_PRIORITY` makes precedence a single lookup:

| Source | Priority | Meaning |
|---|---|---|
| `transcript` | 3 | Authoritative on-disk JSONL history. Wins. |
| `hook` | 2 | Synthetic live content such as the in-flight assistant preview. |
| `scrape` | 1 | Approximate messages parsed from terminal scrollback. |

The normal live-session path ingests **transcript** messages. Hook state supplies
status and `lastAssistantMessage`; the view derives a synthetic streaming message
from that preview and removes it once the transcript catches up. Full scrollback
scraping is not wired into conversation loading — `native-chat-scrape-fallback.ts`
survives mainly for its `stripScrollbackAnsi` helper, which the session-option
screen readers and the launch-draft sender depend on.

There are two related merge layers:

1. `mergeNativeChatMessagesWith` in `src/shared/native-chat-merge.ts` handles
   incremental frames. It deduplicates by `id`; a re-emitted id replaces in
   place only when the incoming source is at least as authoritative
   (`priority[incoming] >= priority[current]`). New ids append in arrival order.
2. `assembleNativeChatSession` in `native-chat-session-assembler.ts` builds the
   final ordered session. It deduplicates by `id` and by logical turn
   (`turnId`, otherwise role + normalized content) across different sources,
   keeping the higher-priority copy.

The streaming hook preview does not rely on the id-merger to be superseded. Its
visibility is derived separately from whether it still leads the transcript.

### Turn lifecycle & session status

- `NativeChatTurnLifecycle` — a **provider-authored** turn boundary recovered from
  the transcript itself: `working | completed | interrupted`. This is explicit
  evidence (not inferred from prose) used to reconcile a dropped final hook.
- `NativeChatSessionStatus` — `loading | ready | working | empty | error`, the
  status the view renders.

## 4. Architecture at a glance

```
┌────────────────────────────────────────────────────────────── main process ──┐
│  transcript-watch → resolve file → install watcher (transcript-watch-engine) │
│  transcript-tail-reader → line decoder + session-option companion decoder    │
│  ipc/native-chat.ts   (readSession / subscribe / unsubscribe)                │
└───────────────▲───────────────────────────────────┬─────────────────────────┘
                │ nativeChat:readSession             │ nativeChat:appended
                │ nativeChat:subscribe               │ (snapshot|replacement|appended)
┌───────────────┴───────────────────────────────────▼─── renderer ────────────┐
│  fork-native-chat-relay/use-native-chat-live-session (read window + tail)   │
│    ├─ merger (id-dedup, source precedence, windowed)                        │
│    ├─ incremental assembler (suffix-extension fast path)                     │
│    ├─ transcript companion → turn lifecycle + reported session options       │
│    └─ mergeNativeChatLiveSession (hook status → session status)              │
│  NativeChatView → MessageList / Composer / Interactive cards                 │
│  fork-agent-composer send pipeline ─── framed keystrokes ───────────────────►│──► PTY
└─────────────────────────────────────────────────────────────────────────────┘
```

Code lives in three trees, each with fork subdirectories:

- `src/renderer/src/components/native-chat/` — UI and renderer data hooks. Fork
  subdirs: `fork-agent-composer/` (the composer core, by far the largest),
  `fork-native-chat-relay/` (the live-session read window and tail, paging, and
  the runtime-owner transport), `fork-native-chat-session-options/`,
  `fork-native-chat-width/`, `fork-native-chat-coloring/`.
- `src/main/native-chat/` — transcript resolution, watching, per-agent decoding.
  Fork subdir: `fork-native-chat-session-options/`. Related:
  `src/main/ipc/native-chat.ts`.
- `src/shared/native-chat-*.ts` — cross-process contracts: message model, merge,
  streaming, agent support/profiles, ask/answer, slash commands, session options.
  Fork siblings sit in `src/shared/fork-native-chat-{session-options,coloring,width}/`
  and do **not** match the `native-chat-*.ts` glob.

## 5. Main-process side: producing messages

### Reading (windowed)

`nativeChat:readSession` (an `ipcMain.handle` registered by
`registerNativeChatHandlers`, `src/main/ipc/native-chat.ts`) returns the
**most-recent window** of decoded messages. `DESKTOP_READ_WINDOW = 300` — only the
recent window is parsed so a huge transcript never stalls the main process or the
list. Pagination raises `limit`.

`NativeChatReadSessionArgs` is `{ agent, sessionId, limit?, transcriptPath?,
beforeOffset? }`:

- `transcriptPath` (from the hook's providerSession) locates the file when the
  session id no longer names it (recent Claude Code),
- `beforeOffset` pages backwards by byte offset.

### Watching (live tail)

`nativeChat:subscribe` (an `ipcMain.on`) calls `subscribeNativeChatTranscript`.
It lives in `src/main/native-chat/transcript-watch.ts`, which resolves the
per-agent decoder and then:

1. resolves the session's file path (`resolveSessionFilePath`), translating WSL
   host paths on the way (`toHostReadableTranscriptPath`),
2. installs a native FS watcher (`installTranscriptWatcher`),
3. decodes appended lines with the per-agent decoder **and** the session-option
   companion decoder (§9).

Upstream split the rest of the old module into `transcript-watch-contract.ts`
(types), `transcript-watch-engine.ts` (`installTranscriptWatcher`, the
drain/reconcile state machine), `transcript-watch-scheduler.ts` (debounce and
reconciliation timers), and `transcript-incremental-reader.ts` (byte-offset reads).

A brand-new session's transcript can take **seconds to minutes** to flush its
first line. Instead of failing, the watcher enters a **resolve-poll loop**
(`INITIAL_RESOLVE_POLL_MS = 500` backing off to `MAX_RESOLVE_POLL_MS = 5000`,
with `FALLBACK_RESOLVE_POLL_MS` throttling the recursive session-id glob
separately from the fast exact-path retry), returns a subscription immediately,
and reports `watching: true` so the renderer stays in `loading` rather than
settling a permanent error. After `UNFLUSHED_SETTLE_MS` it fires
`onTranscriptPending` once, which marks the snapshot `pending` (below) so a
genuinely never-prompted session stops spinning without being called empty.

### The push contract

The watcher pushes `nativeChat:appended` frames (`NativeChatAppendedPayload`),
each echoing the renderer-minted `subscriptionId`:

| Frame | When | Semantics |
|---|---|---|
| `snapshot` | initial drain | Authoritative base generation. May carry `error` or `pending`. |
| `replacement` | inode/file rotation | New authoritative base; repaints history. |
| `appended` | tail growth | Incremental messages to merge onto the base. |

All three are intersected with `NativeChatCompanionFrameFields`
(`fork-native-chat-session-options`), so every frame may also carry a `lifecycle`
marker and a `sessionOptions` observation. One shape for every hop, so the frame
types cannot drift apart.

### Subscription lifetime (leak safety)

Subscriptions are keyed by **`(webContents.id, subscriptionId)`** so one renderer
can watch several panes. Teardown is strict:

- a `pending` map guards async setup so `unsubscribe` / window-destroy /
  same-id resubscribe can invalidate a watcher *before* it publishes,
- `sender.once('destroyed', …)` tears down **every** watcher a closed/reloaded
  window owns (fd-leak prevention).

## 6. Renderer side: assembling the live session

**The live path is a fork copy.** `use-native-chat-live-session.ts` still exists
at the top of the native-chat tree, but it now backs only the structured surface
(§13). The terminal-pane Chat UI runs
`fork-native-chat-relay/use-native-chat-live-session.ts`, reached through
`use-native-chat-retained-session.ts`, and it is the one to read.
`native-chat-incremental-assembler.ts` is duplicated the same way.

It runs two axes in parallel:

- **Base read** — windowed `readSession`; result *replaces* the base list.
- **Live tail** — `subscribe`; `snapshot`/`replacement` reset the base,
  `appended` frames accumulate in a **separate** list so a re-read never drops
  in-flight appends.

Key internals:

- **`appended` merger** (`createNativeChatMerger`, `src/shared/native-chat-merge.ts`)
  — stateful id-dedup that caches an `id → index` map, so each live frame costs
  `O(incoming)` instead of `O(existing+incoming)`, then bounds to the read window
  (`boundNativeChatWindow`).
- **Incremental assembler** — when the new transcript is a pure suffix-extension
  of the last (`sharesPrefix`), it splices just the tail; otherwise it fully
  resets so the cache can't drift.
- **notFound retry** (`fork-native-chat-relay/native-chat-read-retry.ts`) — a
  not-yet-flushed transcript retries on backoff `[1s, 2s, 4s, 8s]` then fixed
  `10s`, capped by `NOTFOUND_RETRY_WINDOW_MS = 300_000` (**5 minutes**), staying
  in `loading` instead of erroring. The window is that wide deliberately: measured
  first-flush delays of 73s, 90s and 152s made a one-minute cap error out sessions
  that were merely booting.
- **Transcript companion** —
  `fork-native-chat-session-options/use-native-chat-transcript-companion.ts` folds
  the `lifecycle` and `sessionOptions` frame fields into session state (§9).
- **Pagination** — `loadEarlier` raises `limit` and re-reads a larger window
  (the read is an ordered tail, so older history prepends). Stale resolves from a
  swapped session / flipped owner / superseded epoch are discarded.
- **Transport per owner** — `getNativeChatSessionTransport(runtimeEnvironmentId)`
  routes read/subscribe to the **remote host** for a runtime-owned pane, or keeps
  the local IPC path. An owner flip changes transport identity and re-subscribes
  against the new host. (The web RPC bridge returns a Promise unsubscribe, unlike
  the desktop sync fn — the effect cleanup handles both.) A pane whose chat view
  is hidden passes `enabled: false`, which suspends transcript IO and keeps the
  last committed session until it is shown again.

The final `useMemo` folds live hook state into a session status via
`mergeNativeChatLiveSession`.

## 7. Streaming preview & live status precedence

While a turn is in flight the transcript hasn't been written yet, so we show a
**synthetic streaming bubble** from the hook's `lastAssistantMessage`:

- `deriveNativeChatStreamingText` (`src/shared/native-chat-streaming.ts`) returns
  the preview **only while `working` and it leads the transcript** (longer than,
  and not already contained in, the last assistant turn). Once the real turn
  catches up, the preview is suppressed so the bubble doesn't duplicate or flicker.
- The synthetic message has a stable id `NATIVE_CHAT_STREAMING_ID` and
  `source: 'hook'`.

Session-status precedence lives in `liveStatusOverride`
(`native-chat-live-status.ts`), and is deliberately **hook-first**:

- only hook `'working'` drives a live override (blocked/waiting/done leave the
  derived ready/empty status alone);
- it stays authoritative **until** the hook leaves `working` **or** an explicit
  terminal lifecycle marker (`completed`/`interrupted`) for *this* turn lands —
  lifecycle is a suppressor for dropped Stop hooks, not a full turn reconstructor;
- an `interrupted` marker ends the whole turn (children included);
- Claude's **background subagents** keep the aggregate turn `working` even after
  the lead turn completes (`hookHasWorkingSubagents`);
- transcript vs hook clocks get `LIFECYCLE_CLOCK_SKEW_SLACK_MS` (2s) of slack over
  SSH/runtime, applied only to real epoch timestamps.

## 8. The send path (user → PTY)

Because we're writing into a live TUI, sends are careful and **serialized per
PTY** (`native-chat-pty-send-queue.ts`). The pure byte-builders live in
`native-chat-send.ts`.

`native-chat-runtime-send.ts` is now a **façade**. The sequencing itself lives in
`fork-agent-composer/` — extracted so the chat pane and the terminal dock (§12)
share one send pipeline:

| Module | Owns |
|---|---|
| `native-chat-body-send.ts` | The clear → body → Enter sequence. |
| `native-chat-runtime-clear.ts` | Clearing the TUI line and confirming it. |
| `native-chat-runtime-send-acceptance.ts` | Awaiting transport acceptance per write. |
| `native-chat-runtime-send-queued.ts` | Routing verified and ask-answer sends through the PTY queue. |
| `native-chat-send-outcome.ts` | Post-send observation and the `SendOutcome` verdict. |
| `native-chat-ask-answer-send.ts` | Paced per-option answer delivery. |
| `native-chat-typed-command-send.ts` | Typed slash/skill command delivery. |

### Plain message — `sendNativeChatMessage`

1. **Clear** the unsubmitted TUI line, so a prior cancelled paste can't glue onto
   this prompt. This is *not* a bare Ctrl+U: `buildComposerSendOptions` passes
   `buildAgentTuiClearInputForText(text)` (`src/shared/agent-tui-input-clear.ts`),
   which repeats Ctrl+U (`AGENT_TUI_CLEAR_INPUT_LINE`) and Ctrl+K
   (`AGENT_TUI_CLEAR_INPUT_FORWARD`) proportionally to the outgoing text's line
   count, plus `AGENT_TUI_CLEAR_LINE_SLACK`, capped at `AGENT_TUI_CLEAR_MAX_LINES`.
   The single `NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT` byte survives only as the
   no-option fallback and the cancel-cleanup clear.
   The clear **awaits transport acceptance**, and if a `confirmCleared` observer
   reports the line still dirty it escalates to `AGENT_TUI_CLEAR_INPUT_MAX`.
2. **Paste** the framed body (`buildNativeChatPasteBytes`), also acceptance-gated.
3. **Delayed Enter** as a *separate* write after `NATIVE_CHAT_SUBMIT_DELAY_MS`
   (500ms) — a same-write CR can be swallowed by the paste — scheduled only once
   the body write is confirmed accepted, not unconditionally.
4. **Observe** the result (`submitAndObserve`): up to
   `NATIVE_CHAT_SUBMIT_OBSERVATION_MAX_READS` reads every
   `NATIVE_CHAT_SUBMIT_OBSERVATION_POLL_MS`.

### Send outcomes

`SendOutcome` is `observed-cleared | unobservable | may-not-have-sent`. On
`may-not-have-sent` the composer restores the unsent text back into the draft with
a "Send may not have completed" notice, rather than silently dropping it.

### Tiered send

`resolveComposerSendTier` (`fork-agent-composer/composer-send-tier.ts`) returns
`verified` for the agents in `COMPOSER_VERIFIED_TIER_AGENTS`
(claude / openclaude / codex) unless `isLocalConptyBelowWrapMarkers`, else
`input`. The tier decides whether the screen-readback `confirmCleared` /
`confirmSubmitted` callbacks are attached at all.

> **Asymmetry worth knowing:** the terminal dock resolves a tier explicitly; the
> chat pane's `NativeChatView` passes no `sendTier`, so the chat composer falls
> back to `input` today. Verified-tier readback is exercised only by the dock —
> and, separately, by the always-verified session-option path below.

### Optimistic echo — no flash while IPC catches up

Before the transcript reflects the send, the message is shown from a local
**pending cache** (`native-chat-pending.ts`, sessionStorage-backed):
`appendPendingSendCache` → `pendingSendsAsMessages`. When the real turn arrives,
`prunePendingSends` removes the echo. The same file handles **command markers**
(slash-command echoes) and the **launch prompt** shown before the first turn.

### Verified path — `sendNativeChatMessageVerified`

Session-option commands (model switch, `/effort`, …) must not be disrupted by a
stray delayed Enter. This path **cancels any in-flight chat send on the PTY,
waits for idle**, then uses `sendRuntimePtyInputVerified` (awaits remote/SSH
acceptance) for body and Enter, routed through the same per-PTY queue so ordering
holds against ordinary sends. This is why opening Claude's "Switch model?" dialog
no longer eats a chat Enter. Ordinary slash/skill tokens use the normal serialized
send path; verified delivery is specific to the session-option command flow.

### Interactive answers — `sendNativeChatAskAnswer`

Some agents render a **digit-commit question selector** that ignores pasted label
text (pasting "Blue"+Enter commits the highlighted *first* option): Claude's
AskUserQuestion and Codex's `request_user_input`. For these
(`shouldStepNativeChatAskAnswer`), answers are delivered as **paced per-option
keystroke groups**, one group per `NATIVE_CHAT_QUESTION_STEP_MS` — itself derived
as `NATIVE_CHAT_SUBMIT_DELAY_MS + NATIVE_CHAT_ADVANCE_BUFFER_MS`
(`src/shared/native-chat-answer-stepping.ts`) — so the arrow-navigate selector
applies each before the next.

### Image attachments

`sendNativeChatMessageWithImageAttachments` never concatenates image bytes with
the following prompt text. It writes the attachments, settles for
`NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS`, then writes the body as a **separate**
PTY write via the acceptance hook. (A short-lived upstream module
`native-chat-runtime-image-send.ts` addressed the same problem with a separator;
the fork absorbed it back into `native-chat-runtime-send.ts`. It does not exist —
do not cite it.)

## 9. Session options: model and effort

Native Chat models effort as a **model-scoped session option**, keeps a best-known
local record, and changes the running agent through its PTY. The record tags each
value by how it was learned:

| Source | Meaning |
|---|---|
| `applied` | Orca emitted the value into the agent's launch command. |
| `dispatched` | Chat sent a live command, but has not independently confirmed the resulting TUI state. |
| `reported` | Chat read the value back from an authoritative agent surface. |
| `unknown` | Chat cannot truthfully identify the current value. |

The record is cached by live PTY id, with the terminal tab id as the launch-time
fallback (`native-chat-session-option-cache.ts`). Options are model-scoped
because changing models can reset effort and other modes.

### Reading: the transcript is now an authoritative source

`fork-native-chat-session-options` decodes model and effort **out of the JSONL
itself**, in the same drain loop as the message decoder, so every windowed read
and every live tail — local or runtime-owned — carries the values:

- **Claude** — `decodeClaudeSessionOptions` reads `effort` off each
  `type: 'assistant'` row and the model from its `message`.
- **Codex** — `decodeCodexSessionOptions` reads model and `effort` off each
  `type: 'turn_context'` row, which decodes to no message at all, so this is the
  only path that sees it.
- **Grok / omp** — no decoder; they stay scrape-and-dispatch only.

The values ride the frames as
`NativeChatTranscriptCompanion { lifecycle?, sessionOptions? }`
(`src/shared/fork-native-chat-session-options/native-chat-transcript-companion.ts`),
folded newest-wins field by field, reach the composer as `reportedSessionOptions`,
and land in the record as **`reported`**. They outrank the screen scrape: the
transcript is written per turn, so it survives scrollback loss and reflects a
model switch made outside the composer.

The other two `reported` sources are unchanged:

- **Claude:** `readClaudeSessionOptionsFromTerminalScreen` parses the fixed TUI
  header for the current model and text such as `with high effort`. The hook
  prefers a main-buffer snapshot when it is authoritative; while the TUI owns
  the alternate screen, it falls back to the mounted xterm serialization.
- **Codex:** no live effort reporter on screen. Opening Codex's model picker
  clears stale model and effort truth, because Chat cannot observe the choice.

At launch, `resolveNativeChatSessionOptionDefaults` reads the user's persisted
model and model-specific values from `settings.nativeChatSessionOptions`, and
`resolveAgentSessionOptionLaunch` translates supported values into CLI arguments,
returning only what was actually applied — so explicit trailing agent arguments
that override Orca's flags do not produce false UI state.

### Writing effort

The composer renders descriptors from `useNativeChatSessionOptions` into
`NativeChatSessionOptionPickers`. Choosing a settable value calls
`surface.setOption('effort', value)`, which serializes option changes per surface
and applies the agent catalog's mid-session behavior:

- **Claude:** builds `/effort <value>` and sends it through
  `sendNativeChatMessageVerified`, then records `dispatched` — sent, but not
  confirmed until a later authoritative report.
- **Codex:** effort is an `agent-picker` operation rather than a direct command.
  Chat sends `/model`, clears its prior model-scoped truth, switches to the
  terminal, and lets the user choose in Codex's TUI. Nothing is inferred.
- **Grok:** now has its own catalog (`src/shared/agent-session-option-catalog-grok.ts`)
  with per-model effort ladders and mid-session `/effort` and `/model` commands.

The picker is disabled while the agent is working or another option update is in
flight, preventing option commands from interleaving with ordinary chat sends.
**OpenClaude** remains the one supported agent with no catalog and so no effort
control. (Gemini and Cursor catalogs also exist, for surfaces outside Chat UI.)

### Persisted defaults and future launches

A successfully dispatched absolute selection is persisted under the agent's
selected model in `settings.nativeChatSessionOptions`. Future launches resolve
that default and emit `--effort <value>` (Claude) or
`-c model_reasoning_effort=<value>` (Codex), placed **before** the user's
free-form agent arguments so an explicit user flag remains the winning override.
No effort path edits the transcript or provider session file.

## 10. Rendering layer

Mounted by `NativeChatView` (default export). It branches on `mode` first:
`'structured'` goes to `NativeChatStructuredSession` (§13); otherwise
`NativeChatBridgeView` resolves the agent/session through `NativeChatSessionGate`
and renders `NativeChatResolvedView`.

| Component | Role |
|---|---|
| `NativeChatMessageList` | Scroll container; autoscroll, pagination trigger, "jump to latest". `MessageRow` renders each message. |
| `NativeChatComposer` | Thin host wrapper over the shared composer core (`fork-agent-composer/AgentComposer`). |
| `NativeChatSessionOptionPickers` | Model and effort pills (§9), mounted inside the composer's actions row. |
| `NativeChatInteractiveCard` | Dispatches to the two cards below. A question replaces the composer because it supplies its own answer input; an approval renders alongside it. |
| `NativeChatQuestionCard` / `NativeChatApprovalCard` | The question and approval renderers. |
| `NativeChatToolRun` | Collapsible tool-call/result summary, with category glyphs and dots. |
| `NativeChatDiffView` | Colored file-edit diffs (git-decoration tokens). |
| `NativeChatCopyButton` | Hover copy control on message rows. |
| `NativeChatEmptyState` | `loading` / `empty` / `error` / `not-agent` states. |
| `NativeChatOrchestrationPausedNotice` | Banner above the conversation when orchestration dispatch is paused. |
| `NativeChatAutocompleteMenus` | Slash-command & skill picker, mention hints. |

The composer's own field and action row live in `fork-agent-composer/` as
`AgentComposerField.tsx` and `AgentComposerActions.tsx` — Tier-2 forked copies
(`FORK-COPY-OF` headers) of the former `NativeChatComposerField.tsx` /
`NativeChatComposerActions.tsx`, which no longer exist. They were made
host-agnostic so the terminal dock could mount the same composer (§12).

### Width and horizontal layout — `fork-native-chat-width`

Native Chat does not measure its width in JavaScript. The portal wrapper uses
`absolute inset-0`, and `NativeChatView` uses `w-full`, so the outer chat surface
always fills the owning terminal split pane.

The transcript and composer then establish the same centered readable column:
their outer region supplies horizontal padding (`px-3`, or `sm:px-4`), and their
content uses `mx-auto w-full` plus the configured width class.

The cap is user-selectable. `nativeChatWidth` holds one of four named tiers, which
`fork-native-chat-width/native-chat-width.ts` maps to a Tailwind token:

| Tier | Class | Cap |
|---|---|---|
| `narrow` | `max-w-2xl` | `42rem` (`672px`) |
| `comfortable` | `max-w-4xl` | `56rem` (`896px`) — default |
| `wide` | `max-w-6xl` | `72rem` (`1152px`) |
| `full` | `max-w-none` | uncapped; fills the pane minus padding |

The resulting base width is:

```text
content width = min(pane width - 2 × horizontal padding, tier cap)
```

The setting is global rather than per-pane, so every open chat pane changes
together. Two controls write it — a `Select` in Settings → Experimental
(`settings/fork-native-chat-width/NativeChatWidthSetting.tsx`) and an inline
`DropdownMenu` (`NativeChatWidthMenu`) in the pane header. All four column sites —
`NativeChatMessageList`, `NativeChatQuestionCard`, `NativeChatApprovalCard`, and
`AgentComposerField` — read it through `useNativeChatWidthClassName`, whose
resolver falls back to `comfortable` for settings that are still loading or
predate the feature.

Horizontal padding is `0.75rem` per side below the `sm` viewport breakpoint and
`1rem` per side at or above it. Tailwind breakpoints follow the application
viewport, not the individual split-pane width, so a narrow split in a wide
window still receives `sm:px-4`. On a wide pane the unused space is divided
evenly by `mx-auto` — which becomes a no-op at the `full` tier.

Assistant rows can use the full readable column. User bubbles and their delivery
errors are capped at `85%` of it (`max-w-[85%]`) and right-aligned, so they track
whichever tier is active.

Chat font zoom applies CSS `zoom` only to the transcript content container. It
scales the transcript's text and layout together; the composer retains its
unscaled column. Width and zoom are orthogonal and compose without special
casing — zoom is per-pane and in-session, width is global and persisted.

Question and approval cards use a subtly different nesting: `mx-auto w-full
px-3 sm:px-4` and the width class sit on the same element. Because the padding is
inside the capped box, their inner card content is narrower by the horizontal
padding at any capped tier. In narrow panes their inner edges still align with
the transcript and composer.

### Role styling and color — `fork-native-chat-coloring`

In `MessageRow`: `user` → right-aligned bubble; `assistant` → left-aligned prose
via `CommentMarkdown` (variant `"document"`) with hover copy/scroll controls;
`reasoning` → italic left-border aside; `system` → small muted text. A typing
indicator (three bouncing dots) shows while `working`.

The user bubble and reasoning aside get their classes from
`fork-native-chat-coloring/native-chat-message-coloring.ts` — the bubble is
`bg-chat-user-surface`, the aside's border is tinted from `--tool-search`, neither
is a stock shadcn token.

The rest of the feature:

- `native-chat-tool-category-glyphs.tsx` renders a category glyph and colored dot
  before each tool line and run summary in `NativeChatToolRun`, driven by the
  classifier in `src/shared/fork-native-chat-coloring/native-chat-tool-category.ts`
  (read / write / exec / search / net).
- `CommentMarkdown`'s `highlightCode` prop turns on `rehype-highlight` and applies
  the `native-chat-code` class.
- `src/renderer/src/assets/fork-native-chat-coloring.css` defines the `--tool-*`,
  `--code-accent*` and `--chat-user-surface` tokens for both themes, plus a
  chat-scoped `--hljs-*` set — necessary because the rich-markdown editor's own
  hljs rules are scoped to a wrapper chat never renders.

Everything else is built on shadcn primitives
(`src/renderer/src/components/ui/`) + Lucide icons + Tailwind design tokens (see
[`docs/STYLEGUIDE.md`](../STYLEGUIDE.md)).

## 11. Mounting & opening

Native Chat is **portaled into the terminal pane's own container** so the terminal
stays mounted and alive behind it. In `TerminalPane.tsx`, `createPortal` is gated
on `effectiveChatViewMode = nativeChatEnabled && isChatViewMode` plus a resolved
`chatPane.container`, and picks the structured view when `structuredSessionId &&
structuredChatAgent` (§13) or the bridge view otherwise. `viewMode` is persisted
on the unified tab, while component-local `chatLeafId` identifies which split pane
owns the chat overlay.

### How a pane actually enters chat view

There is **no toggle**. Three paths set `viewMode: 'chat'`:

1. **The Default view setting, at agent-tab launch — the only in-app path.**
   `decideInitialAgentTabViewMode` / `initialAgentTabViewModeProps`
   (`src/renderer/src/lib/native-chat-initial-view-mode.ts`) return `'chat'` only
   when the flag **and** `openAgentTabsInChatByDefault` are on, the agent is
   supported (and its transcript locally readable if required), and it isn't a
   **draft** launch — a draft's prompt exists only in the TUI input buffer, so it
   must stay in the terminal. Consumed by `launch-agent-in-new-tab.ts`,
   `worktree-creation-agent-seeds.ts`, `worktree-default-terminal-tabs.ts`,
   `worktree-initial-terminal-seeding.ts`, `worktree-draft-startup-view-mode.ts`,
   and the terminal presentation/request IPC bridges.
2. **RPC session creation.** `CreateAgentSessionParams` accepts an optional
   `viewMode: 'terminal' | 'chat'`, so a connected mobile client or another host
   can start a session already in chat.
3. **Workspace restore.** `viewMode` is persisted per tab in
   `src/shared/workspace-session-schema.ts`, so a tab last saved in chat reopens
   in chat.

Both exits are one-directional: `applyNativeChatLeafRoute` (on `route.exitChat`)
and `switchNativeChatToTerminal`, which serves Codex's `agent-picker` effort flow.
Neither can enter chat. They are absolute setters rather than flips on purpose —
a toggle closure captured stale `effectiveChatViewMode` / `chatLeafId` state.

### Removed and orphaned machinery

Upstream's Codex structured restructure deleted the renderer's switching
affordances. Do not resurrect them from this list — it exists so the leftovers are
recognizable as dead, not as a restoration plan:

- The **pane-header toggle button** (`onToggleNativeChat`, `MessageSquare` /
  `SquareTerminal`, `aria-pressed`), the **pane context-menu item**, and
  `toggleNativeChatForLeaf` no longer exist anywhere in `src/`.
- **`useNativeChatToggleShortcut`** (⌘⇧J / Ctrl+Shift+J) is fully implemented and
  unit-tested but **never called** — its call site died with the same commit. The
  three `terminal-cold-park-*.react185.test.tsx` files that `vi.mock` it render a
  component that does not import it. `nativeChatToggleShortcutLabel` has no UI
  consumer, so nothing tells a user the chord exists.
- **`toggleTabViewMode`** — the only store action that flips `terminal ⇄ chat` —
  has that orphaned hook as its sole caller.
- `TerminalPaneHeaderOverlay.tsx` still takes `isChatViewMode`, but only to gate
  `NativeChatWidthMenu` behind `isChatViewMode && isActivePane`. Its own comment
  records the hazard: *"Fork: upstream dropped chat mode from this header, but the
  width menu is gated on it."*

**Consequence, stated plainly:** an existing terminal tab has no in-app way into
chat view. Only newly created tabs, an RPC caller, or a restored workspace can
open one.

## 12. The terminal dock (sibling surface) — `fork-terminal-dock`

The dock is not part of Native Chat, but it shares Native Chat's composer and its
entire send pipeline, which is why §8 lives in a `fork-agent-composer/` directory.

It docks a rich input composer **beneath** a terminal pane running a supported
coding-agent CLI, so a prompt can be composed and sent without typing into the
TUI, with the terminal still visible as a fallback.

- **Gating:** `experimentalTerminalDock` (default `false`) and
  `dockTerminalComposerByDefault` (default `true`), with their own card in
  Settings → Experimental
  (`settings/fork-terminal-dock/TerminalDockExperimentalSetting.tsx`).
- **Mounting:** `TerminalPaneDockMount` portals `TerminalDock` into a
  `.pane-dock-slot` node reserved inside the pane's container, auto-mounting and
  unmounting by pane-height hysteresis.
- **Mutually exclusive with chat view on the same pane** —
  `useTerminalPaneDock` is enabled on
  `experimentalTerminalDockEnabled && !effectiveChatViewMode`.
- **Broader agent set:** gated on `isTuiAgent`, not `NATIVE_CHAT_SUPPORTED_AGENTS`.
- **Shared core:** `TerminalDockComposer` builds on the same
  `useAgentComposerCoreState` / `useAgentComposerCompose` hooks
  `NativeChatComposer` uses, and sends through the same `sendNativeChatMessage*`
  pipeline against the terminal's own PTY. Unlike the chat composer, it resolves
  `sendTier` explicitly (§8).

## 13. Structured mode

`NativeChatView` branches to `NativeChatStructuredSession` before the bridge path
when `mode === 'structured'`; `TerminalPane` selects it when a structured session
and agent resolve, gated by `canUseStructuredNativeChat` (§2). Its supporting
components are `StructuredAgentSessionPaneOverlayLayer` and
`StructuredAgentSessionStatusBridge`, and it is the only remaining consumer of the
non-fork `use-native-chat-live-session.ts`.

It is a host-owned Codex runtime rather than a skin over a terminal, so most of
this document — the transcript-is-truth model, the PTY send path, the terminal
screen readers — does not describe it. **It has not been documented in depth here
yet**; that is its own pass, not something to infer from the sections above.

## 14. Cross-cutting concerns & invariants

- **Transport and ownership.** Two cases:
  - **Runtime-owned (`runtime:`)** — the renderer's transport is the runtime RPC
    bridge (`nativeChat.readSession` / `.subscribe` / `.unsubscribe`, served by
    upstream's orcad runtime); reads and tails happen on the remote runtime host.
    This is how a remote or SSH-hosted workspace gets native chat.
  - **Local** — the local IPC path reads local disk.

  The fork's own SSH relay (a desktop-driven `sshConnectionId` read through a
  remote handler) is retired. **Never assume local disk access when adding a
  transport or provider.**
- **Grok and omp stay closed on plain `ssh:`.**
  `isNativeChatTranscriptLocalReadable` returns `false` for any plain `ssh:`
  connection id, because their transcripts can only be found by scanning a disk
  this process cannot see. Runtime-owned targets read them on the runtime host.
- **Windowing everywhere:** base read, live-append tail, and pagination all share
  one window bound so a long run can't grow the list unbounded.
- **Merger vs assembler drift:** the stateful merger's output is locked to equal
  the pure `mergeNativeChatMessagesWith` by an oracle test; any suffix-extension
  miss forces a full assembler reset rather than risking a stale cache.
- **`hookState` is intentionally excluded** from the assembler's memo deps —
  status-only churn must not re-run message assembly.
- **Skill invocations** are user turns Claude records as noise-filtered command
  envelopes; `surfaceSkillInvocationUserTurns` re-surfaces them as the literal
  token.
- **Fork copies drift silently.** `fork-native-chat-relay/use-native-chat-live-session.ts`
  and its sibling assembler are Tier-2 copies of upstream modules. Nothing —
  not typecheck, not the ownership guard — catches a stale copy when upstream
  changes the original, so replay-check them on every sync.

## 15. Extension points

**Adding a new supported agent:**

1. Add the identity to `NATIVE_CHAT_SUPPORTED_AGENT_LIST` and map its transcript
   format in `resolveNativeChatTranscriptAgent`
   (`src/shared/native-chat-agent-support.ts`). Add it to
   `nativeChatRequiresLocalTranscript` if its hook discloses no transcript path.
2. Write a line decoder `transcript-line-decoders-<agent>.ts` and register it in
   `nativeChatLineDecoderForAgent` (`src/main/native-chat/transcript-tail-reader.ts`).
   `omp` is the most recent worked example.
3. Teach `resolveSessionFilePath` where that agent writes its transcript.
4. If its transcript records model or effort, add a companion decoder in
   `nativeChatSessionOptionDecoderForAgent`
   (`src/main/native-chat/fork-native-chat-session-options/transcript-session-options.ts`)
   so the values arrive as `reported` without a screen scrape.
5. If the agent uses a digit-commit question selector, add it to
   `shouldStepNativeChatAskAnswer`.
6. Add model/session-option behavior to the shared agent-session-option catalog;
   add verified slash/skill commands to `native-chat-agent-profiles.ts` when
   applicable. Add it to `COMPOSER_VERIFIED_TIER_AGENTS` if its TUI supports
   screen-readback confirmation.

## 16. Key file reference

Cited by file and symbol; grep the symbol rather than trusting a line number.

| Concern | File | Start at |
|---|---|---|
| Message / session contract | `src/shared/native-chat-types.ts` | `NativeChatMessage`, `NATIVE_CHAT_SOURCE_PRIORITY` |
| Id-dedup merge + windowing | `src/shared/native-chat-merge.ts` | `createNativeChatMerger`, `boundNativeChatWindow` |
| Streaming-bubble derivation | `src/shared/native-chat-streaming.ts` | `deriveNativeChatStreamingText` |
| Agent support / format mapping | `src/shared/native-chat-agent-support.ts` | `NATIVE_CHAT_SUPPORTED_AGENT_LIST`, `resolveNativeChatTranscriptAgent` |
| IPC handlers + push payloads | `src/main/ipc/native-chat.ts` | `registerNativeChatHandlers`, `NativeChatAppendedPayload`, `DESKTOP_READ_WINDOW` |
| Transcript resolve + subscribe | `src/main/native-chat/transcript-watch.ts` | `subscribeNativeChatTranscript` |
| Watcher engine | `src/main/native-chat/transcript-watch-engine.ts` | `installTranscriptWatcher` |
| Windowed tail read + decoder dispatch | `src/main/native-chat/transcript-tail-reader.ts` | `nativeChatLineDecoderForAgent` |
| Per-agent decoders | `src/main/native-chat/transcript-line-decoders-{claude,codex,grok,omp}.ts` | — |
| Live session hook (the live one) | `src/renderer/src/components/native-chat/fork-native-chat-relay/use-native-chat-live-session.ts` | `useNativeChatLiveSession` |
| notFound retry policy | `.../fork-native-chat-relay/native-chat-read-retry.ts` | `NOTFOUND_RETRY_WINDOW_MS` |
| Hook status → session status | `.../native-chat/native-chat-live-status.ts` | `liveStatusOverride` |
| Availability gate | `.../native-chat/native-chat-availability.ts` | `canToggleNativeChat` |
| Structured availability | `src/renderer/src/lib/structured-native-chat-availability.ts` | `canUseStructuredNativeChat` |
| Send façade | `.../native-chat/native-chat-runtime-send.ts` | `sendNativeChatMessage` |
| Send sequencing | `.../native-chat/fork-agent-composer/native-chat-body-send.ts` | `enqueueNativeChatBodySend` |
| Clear behavior | `src/shared/agent-tui-input-clear.ts` | `buildAgentTuiClearInputForText` |
| Send outcome | `.../fork-agent-composer/native-chat-send-outcome.ts` | `SendOutcome`, `submitAndObserve` |
| Send tier | `.../fork-agent-composer/composer-send-tier.ts` | `resolveComposerSendTier` |
| Transcript session options | `src/main/native-chat/fork-native-chat-session-options/transcript-session-options.ts` | `nativeChatSessionOptionDecoderForAgent` |
| Companion wire shape | `src/shared/fork-native-chat-session-options/native-chat-transcript-companion.ts` | `NativeChatTranscriptCompanion` |
| Session-option catalogs | `src/shared/agent-session-option-catalog{,-claude-codex,-grok}.ts` | — |
| Live option read/surface | `.../native-chat/use-native-chat-session-options.ts` | `useNativeChatSessionOptions` |
| Optimistic pending cache | `.../native-chat/native-chat-pending.ts` | `appendPendingSendCache` |
| Top-level view | `.../native-chat/NativeChatView.tsx` | `NativeChatView` |
| Composer core | `.../native-chat/fork-agent-composer/AgentComposer.tsx` | `useAgentComposerCoreState` |
| Tool coloring | `.../native-chat/fork-native-chat-coloring/native-chat-tool-category-glyphs.tsx` | `NativeChatToolCategoryDots` |
| Width tiers | `.../native-chat/fork-native-chat-width/native-chat-width.ts` | `nativeChatWidthClassName` |
| Width hook | `.../fork-native-chat-width/use-native-chat-width.ts` | `useNativeChatWidthClassName` |
| Settings card | `src/renderer/src/components/settings/NativeChatExperimentalSetting.tsx` | — |
| Initial view-mode decision | `src/renderer/src/lib/native-chat-initial-view-mode.ts` | `decideInitialAgentTabViewMode` |
| Pane mount | `src/renderer/src/components/terminal-pane/TerminalPane.tsx` | `effectiveChatViewMode` |
| Terminal dock | `src/renderer/src/components/terminal-pane/fork-terminal-dock/TerminalDock.tsx` | `TerminalDock` |

## 17. Related docs

- [`docs/STYLEGUIDE.md`](../STYLEGUIDE.md) — design tokens the UI must use.
