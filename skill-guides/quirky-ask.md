---
name: quirky-ask
description: >-
  Use `quirky ask` to ask the user a question and block until they answer it —
  select/multiselect/text/number/date/confirm questions with a structured JSON
  answer envelope back, for a genuine human decision the agent cannot
  determine by reading code, config, or tests. Not for permission to proceed,
  and not the same as `quirky orchestration ask` (worker-to-coordinator agent
  messaging inside an orchestration run — see the orchestration skill for
  that). Triggers include "quirky ask", "ask the user", "ask a question and
  wait for the answer", or needing the user to choose between options,
  confirm a decision, or supply a non-secret value.
---

# Quirky Ask

`quirky ask` asks the _user_ — not another agent — a structured question and blocks until they answer, decline, or a timeout you opted into expires. It exists for one thing: a genuine human decision you cannot make yourself. It is not `quirky orchestration ask`, which is worker-to-coordinator messaging between agents inside an orchestration run; see the `orchestration` skill for that.

`QUIRKY` is a placeholder for the executable you resolved in the stub; substitute it before running.

## When To Use

- Use it when the answer is a real judgment call only the user can make — choosing between two valid approaches, deciding whether to proceed with something destructive, or a value that genuinely isn't discoverable in the repo or environment.
- Do not use it for something you can determine by reading code, config, docs, or running a command. Read first; ask second.
- Do not use it to ask permission to proceed with what the user already asked for.
- Even inside an orchestration worker with no attached UI, call `quirky ask` — not `orchestration ask` — for a human decision. It automatically hands off to the coordinator when no UI is attached to your pane, and only returns `unavailable` when there's truly nowhere for the question to go.

## The Three Commands

```bash
QUIRKY ask        --spec <json|@file> [--timeout-ms <n>] [--chunk-ms <n>] [--json]
QUIRKY ask wait   --id <ask_id> [--chunk-ms <n>] [--json]
QUIRKY ask cancel --id <ask_id> [--json]
```

- `--spec` is inline JSON or `@path/to/file.json` (a relative path resolves against your cwd). Invalid JSON or a spec that fails schema validation exits non-zero with a message naming the offending field, e.g. `questions[0].id: id is required and must be a non-empty string`.
- `--timeout-ms` is an opt-in automation deadline, in milliseconds. Omit it and the ask waits on the user indefinitely — attended asks have no wall-clock deadline, only liveness tracking.
- `--chunk-ms` controls how long _this invocation_ blocks before returning control to you if still unanswered — default 100000 (100s). It is not a deadline: a `pending` result only means "not answered within this chunk," not "gave up." You don't need to tune it.
- `--json` is accepted on all three but changes nothing: every one of these commands always prints bare JSON on stdout, `--json` or not, because the consumer is always a model.
- `quirky ask cancel` resolves a pending ask as `declined`. Use it if you registered an ask you no longer need answered (e.g. you found the answer another way while waiting). Cancelling an ask that's already resolved, or an unknown id, isn't an error — it just returns that ask's actual current envelope.
- Pane/worktree attribution (which UI the ask is routed to) is automatic, from environment variables Quirky sets inside its own terminals (`QUIRKY_PANE_KEY`, `QUIRKY_TERMINAL_HANDLE`, `QUIRKY_WORKTREE_ID`, `QUIRKY_WORKSPACE_ID`). There is no flag for it.

## Register → Wait Loop

`quirky ask` does two things in one call: it registers the ask, then blocks for one chunk.

1. The moment the ask is accepted, it prints the registration line first: `{"status":"registered","askId":"ask_01J..."}`.
2. It then blocks up to `--chunk-ms` (default 100s) waiting for the user.
3. If the user answers inside the chunk, it prints the terminal envelope and exits — done.
4. If the chunk elapses first, it prints a `pending` envelope and exits:

   ```json
   { "status": "pending", "askId": "ask_01J...", "instruction": "quirky ask wait --id ask_01J..." }
   ```

   This is **not a failure and not a timeout** — the user simply hasn't answered yet. Resume in a new call:

   ```bash
   QUIRKY ask wait --id ask_01J...
   ```

5. Repeat step 4 with `ask wait` for as many chunks as it takes. **This loop is yours to run across separate tool calls — never try to loop it inside one process or one blocking call.** The chunk size exists because agent harnesses cap how long a single shell invocation may run, well under the smallest known harness default; a `pending` envelope is the CLI handing control back to you before that cap bites, and it keeps handing it back every chunk until someone answers.

`ask wait` is safe to call more than once: on a still-pending ask it blocks again; on an ask that already resolved, it returns the same terminal envelope immediately, every time — a lost response never strands you or duplicates the ask.

Worked example:

```bash
QUIRKY ask --spec '{"questions":[{"id":"db_engine","type":"select","question":"Which database?","options":[{"value":"postgres","label":"PostgreSQL"},{"value":"mysql","label":"MySQL"}]}]}'
```

```json
{"status":"registered","askId":"ask_01J000000000000000000001"}
{"status":"pending","askId":"ask_01J000000000000000000001","instruction":"quirky ask wait --id ask_01J000000000000000000001"}
```

```bash
QUIRKY ask wait --id ask_01J000000000000000000001
```

```json
{
  "status": "answered",
  "askId": "ask_01J000000000000000000001",
  "answers": { "db_engine": { "value": "postgres", "label": "PostgreSQL", "source": "option" } },
  "skipped": [],
  "summary": "Database: PostgreSQL"
}
```

## Exit Codes And Status

Every registered outcome — including a decline — exits **0**. The outcome lives entirely in `status`; a non-answer is not a process failure.

Non-zero exit means a usage error, nothing else: invalid `--spec` JSON, a schema validation failure, a missing required flag, or no reachable Quirky runtime. Fix the input and retry those — never retry because the user didn't answer.

| `status`      | terminal? | meaning                                                                                                                                                                                                      |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `registered`  | no        | first line printed; ask accepted, chunk wait starting                                                                                                                                                        |
| `pending`     | no        | chunk elapsed unanswered — resume with `ask wait`                                                                                                                                                            |
| `answered`    | yes       | user answered every question                                                                                                                                                                                 |
| `partial`     | yes       | user submitted with ≥1 question skipped                                                                                                                                                                      |
| `declined`    | yes       | user closed the card, interrupted the turn, or you ran `ask cancel` — these are indistinguishable in the envelope                                                                                            |
| `timed_out`   | yes       | `--timeout-ms` elapsed: each question resolves to its declared `default` (`source: "default"`) if one exists, else the user's own in-progress answer if they'd gotten that far, else it lands in `skipped[]` |
| `unavailable` | yes       | no capable surface — see below                                                                                                                                                                               |

**A `declined` result is a normal answer to reason about, not an error to retry.** The natural instinct on a non-answer is to ask again; resist it — the user chose not to answer, and re-asking the same question doesn't change that.

**`unavailable` has two different shapes**, depending on when it happens — don't assume `askId` is present without checking:

- At registration time, when no attached UI exists and there's nowhere to hand the ask off to: `{"status":"unavailable","reason":"..."}` — no `askId`, since one was never issued. The reason is one of two literal strings: `"no attached UI and no active orchestration run to hand off to"`, or `"no attached UI: set QUIRKY_PANE_KEY, QUIRKY_TERMINAL_HANDLE, QUIRKY_WORKTREE_ID, or QUIRKY_WORKSPACE_ID"` if Quirky couldn't even attribute you to a pane.
- On `wait`/`cancel` against an id that's unknown or expired, or whose owning pane disconnected and didn't reconnect within a 10-minute grace window: the full terminal shape — `{"status":"unavailable","askId":"...","reason":"...","answers":{},"skipped":[...],"summary":"..."}`.

## Question Schema

A spec is a flat array of questions — no branching; call `quirky ask` again if you need to branch on an answer. Limits: **≤10 questions** per ask, **≤12 options** per select/multiselect question. 3–5 questions is the practical target; the caps are a backstop, not something to design toward.

Every question has:

- `id` _(required, string, non-empty)_ — **you assign it**, and it must be unique within the spec; duplicates are a validation error. Answers key back by `id`, so pick something stable.
- `question` _(required, string)_ — the prompt text.
- `header` _(optional, string)_
- `required` _(optional, boolean)_ — see Escape Hatches below; this does **not** make the question un-skippable.
- `type` — one of the six below, each with its own extra attributes.

| type          | extra attributes                                                                                                        | `default` domain                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `select`      | `options[]`: `{value, label, description?, preview?}`                                                                   | one option's `value`                             |
| `multiselect` | `options[]` (same shape)                                                                                                | array of option `values`                         |
| `text`        | `multiline?`, `pattern?` (regex, ≤200 chars, rejected if it nests repetition like `(a+)+`), `format?: "email" \| "url"` | string matching `pattern`/`format` if set        |
| `number`      | `integer?`, `min?`, `max?`                                                                                              | number within `min`/`max`, integral if `integer` |
| `date`        | —                                                                                                                       | ISO 8601 `YYYY-MM-DD`, a real calendar date      |
| `confirm`     | —                                                                                                                       | boolean                                          |

An option (`select`/`multiselect`) is `{value, label, description?, preview?}` — `value` and `label` are required strings; `preview` is `{format: "markdown" | "html", content: string}` for a richer option write-up, rendered sandboxed in the card UI.

**`default` applies only when `--timeout-ms` expires** — never on an ordinary submit, even if the user leaves a question blank (that's a skip, not a default). Its value is validated against the question's own domain at registration time, same as any other field — an out-of-domain default is rejected before the ask is ever registered.

## Escape Hatches Are Structural

Every `select`/`multiselect` question always accepts free text ("other") in addition to its declared options, and can always be skipped — regardless of what you wrote in the spec.

`required: true` removes only the skip. It never removes the free-text escape hatch; there is no way to force a user into exactly one of your declared options.

Treat a `source: "other"` answer as a signal, not an edge case: it means your option set missed the answer the user actually wanted. Use the free text directly rather than mapping it back onto your nearest option, and widen the options if you ask again.

## Credential Refusal

Validation rejects a question outright if either is true:

- `masked` or `sensitive` appears as a key anywhere on the question object, with any value — there is no masked-input mode, so declaring one is always an error.
- the `id`, `question` text, or any `options[].value` is **credential-shaped**: after normalizing (splitting `snake_case`, `camelCase`, `ACRONYMCase`, and letter/digit boundaries into separate words), it contains `password`/`passphrase`, `secret`, `token`, `api key`, `credential`, or `private key` (case-insensitive). This catches `db_password`, `authToken`, and `MYAPIKEY`, not just the bare words.

Only `id`, `question`, and option `value` are checked — `label`, `description`, `header`, and `default` text are not. Don't try to smuggle a credential-shaped field past the filter through those; the check exists to keep secrets out of the transcript, not to be defeated.

**Do this instead:** never ask for a credential through `quirky ask`. Tell the user what you need and have them supply it out of band — an env var, a config file, a secrets manager entry — rather than typing it into an ask's answer, which lands in the transcript in plaintext and gets replayed into model context on reload. A rejected ask costs a round trip, so don't design around the filter; route the request around the tool instead.

## Answer Shapes

`answers` is keyed by question `id`; a skipped question is omitted there and listed by id in `skipped[]` instead. `summary` is one rendered line per question — quote it rather than re-deriving your own text.

| type          | `answers[id]` shape                                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select`      | `{value: string, label?: string, note?: string, source: "option" \| "other" \| "default"}` — `"other"` puts free text in `value` with no `label`; `note` is optional free text alongside a picked option |
| `multiselect` | `{values: string[], labels: string[], other?: string, source: "options" \| "default"}` — parallel arrays in option order; free-text-only is empty arrays plus `other`                                    |
| `text`        | `{value: string, source: "input" \| "default"}`                                                                                                                                                          |
| `number`      | `{value: number, source: "input" \| "default"}`                                                                                                                                                          |
| `date`        | `{value: "YYYY-MM-DD", source: "input" \| "default"}`                                                                                                                                                    |
| `confirm`     | `{value: boolean, source: "input" \| "default"}`                                                                                                                                                         |

## Next Action

Register with `quirky ask --spec ...`. On `pending`, resume with `quirky ask wait --id <askId>` in a new call — don't loop inside one process. On any terminal status, including `declined`, read `status`/`answers`/`skipped` and move on; don't re-ask.
