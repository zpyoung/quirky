# m2-ask-parity decisions

## D1: In scope: the roadmap's five ask-parity points plus what they need to be testable
- **Question:** brainstorming step 1, scope: which flows of ask.md this item owns
- **Options:** only the roadmap's list (number and date questions; defaults, timeouts, credential refusal, draft persistence; a fresh sequence number for a queued second ask); that list plus the pieces of Orca's spec model they depend on; everything m0-core D32 deferred to "M2's ask parity"
- **Chose:** the roadmap's list plus what it depends on: Orca's full question schema and its validation (`required`, text `pattern`/`format`, number `integer`/`min`/`max`, `default` on every type, 10-question and 12-option limits, regex safety, Orca's error text); server-side answer validation; the envelope's `summary`; Orca's select and multiselect free-text model (`note`, `other`); a durable server-side deadline; a per-session queue so a "queued second ask" exists; `--chunk-ms`; and Claude's AskUserQuestion suppression flags (D3). Option previews are accepted and shown as plain text (D17).
- **Why:** defaults only mean something with typed questions and a deadline, the fresh sequence number only with a queue, and the draft fallback at a timeout needs Orca's draft shape. m1-providers D35 assigned the Claude suppression flags to this item.
- **Evidence:** docs/roadmap.md M2 "orca ask parity"; research/orca-features/ask.md "The question spec", "Queued asks", "Registry lifecycle"; docs/loop/decisions/m1-providers.md D35
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D2: Out of scope: hand-off, liveness, the wait cap, the 3-minute notification, rich previews, attention markers
- **Question:** brainstorming step 1, scope boundary against m0-core D32's longer list
- **Options:** n/a
- **Chose:** out, named in the spec's non-goals: orchestration hand-off and native-chat bridges (they need orchestration, M5); pane liveness and the `unavailable` status (Quirky asks don't depend on an attached window, as in v1); the 4-wait concurrency cap (Quirky has no long-poll budget to protect); the 3-minute OS notification (the notifications feature); markdown/HTML preview rendering; the 4-second collapsed summary; tab, worktree and palette attention markers; i18n; a phone surface; `ask.subscribe` streaming with epochs (events plus `quirky.ask/list` cover it).
- **Why:** none is in the roadmap's list; each belongs to another feature or has no Quirky counterpart
- **Evidence:** docs/roadmap.md M2; research/orca-features/ask.md "Hand-off to the orchestration coordinator", "Wait concurrency gate", "Unattended asks escalate"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D3: The Claude suppression flags land here, as a launch hook in `quirky.ask`
- **Question:** brainstorming step 1: m1-providers D35 named this item for Claude's ask-question suppression flags; the roadmap list doesn't mention them
- **Options:** follow D35 and build them; record a new decision moving them elsewhere
- **Chose:** build them. `quirky.ask` contributes a `launch-hook` for Claude terminal launches that adds `--disallowedTools AskUserQuestion` and `--append-system-prompt "<text pointing at quirky ask>"`, each pair only when the launch doesn't already carry it, gated on the launched `claude --version` being at least 1.0.51, failing open (no flags) when the probe fails, retrying after 30 minutes.
- **Why:** earlier decisions bind; the kernel already has launch hooks with an agent filter (packages/protocol/src/plugins.ts:197-215), so the ask plugin can do it through the public API
- **Evidence:** docs/loop/decisions/m1-providers.md D35; research/orca-features/ask.md "Claude AskUserQuestion suppression"; plugins/quirky.agent-status/quirky-plugin.json:34-40
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a user wants Claude's own chat questions in Quirky sessions (then a setting)
- **Source:** locked by docs/loop/decisions/m1-providers.md D35

## D4: Brainstorming runs headless with the standard gray areas, all selected
- **Question:** brainstorming steps 3-4: visual companion, adhd, which gray areas
- **Options:** n/a
- **Chose:** no visual companion, no adhd, the standard catalog: API (response-format, error-responses), CLI (output-format, flag-design, exit-codes, error-recovery), Data (input-format, error-handling, idempotency), Visual (interaction-style, error-state). Every area selected.
- **Why:** docs/loop/LOOP.md "Answering a skill's questions"
- **Evidence:** docs/loop/LOOP.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D5: The question schema is Orca's, plus Quirky's optional `title`
- **Question:** input-format: what a spec may contain
- **Options:** Orca's schema exactly; Orca's plus v1's `title`
- **Chose:** Orca's six types and fields (common `id`, `question`, `header`, `required`; select/multiselect `options` with `value`, `label`, `description`, `preview`; text `multiline`, `pattern`, `format`; number `integer`, `min`, `max`; `default` per type), 1-10 questions, 1-12 options, plus the spec's optional `title`, which v1, the kernel confirmations and the Questions panel already use. The stored spec is the validated canonical form, so unknown fields are dropped, as Orca's validator does.
- **Why:** the doc is the requirement; dropping `title` would break m0-core's confirmations and panel
- **Evidence:** research/orca-features/ask.md "The question spec"; packages/daemon/src/plugins/confirm.ts:99; plugins/quirky.ask/src/store.ts:16
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by research/orca-features/ask.md

## D6: One shared validator, run by the CLI and again by the daemon, with Orca's messages
- **Question:** error-responses and exit-codes: where specs are checked and what a refusal looks like
- **Options:** CLI only; daemon only; both through one module
- **Chose:** one module inside `quirky.ask`, run by `quirky ask` before registering and by `quirky.ask/create` for every caller. Errors are Orca's field-path messages (`questions[0].id: credential-shaped id is not permitted`) joined with `; `. The daemon refuses with InvalidParams carrying that text; the CLI prints it and exits 2, Quirky's usage exit code (m0-core D34), where Orca exits 1.
- **Why:** research says the server must be authoritative and the client check is only a fast path; a shared module keeps both messages identical
- **Evidence:** https://github.com/vercel/next.js/discussions/52652 ; docs/loop/decisions/m0-core.md D34; research/orca-features/ask.md "The question spec"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D7: Credential refusal is Orca's two checks, and plugin-registered asks skip the text check
- **Question:** error-handling: which asks the credential check covers
- **Options:** every ask, as Orca does; only asks registered by clients (CLI, agents, API); nothing for plugins at all
- **Chose:** `masked` and `sensitive` keys are refused on every ask. The credential-shaped text check (id, question, option values; Orca's normalization and trigger words, including the bare word `pass`) runs on asks registered by a client, not on asks a plugin registers.
- **Why:** Quirky's own plugins put text they don't control into asks: the kernel's install confirmation lists contribution IDs, and the structured session's permission prompt quotes tool input (`Allow Bash: export API_TOKEN=…`). Refusing those would break confirmations and permission prompts without stopping any credential collection, which is what the check is for. Orca has no plugin callers.
- **Evidence:** packages/daemon/src/plugins/confirm.ts:96-105; plugins/quirky.structured/claude-runner.ts:216-232; https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a third-party plugin starts asking for secrets through asks
- **Source:** assumed — autonomous

## D8: The daemon validates answers, and an omitted question counts as skipped
- **Question:** error-responses: what `quirky.ask/answer` accepts
- **Options:** Orca's rule, where every question must be answered or listed in `skipped`; the same but an omitted question counts as skipped
- **Chose:** Orca's validation (unknown answered or skipped ID, a `required` question skipped, an ID both answered and skipped, a wrong shape or out-of-domain value: the whole submission is refused with InvalidParams and the ask stays pending; select values must be options unless `source: "other"`; the stored label and source are rebuilt from the spec), except that a question neither answered nor listed counts as skipped, unless it is required.
- **Why:** number and date answers need domain checks; keeping omitted-means-skipped keeps m0-core's `answer` contract, where `skipped` is optional
- **Evidence:** research/orca-features/ask.md "RPC methods"; plugins/quirky.ask/quirky-plugin.json `answer` params
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D9: The deadline lives in the daemon, is stored, and survives a restart
- **Question:** data idempotency and error-recovery: how `--timeout-ms` works
- **Options:** v1's CLI-side deadline that cancels the ask; Orca's stored absolute deadline resolved by the daemon
- **Chose:** `quirky.ask/create` takes `timeoutMs`; the ask stores `expiresAt` (clamped to the largest date). When it passes, the ask resolves `timed_out`: each question takes its `default` (`source: "default"`), else its draft parsed with the submit rules (`source: "input"`, an unparseable draft never coerced), else it is skipped. The store holds `timed_out`. Timers are re-armed from `expiresAt` when the plugin activates, and an ask whose deadline passed while the daemon was down resolves then. `quirky ask --timeout-ms` passes the value; the CLI no longer cancels.
- **Why:** the doc's timeout fallback needs the daemon (defaults and drafts live there); research says persist an absolute UTC deadline and fire overdue ones once on start
- **Evidence:** research/orca-features/ask.md "Registry lifecycle"; https://docs.temporal.io/develop/python/workflows/timers
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by research/orca-features/ask.md

## D10: `quirky ask wait --timeout-ms` stays and times the ask out with the same rules
- **Question:** flag-design: v1's `wait --timeout-ms`, which Orca doesn't have
- **Options:** drop it; keep v1's cancel-and-print-timed_out; keep it and resolve through the daemon's timeout rules
- **Chose:** keep it. When it elapses the CLI calls a new method, `quirky.ask/expire { askId }`, which resolves a pending ask exactly as a deadline does and returns the envelope; an ask that already finished comes back unchanged.
- **Why:** v1 behaves as it does today (roadmap M0 exit test), and the stored status should say `timed_out`, not `declined`
- **Evidence:** docs/v1.md "CLI"; plugins/quirky.ask/cli.ts:24-55
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D11: `--chunk-ms` is accepted, and without it the CLI still waits to the end
- **Question:** flag-design and output-format: Orca's chunked wait
- **Options:** Orca's default 100-second chunk; v1's wait-until-terminal, plus `--chunk-ms` when given
- **Chose:** `quirky ask` and `quirky ask wait` accept `--chunk-ms N`. With it, the CLI waits at most N ms and then prints `{"status":"pending","askId":…,"instruction":"quirky ask wait --id <askId>"}` and exits 0, leaving the ask answerable. Without it, v1's behaviour.
- **Why:** skills written for `orca ask` pass `--chunk-ms` (v1.md promises they work unchanged); changing the default would change v1
- **Evidence:** research/orca-features/ask.md "Registration and the wait loop"; docs/v1.md "`quirky ask` keeps the shape of `orca ask`"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D12: Drafts are Orca's per-question partial, saved by the window 500 ms after typing stops
- **Question:** data input-format: draft shape and when it is saved
- **Options:** raw widget state; Orca's normalized partial (`selected`, `other`, `note`, `draft`, `confirm`)
- **Chose:** Orca's partial. New method `quirky.ask/updatePartial { askId, partial }` replaces the stored draft (filtered to known question IDs, shapes checked) and returns `{ ok: true }`, or `{ ok: false }` for an ask that already finished; an unknown ask is NotFound. Every `Ask` carries `partial`. The card starts from it, and saves 500 ms after the last change.
- **Why:** the doc's draft and timeout flows depend on this shape; the 500 ms debounce is Orca's
- **Evidence:** research/orca-features/ask.md "Draft persistence"; Orca src/renderer/src/components/fork-ask-question-tool/ask-question-draft.ts
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by research/orca-features/ask.md

## D13: Asks from one session queue, and asks with no session never do
- **Question:** data idempotency: what "a queued second ask" is in Quirky, which shows every pending ask (m0-core D25)
- **Options:** keep showing every pending ask (no queue exists, so the requirement is vacuous); Orca's one live card per pane, keyed by Quirky's session
- **Chose:** a FIFO queue per session: the earliest pending ask of a session is surfaced and the rest wait, marked `queued`. Asks with no session (a CLI outside a session, the kernel's confirmations for a caller without one) are always surfaced. A queued ask's deadline counts from its registration. Cancelling or timing out a queued ask removes it without touching the head. The queue is derived from the stored rows, so it survives a restart.
- **Why:** the doc is the requirement, and the roadmap names a queued second ask. This supersedes m0-core D25's "a second ask is visible at once" for two asks from the same session.
- **Evidence:** research/orca-features/ask.md "Queued asks"; docs/loop/decisions/m0-core.md D25, D33
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** people miss a same-session question because it waits behind another
- **Source:** supersedes m0-core D25

## D14: One persisted counter stamps every ask change, and a promotion gets the next value
- **Question:** response-format: the sequence number
- **Options:** per-ask version; one store-wide counter
- **Chose:** a store-wide counter that never goes back, even after rows are deleted. Creating, saving a draft, resolving and promoting each take the next value; the ask records it as `seq`, and the event for that change carries it. A promoted ask's `seq` is greater than the resolve that promoted it.
- **Why:** the Orca defect is a promotion that reused its registration value; the doc's fix is "the next value of `ask_seq`"
- **Evidence:** research/orca-features/ask.md "Queued asks", "Storage"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by research/orca-features/ask.md

## D15: Events: `created`, `surfaced`, `updated` and `resolved`, each with `seq`; only surfacing notifies
- **Question:** response-format: what the plugin announces
- **Options:** reuse `created` for a promotion; a new `surfaced` event
- **Chose:** `created { ask, seq }` for every new ask (its `queued` flag says whether it is showing); `surfaced { ask, seq }` when a queued ask becomes its session's head; `updated { askId, partial, seq }` for a saved draft; `resolved { askId, envelope, seq }`. The notification and the self-opening Questions panel happen when an ask surfaces (at creation if it isn't queued, else at promotion), never for a queued one.
- **Why:** Orca tells the window about an ask only when it becomes head; existing listeners of `created` and `resolved` keep working
- **Evidence:** research/orca-features/ask.md "Queued asks"; apps/desktop/src/bun/events.ts:24-30
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D16: The window refetches on events and drops any event at or below its watermark
- **Question:** loading pattern: how the panel uses `seq`
- **Options:** keep refetching the list on every event (no watermark, so `seq` is unused); apply events incrementally with a watermark; refetch on events, but ignore events whose `seq` is not above the highest seen
- **Chose:** the third. The panel shows surfaced asks in creation order, its badge counts them, and its `ui.state` report lists them and the queued count. The desktop dock badge (shell code) keeps counting every pending ask.
- **Why:** research says a full refetch is the right default under 50 items; the watermark is what makes a stale-`seq` promotion a visible bug, so the defect test means something
- **Evidence:** https://websocket.org/guides/reconnection/ ; https://blode.co/stratasync/docs/architecture/sync-protocol ; research/orca-features/ask.md "Renderer data flow"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D17: Option previews are kept and shown as plain text
- **Question:** interaction-style: Orca's `preview` (markdown or HTML in a sandboxed iframe)
- **Options:** refuse the field; accept and ignore it; accept it and show the content as plain text behind "Show preview"
- **Chose:** accept and validate it (`format` markdown or html, `content` a string), show the raw content as preformatted text behind a "Show preview" / "Hide preview" toggle, never as HTML
- **Why:** specs written for Orca keep working and the content is visible; rendering untrusted HTML needs a sanitizer and CSP work this item doesn't need
- **Evidence:** research/orca-features/ask.md "Preview sandbox"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** agents rely on previews for diagrams or rendered markdown
- **Source:** assumed — autonomous

## D18: The card follows Orca's controls and client-side messages
- **Question:** interaction-style and error-state: how each type is answered in the window
- **Options:** keep v1's controls and add number and date inputs; Orca's controls
- **Chose:** Orca's: select and multiselect rows with one free-text input "Add your own answer" under the options (a note with a pick, `other` without; clicking the picked select row clears it); text input or textarea; `<input type=number>` with step 1 when `integer`, min and max; `<input type=date>`; Yes/No buttons for confirm. A question shows its header in bold with the question under it, else the question, and "(optional)" unless required. Submit checks every question first and shows Orca's messages under each failing one ("This question is required.", "Enter a valid email address.", "Enter a valid URL.", "Doesn't match the expected format.", "Enter a number.", "Enter a whole number.", "Enter a number of at least {min}.", "Enter a number of at most {max}.", "Enter a valid date."), blocking the submit. v1's Dismiss button stays and declines.
- **Why:** the doc is the requirement; the free-text model is what makes `note` and `other` reachable
- **Evidence:** research/orca-features/ask.md "Per-type controls and client-side validation"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/ask.md

## D19: Terminal envelopes carry Orca's `summary`
- **Question:** response-format: envelope fields
- **Options:** keep v1's envelope; add `summary`
- **Chose:** add `summary` to every envelope: one line per answered question in spec order, `<header or question>: <rendered value>` (option label, labels plus `other` joined with `, `, Yes/No, or the value); `""` for pending and declined
- **Why:** the doc's envelope has it and agents read it
- **Evidence:** research/orca-features/ask.md "Answer envelope"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/ask.md

## D20: Approach: extend `quirky.ask` in place with Orca's pure modules ported beside it
- **Question:** brainstorming step 8: approaches
- **Options:** (A) extend the existing plugin: port Orca's schema, field validation, answer validation, value parsing and timeout builder as pure modules, and grow `AskService` with seq, queue, drafts and deadlines; (B) rebuild Orca's registry and subscribe stream wholesale; (C) validate in the CLI only and keep the service as is
- **Chose:** A
- **Why:** B brings epochs, streaming frames and hand-off Quirky doesn't need (D2, D16); C leaves API callers unchecked and can't do timeouts with defaults (D6, D9). A keeps the plugin's API and every existing caller (confirmations, structured permission prompts, the desktop badge, the CLI link) working.
- **Evidence:** plugins/quirky.ask/asks.ts; research findings in the logic spec's Industry Insights
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D21: Tests drive the daemon API, the CLI's command functions and the window module
- **Question:** essential coverage, success criteria: how each scenario is tested
- **Options:** n/a
- **Chose:** API scenarios use `startAsk` (an in-process daemon with real RPC clients on a temporary home, plugins/quirky.ask/test/support.ts); CLI scenarios run `commands` from `cli.ts` through `testCli`, plus one run of the real `quirky` binary; window scenarios run the UI module under happy-dom, and the logic spec's UI scenarios are also run with `quirk:using-apps-like-a-user`. Claude suppression uses the m1-providers e2e harness with a fake `claude`. Nothing reads the real home or launches a real agent CLI.
- **Why:** docs/loop/LOOP.md step 6 and the existing test patterns
- **Evidence:** plugins/quirky.ask/test/support.ts; plugins/quirky.agents/test/support/e2e.ts
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D22: A `deadlines` job wakes the plugin after a restart
- **Question:** spec review F1 (HIGH): `quirky.ask` activates lazily, so after a daemon restart no deadline fires and no `resolved` event goes out until something calls the plugin; the desktop badge listens only to events
- **Options:** accept the gap (stored state is right on every read); make the plugin activate at startup; a scheduler `job` whose first run activates it
- **Chose:** a `job` `deadlines` (interval 60s, initial delay 1s) whose handler sweeps overdue asks. Its first run activates the plugin about a second after the daemon starts, which re-arms every timer.
- **Why:** subscribers that never call (the dock badge) would otherwise show a timed-out ask as pending indefinitely; a job uses the public plugin API and the kernel's scheduler, where an activation flag would change the plugin's lazy contract for every daemon
- **Evidence:** packages/daemon/src/plugins/scheduler.ts:281-290 (a run resolves the implementation, activating the plugin); plugins/quirky.ask/quirky-plugin.json `"activation": "lazy"`
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** keeping `quirky.ask` active in every daemon shows up in the memory budget
- **Source:** assumed — autonomous

## D23: Overdue asks are resolved before anything else touches them, and never surface
- **Question:** spec review F5, F6 (MEDIUM): at startup an overdue head's resolution would promote and announce an overdue queued ask; a cancel on an overdue ask whose timer hadn't fired would store `declined`
- **Options:** n/a
- **Chose:** a sweep resolves every overdue ask first without promoting or notifying, then promotes each affected session's lowest remaining pending ask; promotion skips (times out) an overdue ask; every method that reads or changes an ask, `cancel` included, first applies a passed deadline
- **Why:** the deadline is the earliest event, so it wins; Orca's timeout is the stored outcome
- **Evidence:** research/orca-features/ask.md "Registry lifecycle"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D24: A multiselect's free text is saved as `other` whether or not options are picked
- **Question:** spec review F4 (HIGH): Orca's draft serializer saves free text as `note` when anything is picked, but its timeout builder reads multiselect free text only from `other`, so the text is lost at a timeout
- **Options:** port Orca as is (keep the loss); save multiselect free text as `other` always
- **Chose:** `other` for multiselect always; `note` only for select
- **Why:** the answer shape for multiselect has `other`, not `note`; this is an Orca inconsistency, not a requirement
- **Evidence:** Orca src/renderer/src/components/fork-ask-question-tool/ask-question-draft.ts:27-42; src/main/fork-ask-question-tool/ask-registry-timeout-answers.ts:110-123
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D25: The version probe runs the configured command as quoted words
- **Question:** spec review F3 (HIGH): the probe interpolated the configured command into a shell string
- **Options:** n/a
- **Chose:** tokenize the command, single-quote each token, append `--version`, run through `context.launch.commandArgv`
- **Why:** the launch itself runs the command as literal tokens (m1-launch-settings' injection-safety contract); the probe must not run anything the launch wouldn't
- **Evidence:** plugins/quirky.agents/src/core/shell.ts; docs/loop/decisions/m1-launch-settings.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D26: The suppression hook reads the current configuration, even for a resume
- **Question:** spec review F2 (MEDIUM): a resumed session replays its saved arguments, which the hook can't see, so a flag present only in the saved arguments could be added twice
- **Options:** pass the launch record to hooks (a kernel API change); accept the edge
- **Chose:** accept it. Hook args aren't recorded, so a resume gets the pairs exactly once unless the user's own saved arguments carried one of the two flags and the current configuration no longer does.
- **Why:** the hook input has no launch record, and widening the kernel's hook contract for this edge is out of proportion; a doubled `--disallowedTools AskUserQuestion` is harmless
- **Evidence:** packages/protocol/src/plugins.ts:197-209; plugins/quirky.agents/src/core/plan.ts:436-443
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a user reports a doubled system prompt on resume
- **Source:** assumed — autonomous

## D27: Spec review: answer refusals use Orca's text; the prepass reference and heading checks are dismissed
- **Question:** the rest of the Codex spec review (F7 LOW, F9 HIGH, F10-F30 MEDIUM)
- **Options:** n/a
- **Chose:** F7 accepted: number refusals use Orca's `value is outside the question domain`. F9 (no Purpose/Overview heading) dismissed: the logic-spec rubric's sections are the ones the spec has. F10-F30 dismissed: they are CLI commands, method names, example values and a research link outside the worktree, which the prepass reads as paths or commands.
- **Why:** the doc is the requirement for messages; the dismissed ones are mechanical false positives
- **Evidence:** /private/tmp review output sr1 (gate.json)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## Progress
Specs written and reviewed (D1-D27). Building with subagent-driven-development; journal in the session scratchpad. Wave 1 (core modules A1-A4) done in worktrees.
