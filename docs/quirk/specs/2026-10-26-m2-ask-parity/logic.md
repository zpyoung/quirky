# Ask parity: typed questions, defaults and deadlines, credential refusal, drafts, and a queue that never loses an ask

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m2-ask-parity.md](../../../loop/decisions/m2-ask-parity.md)). Tech spec: requested.

**Amendments:**
- 2026-10-26, Codex spec review ([D22-D26](../../../loop/decisions/m2-ask-parity.md)): a deadline that
  passed while the daemon was down resolves within about a second of the daemon starting, with no
  client call (SC-9); an overdue ask is never surfaced, and cancelling one returns `timed_out`
  (SC-18, SC-19); a multiselect's free text survives a timeout when options are also picked (SC-8);
  answer refusals use Orca's messages (SC-5).

## Conceptual model

An agent in a Quirky session runs `quirky ask --spec …` to put a structured question to the person
at the window, then waits for a JSON envelope with the answers. v1 and M0 built the core: the ask is
a row in the `quirky.ask` plugin's store, the window shows it as a card in the Questions panel, and
the CLI long-polls `quirky.ask/wait` ([m0-core D25, D32](../../../loop/decisions/m0-core.md)). This
item brings it to parity with `orca ask`
([ask.md](../../../../research/orca-features/ask.md)) on the five points the roadmap names, and
on what those points depend on ([D1](../../../loop/decisions/m2-ask-parity.md)):

1. **Typed questions.** Six types: select, multiselect, text, number, date, confirm. Each question
   may be `required` and may declare a `default`. One validator, shared by the CLI and the daemon,
   checks the spec and refuses it with Orca's field-path messages (D5, D6).
2. **Credentials never travel through an ask.** A spec with a `masked` or `sensitive` key, or whose
   ID, question or option values look like they ask for a password, token or key, is refused (D7).
3. **The deadline belongs to the daemon.** `--timeout-ms` stores an absolute deadline. When it
   passes, each question takes its default, else whatever the person had typed so far, else it is
   skipped, and the ask ends `timed_out`. This holds across a daemon restart (D9).
4. **Drafts are saved.** The card saves what has been typed half a second after typing stops, so a
   reloaded window shows it again and a timeout can use it (D12).
5. **One live question per session.** A second ask from the same session waits behind the first.
   Every change to an ask takes the next value of one counter, `seq`, and a queued ask that moves to
   the front takes a fresh value. That is the Orca defect this item must not have: Orca re-emitted
   the promoted ask with its old, lower number, and the window dropped it (D13, D14).

Claude sessions launched by Quirky are also told to use `quirky ask` instead of Claude's built-in
question tool (D3).

## Data flow

1. The agent runs `quirky ask --spec @q.json [--timeout-ms N] [--chunk-ms N]`. The CLI reads the
   spec, validates it, and calls `quirky.ask/create` with the spec, the timeout and the session and
   worktree from `QUIRKY_SESSION_ID` and `QUIRKY_WORKTREE_ID`.
2. The daemon validates the spec again. It stores the canonical spec, the deadline (if any), an
   empty draft, and the next `seq`. If the session already has a pending ask, the new one is
   `queued`; otherwise it is surfaced. The plugin emits `created` and, for a surfaced ask, notifies
   and opens the Questions panel. It returns the ask ID, which the CLI prints as
   `{"status":"registered","askId":…}`.
3. The CLI waits: until the ask ends, or for one `--chunk-ms` chunk, after which it prints a
   `pending` envelope telling the agent to run `quirky ask wait --id <askId>`.
4. In the window, the Questions panel shows each surfaced ask as a card. Typing saves a draft
   through `quirky.ask/updatePartial` 500 ms after the last keystroke. Submit checks every question
   in the window, then calls `quirky.ask/answer`, which the daemon validates again.
5. An ask ends one of four ways: answered (`answered`, or `partial` if anything was skipped),
   dismissed or cancelled (`declined`), or its deadline passed (`timed_out`). The daemon stores the
   envelope, emits `resolved`, releases every waiter, and, if the session has a queued ask, promotes
   it: the next `seq`, a `surfaced` event, a notification.
6. The window refetches the pending list on each ask event, ignoring any event whose `seq` is not
   above the highest it has seen (D16).

## Key decisions

- Orca's schema and messages, plus v1's `title` (D5); one validator in the CLI and the daemon (D6).
- Credential refusal skips the text check for asks a plugin registers, since the kernel's
  confirmations and the structured permission prompt quote text they don't control (D7).
- The daemon validates answers; a question left out of an answer counts as skipped (D8).
- Deadlines are stored and re-armed on start; `ask wait --timeout-ms` times the ask out with the
  same rules through `quirky.ask/expire` (D9, D10).
- `--chunk-ms` is accepted; without it the CLI waits to the end, as v1 does (D11).
- The queue key is the session; asks with no session never queue (D13).
- Previews show as plain text (D17); the card's controls and messages are Orca's (D18); envelopes
  carry `summary` (D19).
- The approach extends `quirky.ask` in place with Orca's pure modules ported beside it (D20).

## Behavior & scenarios

Each scenario's test drives Quirky through the daemon API (an in-process daemon with real RPC
clients on a temporary `QUIRKY_HOME`), the `quirky ask` command, or the window module, as tagged.
Scenarios tagged **(UI)** are also run against a built daemon with `quirk:using-apps-like-a-user`
(D21). Message strings in backticks are exact.

The examples share one spec, `deploy`, unless they say otherwise:

```json
{ "title": "Deploy", "questions": [
  { "id": "env", "type": "select", "question": "Which environment?", "required": true,
    "options": [{ "value": "prod", "label": "Prod" }, { "value": "dev", "label": "Dev" }], "default": "dev" },
  { "id": "replicas", "type": "number", "question": "How many replicas?", "integer": true, "min": 1, "max": 10 },
  { "id": "ship", "type": "date", "question": "Ship date?", "header": "Ship" },
  { "id": "go", "type": "confirm", "question": "Go ahead?", "default": true } ] }
```

### Questions and their validation

1. **SC-1: number and date questions register and come back typed** (API)
   - **Given** a fresh daemon
   - **When** `deploy` is created and answered with `env: {value: "prod", source: "option"}`,
     `replicas: {value: 3, source: "input"}`, `ship: {value: "2026-11-02", source: "input"}`,
     `go: {value: true, source: "input"}`
   - **Then** `wait` returns `status: "answered"` with
     `env: {value: "prod", label: "Prod", source: "option"}`, `replicas: {value: 3, source: "input"}`,
     `ship: {value: "2026-11-02", source: "input"}`, `go: {value: true, source: "input"}`, `skipped: []`
     and `summary` `Which environment?: Prod\nHow many replicas?: 3\nShip: 2026-11-02\nGo ahead?: Yes`.
     `list` returns the stored spec in canonical form.

2. **SC-2: a spec whose fields break the type rules is refused with every error** (API and CLI)
   - **Given** a fresh daemon
   - **When** these specs are created, each through `quirky ask --spec` and through
     `quirky.ask/create` directly:

     | Spec problem | Message |
     |---|---|
     | number with `min: 5, max: 1` | `questions[0].min: min must not exceed max` |
     | number with `integer: true, default: 2.5` | `questions[0].default: default must be an integer` |
     | number with `max: 10, default: 11` | `questions[0].default: default is above max` |
     | date with `default: "2026-02-30"` | `questions[0].default: default must be an ISO 8601 date (YYYY-MM-DD)` |
     | select with `default: "staging"` | `questions[0].default: default must match one option value` |
     | text with `pattern: "(a+)+"` | `questions[0].pattern: pattern must not nest repetition (e.g. (a+)+); it can hang the regex engine` |
     | text with `pattern: "^[a-z]+$", default: "ABC"` | `questions[0].default: default does not match pattern` |
     | text with `format: "phone"` | `questions[0].format: format must be 'email' or 'url'` |
     | `type: "slider"` | `questions[0].type: type must be one of select \| multiselect \| text \| number \| date \| confirm` |
     | `questions: []` | `questions: at least one question is required` |
     | 11 questions | `questions: at most 10 questions allowed` |
     | a select with 13 options | `questions[0].options: at most 12 options allowed` |
     | two questions with `id: "a"` | `questions[1].id: duplicate question id 'a'` |
     | `--spec 'not json'` (CLI only) | starts `Invalid JSON for --spec:` |

   - **Then** the CLI prints the message to stderr, exits 2 and registers nothing; the API call
     fails with InvalidParams carrying the same text; `list` is empty. A spec with two problems
     reports both, joined with `; `, in spec order.

3. **SC-3: credential-shaped specs are refused** (CLI and API)
   - **Given** a fresh daemon and a client connected as a session's CLI
   - **When** these are registered:

     | Spec | Message |
     |---|---|
     | question `id: "db_password"` | `questions[0].id: credential-shaped id is not permitted` |
     | question text `Which pass should we use?` | `questions[0].question: credential-shaped question text is not permitted` |
     | question text `Paste your API key` | the same |
     | option value `MYSECRET` | `questions[0].options[0].value: credential-shaped option value is not permitted` |
     | `masked: false` on a question | `questions[0]: masked/sensitive input is not permitted; collect credentials out of band` |
     | `sensitive: true` and id `apiToken` | both messages, joined with `; ` |

   - **Then** each is refused as in SC-2 and nothing is stored. A spec whose `header`, option
     `label`, option `description` or `default` says "API token" is accepted, since only the ID,
     question and option values are checked.

4. **SC-4: an ask a plugin registers skips the credential text check, but not the masked check** (API)
   - **Given** a fresh daemon with a test plugin that calls `quirky.ask/create`
   - **When** the plugin registers a confirm question `Install plugin acme.tokens (method acme.tokens/rotateToken)?`,
     and then one with `sensitive: true`
   - **Then** the first is created and pending; the second is refused with the masked/sensitive
     message (D7).

### Answers

5. **SC-5: the daemon refuses an answer that breaks the spec, and the ask stays pending** (API)
   - **Given** `deploy` pending
   - **When** each of these is sent to `quirky.ask/answer`: `env: {value: "staging", source: "option"}`;
     `replicas: {value: 0, source: "input"}`; `replicas: {value: 2.5, source: "input"}`;
     `ship: {value: "2026-02-30", source: "input"}`; `env` listed in `skipped`; `go` both answered
     and in `skipped`; an answer for an unknown ID `color`
   - **Then** each fails with InvalidParams naming the question, `wait` with `timeoutMs: 0` still
     returns `pending`, and no `resolved` event is emitted. An answer with `env` and `go` only is
     accepted as `partial`, with `replicas` and `ship` in `skipped` (D8).

6. **SC-6: free text on a select becomes a note, or the answer itself** (API and UI)
   - **Given** a spec with a select `framework` (React, Vue) and a multiselect `features` (Auth,
     Search, Billing)
   - **When** the person picks Vue and types "small bundle size", checks Auth and Search and types
     "Exports"
   - **Then** the envelope holds `framework: {value: "vue", label: "Vue", note: "small bundle size", source: "option"}`
     and `features: {values: ["auth", "search"], labels: ["Auth", "Search"], other: "Exports", source: "options"}`.
     The summary reads `…: Vue` (no note) and `…: Auth, Search, Exports`. With nothing picked and
     "Svelte" typed, `framework` is `{value: "Svelte", source: "other"}`.

7. **SC-7: `default` never fills a blank answer on submit** (API)
   - **Given** `deploy` pending
   - **When** it is answered with only `replicas: {value: 2}`, `ship` and `go` skipped, `env`
     answered `prod`
   - **Then** the status is `partial`, `go` is in `skipped` despite its default, and no answer has
     `source: "default"`.

### Deadlines and defaults

8. **SC-8: at the deadline, defaults win, then drafts, then the question is skipped** (CLI)
   - **Given** a spec with select `color` (default `blue`), text `note`, number `size`, confirm
     `agree` (default `true`)
   - **When** the agent runs `quirky ask --spec … --timeout-ms 1500` and, before the deadline, the
     window saves the draft `note: {draft: "typed draft before the timeout"}` and
     `size: {draft: "abc"}`
   - **Then** the CLI prints `registered`, then, about 1.5 s later,
     `{"status":"timed_out","askId":…,"answers":{"color":{"value":"blue","label":"Blue","source":"default"},"note":{"value":"typed draft before the timeout","source":"input"},"agree":{"value":true,"source":"default"}},"skipped":["size"],"summary":"…"}`
     and exits 0. The unparseable `abc` is skipped, not coerced. `list` shows the stored status
     `timed_out`, and a `resolved` event carries it.
   - **Data after:** **color** ✓ default; **note** ✓ draft; **size** ✗ skipped; **agree** ✓ default
   - A multiselect whose draft has picks and free text (the window saves both, as `selected` and
     `other`) times out as `{values, labels, other, source: "options"}`, keeping the free text.

9. **SC-9: a deadline survives a daemon restart** (API)
   - **Given** two asks created with `timeoutMs` 1000 and 4000, and the daemon stopped right after
   - **When** the daemon starts again 2 s later, on the same home, and a client calls `wait` on each
   - **Then** the first returns `timed_out` at once; the second is still pending and returns
     `timed_out` about 4 s after it was created, not 4 s after the restart. A client that only
     subscribes to events after the restart, calling nothing, receives the first ask's
     `resolved` event (`timed_out`) within about 2 s of the daemon starting.

10. **SC-10: `quirky ask wait --timeout-ms` times the ask out with the same rules** (CLI)
    - **Given** `deploy` pending with no deadline
    - **When** the agent runs `quirky ask wait --id <askId> --timeout-ms 500` and nobody answers
    - **Then** after about 500 ms it prints a `timed_out` envelope with `env` and `go` from their
      defaults and `replicas`, `ship` skipped, and the stored status is `timed_out` (v1 printed
      `timed_out` but stored `declined`). `quirky.ask/expire` on an ask that already finished
      returns its envelope unchanged.

11. **SC-11: an absurd timeout is clamped, not treated as none** (API)
    - **Given** a fresh daemon
    - **When** `deploy` is created with `timeoutMs: 9007199254740991`
    - **Then** it is pending, `list` shows `expiresAt` 8640000000000000, and it can be answered.

### Drafts

12. **SC-12: a draft is saved, filtered and returned with the ask** (API)
    - **Given** `deploy` pending
    - **When** `quirky.ask/updatePartial` is called with
      `{env: {selected: ["prod"], note: "eu only"}, replicas: {draft: "3"}, color: {draft: "x"}}`
    - **Then** it returns `{ok: true}`; `list` shows `partial` with `env` and `replicas` only; an
      `updated` event carries the new `seq`. A partial whose `selected` is not a list of strings is
      InvalidParams. On an answered ask it returns `{ok: false}` and changes nothing; an unknown ask
      is NotFound.

13. **SC-13: a draft survives a daemon restart and a window reload** (API and UI)
    - **Given** `deploy` pending and the person has typed `3` into the replicas field and paused
    - **When** the window reloads, and separately when the daemon restarts on the same home
    - **Then** the card comes back with `3` in the replicas field and `list` returns the draft.
      Typing again saves once, 500 ms after the last keystroke, not once per key.

### The queue and `seq`

14. **SC-14: a second ask from the same session waits** (API and UI)
    - **Given** a window connected and a client connected as session `s1`
    - **When** `s1` creates ask A and then ask B
    - **Then** `list` returns both pending, A with `queued: false` and B with `queued: true`. The
      `created` event for B has `queued: true`. Only A notifies, only A shows a card, the panel
      badge reads 1, and the panel's `ui.state` report lists A under `pending` and `queued: 1`.

15. **SC-15: when the first resolves, the second surfaces with a fresh `seq`** (API and UI; the Orca defect)
    - **Given** SC-14's two asks, with B's `created` event at `seq` 2
    - **When** A is answered (its `resolved` event takes `seq` 3)
    - **Then** a `surfaced` event for B arrives with `seq` 4, greater than every earlier event, and
      `list` shows B with `queued: false` and `seq: 4`. B notifies, the window shows B's card
      within a second, and B's waiting `quirky ask` process prints B's envelope when B is answered.
      A window that ignores events at or below its watermark still shows B.
    - **Walkthrough:** A created (`seq` 1) → B created queued (2) → A answered (3) → B surfaced (4)

16. **SC-16: the window ignores a stale event** (unit, window module)
    - **Given** the panel's store has applied events up to `seq` 7
    - **When** it receives a `surfaced` event with `seq` 5, then one with `seq` 8
    - **Then** the first triggers nothing, the second refetches the list and shows the card.

17. **SC-17: asks from different sessions, or with no session, never queue** (API)
    - **Given** a fresh daemon
    - **When** sessions `s1` and `s2` each create an ask, and two clients with no session each
      create one
    - **Then** all four are surfaced and notify.

18. **SC-18: cancelling or timing out a queued ask leaves the head alone** (API)
    - **Given** `s1` with A surfaced and B queued, B created with `timeoutMs: 800`
    - **When** 800 ms pass
    - **Then** B is `timed_out` while still queued, A is still pending and surfaced, and no
      `surfaced` event is emitted. Cancelling a queued ask C likewise declines only C. If A and B
      are both overdue when the daemon starts, both end `timed_out` and B is never surfaced or
      announced. Cancelling an ask whose deadline has passed but whose timer hasn't fired returns
      `timed_out`, not `declined`.

19. **SC-19: `seq` keeps rising across restarts and the queue order survives** (API)
    - **Given** `s1` with A surfaced and B, C queued, and the highest `seq` 3
    - **When** the daemon restarts and A is answered
    - **Then** B surfaces with `seq` 5 or more (never a reused value), C stays queued, and C
      surfaces after B resolves.

### The CLI

20. **SC-20: `--chunk-ms` returns a pending envelope and leaves the ask answerable** (CLI)
    - **Given** a fresh daemon
    - **When** the agent runs `quirky ask --spec … --chunk-ms 300` and nobody answers
    - **Then** it prints `{"status":"registered","askId":"ask_…"}`, then after about 300 ms
      `{"status":"pending","askId":"ask_…","instruction":"quirky ask wait --id ask_…"}`, and exits 0.
      The ask is still pending. `quirky ask wait --id ask_… --chunk-ms 300` does the same, and once
      the ask is answered prints the final envelope immediately. Without `--chunk-ms`, both wait
      until the ask ends, as in v1. A real `quirky` binary run shows the same two lines.

### The card

21. **SC-21: the card shows each type with Orca's controls** (UI)
    - **Given** the window open and `deploy` plus a text question `email` (`format: "email"`) pending
    - **When** the person looks at the card
    - **Then** `env` shows Prod and Dev rows and an "Add your own answer" input and no
      "(optional)"; `replicas` is a number field with step 1, min 1, max 10, marked "(optional)";
      `ship` shows "Ship" in bold with "Ship date?" under it and a date field; `go` shows Yes and No
      buttons. Clicking the picked Prod row again clears it.

22. **SC-22: submit checks every question and shows Orca's messages** (UI)
    - **Given** SC-21's card
    - **When** the person submits with `env` blank, `replicas` set to `12`, and `email` set to
      `not-an-email`; then `replicas` `2.5`; then `replicas` `0`
    - **Then** nothing is sent; "This question is required." shows under `env`, "Enter a number of
      at most 10." under `replicas`, and "Enter a valid email address." under `email`. Then "Enter a
      whole number.", then "Enter a number of at least 1.". With every error fixed, submit answers
      the ask and the card leaves.

23. **SC-23: an option preview shows as plain text** (UI)
    - **Given** a select whose option React has `preview: {format: "markdown", content: "**JSX** <script>x()</script>"}`
    - **When** the person clicks "Show preview"
    - **Then** the literal text `**JSX** <script>x()</script>` appears, no script runs and no
      element is created from it, and the link reads "Hide preview".

24. **SC-24: a timed-out ask leaves the panel** (UI)
    - **Given** an ask created with `timeoutMs: 1500` showing as a card
    - **When** the deadline passes
    - **Then** the card disappears and the panel badge goes back to empty.

### Claude sessions use `quirky ask`

25. **SC-25: a Claude terminal launch gets the two suppression flag pairs** (API, e2e)
    - **Given** the m1-providers e2e harness with a fake `claude` whose `--version` prints
      `2.1.0 (Claude Code)`
    - **When** a `claude` session starts
    - **Then** the fake records `--disallowedTools AskUserQuestion` and
      `--append-system-prompt "When you need to ask the user a question, run quirky ask (see quirky ask --help) instead of asking in chat."`
      once each. A `codex` session started the same way gets neither.

26. **SC-26: an old or unreadable Claude gets no flags, and existing flags aren't doubled** (API, e2e)
    - **Given** the same harness
    - **When** sessions start with a fake `claude` whose `--version` prints `1.0.50`; one whose
      `--version` exits 1; and a `claude` configured with the arguments
      `--disallowed-tools=Bash --append-system-prompt-file p.md`
    - **Then** the first two launch without either pair; the third gets neither pair, since each
      flag is already present in an alias form. A resumed Claude session carries each pair at most
      once.

### Orca defects this item must not have

| Orca defect (from ask.md) | Scenario |
|---|---|
| A queued ask promoted after the head resolves keeps its registration `seq`, so the window drops it and its CLI waits forever | SC-15, SC-16, SC-19 |

## Scope & non-goals

In scope: the six question types and the shared spec validator, credential refusal, answer
validation, the envelope's `summary`, server-side deadlines with defaults and drafts, drafts and
`quirky.ask/updatePartial`, the per-session queue with `seq` and the `surfaced` and `updated`
events, `quirky.ask/expire`, `--chunk-ms`, the card's controls and messages, plain-text previews,
and Claude's suppression flags.

Not in this item ([D2](../../../loop/decisions/m2-ask-parity.md)):

- Hand-off to an orchestration coordinator, forced hand-off and the native-chat bridges (M5).
- Pane liveness, the 10-minute grace and the `unavailable` status: a Quirky ask doesn't need a
  window attached, as in v1.
- The wait concurrency cap and `runtime_busy`.
- The 3-minute "Pending question in …" OS notification (the notifications feature).
- Markdown or HTML rendering of previews in a sandboxed frame.
- The 4-second collapsed summary after a card resolves, and auto-focus that follows the focused
  pane: Quirky's panel shows every surfaced ask and opens itself, as in M0.
- Attention markers on tabs, worktree rows and the palette.
- Localized card text.
- `ask.subscribe` and `ask.snapshot` with epochs: events plus `quirky.ask/list` serve the window.
- The desktop dock badge keeps counting every pending ask, queued ones included (shell code).
- Windows and Linux: nothing here is platform-specific.

There are no native-only scenarios: the notification on surfacing uses the existing notify path.

## Decisions Locked

- **input-format:** Orca's schema plus `title`, canonical form stored (D5); drafts are Orca's
  partial (D12).
- **error-responses / exit-codes:** one validator with Orca's messages, InvalidParams from the
  daemon, exit 2 from the CLI (D6); answer validation with omitted-means-skipped (D8).
- **error-handling:** credential refusal, with plugin asks skipping the text check (D7).
- **idempotency / error-recovery:** stored deadlines re-armed on start (D9); `expire` for
  `wait --timeout-ms` (D10); queue per session derived from rows (D13).
- **response-format:** one `seq` counter (D14); four events (D15); `summary` (D19).
- **flag-design / output-format:** `--chunk-ms` with v1's default (D11).
- **interaction-style / error-state:** Orca's controls and messages (D18); plain-text previews
  (D17); watermark plus refetch in the window (D16).

## Industry Insights

- MCP forbids collecting passwords, API keys or tokens through form elicitation and sends them to a
  URL flow instead; an ask refuses them and tells the agent to collect them out of band
  ([MCP elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)).
- Browsers reset an invalid date string to empty and ignore malformed min/max, so date and number
  bounds are enforced by the daemon, not only the input
  ([WHATWG input](https://html.spec.whatwg.org/multipage/input.html)).
- One schema module shared by client and server, with the server authoritative, keeps messages
  identical ([next.js #52652](https://github.com/vercel/next.js/discussions/52652)).
- Regex heuristics like rejecting nested quantifiers are a screen, not a proof; a length cap before
  matching bounds the worst case ([ReDoS via API input](https://dev.to/rxkov/redos-via-api-input-validation-how-a-single-request-stalls-the-event-loop-51kk),
  [safe-regex guide](https://www.pkgpulse.com/guides/magic-regexp-vs-regexp-tree-vs-safe-regex-regular-2026)).
  Orca's heuristics plus its 200-character cap are kept.
- Durable timers persist an absolute deadline and fire overdue ones once at start
  ([Temporal timers](https://docs.temporal.io/develop/python/workflows/timers)).
- For a list under 50 items, refetching on change is simpler than incremental deltas; when a
  sequence is used, the server stamps promoted items and the client drops anything at or below its
  watermark ([WebSocket.org reconnection](https://websocket.org/guides/reconnection/),
  [Strata Sync](https://blode.co/stratasync/docs/architecture/sync-protocol)).
- A HITL tool that fell back to a default answer after 30 s made agents give up on people, and was
  changed to wait by default ([agent-torvalds #23](https://github.com/KostiantynBushko/agent-torvalds/pull/23));
  Quirky keeps no deadline unless the agent asks for one.

## Deferred Ideas

- Rendering markdown and HTML previews in a sandboxed frame (D17).
- A setting to turn off Claude's suppression flags (D3).

## Glossary

- **Ask:** one registered question set and its state, stored by `quirky.ask`.
- **Spec:** the question set an ask carries: optional `title` and 1-10 questions.
- **Envelope:** what `wait`, `answer`, `cancel` and `expire` return: `status`, `askId`, `answers`,
  `skipped`, `summary`.
- **Draft (partial):** the per-question work in progress the window saves: `selected`, `other`,
  `note`, `draft`, `confirm`.
- **Deadline:** the absolute time from `timeoutMs` after which the ask ends `timed_out`.
- **Surfaced / queued:** a pending ask is surfaced when it is the earliest pending ask of its
  session, or has no session; any later pending ask of the same session is queued.
- **`seq`:** the value of the store-wide change counter at an ask's latest change.
- **Watermark:** the highest `seq` the window has seen.
- **Suppression flags:** the two Claude flag pairs that turn off Claude's own question tool and
  point it at `quirky ask`.
