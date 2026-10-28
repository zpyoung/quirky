# Questions (`quirky.ask`)

`quirky.ask` stores answerable questions in its own durable FIFO and exposes them to the window, CLI, and other authenticated clients. A missing desktop window is not an unavailable outcome: session-null, CLI, mobile, and kernel-confirmation asks remain usable through their existing API surfaces.

## Public API and CLI

| Method | Request | Behavior |
|---|---|---|
| `quirky.ask/create` | `{spec, session?, worktree?, timeoutMs?}` | Validates and stores an ask; returns `{askId}`. Session/worktree default to the authenticated caller's attribution, else `null`. A positive `timeoutMs` sets a durable deadline. |
| `quirky.ask/wait` | `{askId, timeoutMs?}` | Returns the terminal envelope, or `pending` after a chunk. Each call is capped at 60,000 ms; `timeoutMs: 0` reads immediately. |
| `quirky.ask/answer` | `{askId, answers, skipped?}` | Validates and commits the submitted answer envelope. |
| `quirky.ask/cancel` | `{askId}` | Declines a still-pending ask; a finished ask is returned unchanged. |
| `quirky.ask/list` | `{pendingOnly?}` | Lists asks in creation order; pending rows identify whether they are queued. |
| `quirky.ask/updatePartial` | `{askId, partial}` | Replaces the saved draft while the ask remains pending. |
| `quirky.ask/expire` | `{askId}` | Applies the stored timeout defaults/drafts and resolves the ask as timed out. |

At most **four** `wait` calls may park concurrently in one AskService. Overflow is shed without changing the ask and returns RPC `Conflict` (`-32009`) with `data.reason: "runtime_busy"`. The CLI recognizes that typed reason and retries with a bounded delay while preserving `--chunk-ms` and `--timeout-ms`; it does not treat capacity pressure as a dropped connection. Closing the caller connection aborts only that wait and releases its slot; the durable ask remains pending.

CLI forms are `quirky ask --spec <json|@file> [--timeout-ms N] [--chunk-ms N]`, `quirky ask wait --id <askId> [--timeout-ms N] [--chunk-ms N]`, and `quirky ask cancel --id <askId>`. The spec permits up to 10 questions and 12 options per select/multiselect, with types `select`, `multiselect`, `text`, `number`, `date`, and `confirm`.

There are no Ask-specific user settings.

## Presentation and attention

- Option previews accept `markdown` or `html`. They use the package-local `react-markdown`, GFM, raw-HTML, and `rehype-sanitize` pipeline, then render static sanitized markup in an iframe with an empty `sandbox` and restrictive CSP. Script, forms, navigation/URL attributes, external resources, images/media, and embedded documents are removed or blocked. Links are non-interactive text. Hiding a preview removes its frame; normal selection and free-text answers remain available.
- A terminal answer, cancellation, or timeout summary is presentation-only and remains in Questions for four seconds. It does not change durable FIFO state or the pending badge. A promoted ask remains the queue head and is counted normally.
- Questions auto-opens only when a surfaced ask's exact session is the active session in the focused worktree view and the view has focus. It opens only if no panel is selected; opening the panel preserves terminal focus. A later user panel choice is not replaced by refreshes. Unfocused and session-null asks are not used to steal focus; the Questions badge and manual panel remain available.
- The notification policy escalates a still-pending, surfaced unattended head after three uninterrupted minutes. Queued asks do not arm timers or count as pending attention.

## Deliberately unbuilt handoff and liveness seam

`session` on an Ask is attribution, not proof of process liveness. Public `quirky.session/get` can positively report a missing session or `status: "exited"`, but this Ask wire contract has no `unavailable` terminal status and `create` is required to return `{askId}`. This package therefore does not infer unavailability from a missing window, unknown status, reconnect, or a session attribution alone.

The orchestration API's `quirky.orchestration/ask` is a separate Run-owned question. `quirky.ask` calling it as a plugin cannot forward the original caller's authenticated session/Run authority; `from` and `terminal` are equality assertions, not delegated authority. Heimdall's `answer` control is bound to an exact local watcher and worker-message ID and does not expose a public attachment mapping from an Ask caller to that worker. Native provider-question bridges are likewise not a generic public Ask handoff. A safe composition needs a public authenticated caller-to-Run/worker attachment API; an `unavailable` result also needs an approved Ask wire/API contract and migration of callers outside this package. No no-window fallback or terminal-status substitution is used here.
