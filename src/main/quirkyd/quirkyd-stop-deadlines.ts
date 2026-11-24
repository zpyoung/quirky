/** Kept dependency-free: the short-lived stop-completion command imports these too. */
export const QUIRKYD_SHUTDOWN_DEADLINE_MS = 15_000
export const QUIRKYD_DAEMON_RETIREMENT_TIMEOUT_MS = 5_000

export const QUIRKYD_STOP_COMPLETION_POLL_MS = 250
// Retirement (request + session count, each bounded) runs before the shutdown deadline starts.
const STOP_COMPLETION_BUDGET_MS =
  2 * QUIRKYD_DAEMON_RETIREMENT_TIMEOUT_MS + QUIRKYD_SHUTDOWN_DEADLINE_MS + 5_000
export const QUIRKYD_STOP_COMPLETION_POLL_ATTEMPTS = Math.ceil(
  STOP_COMPLETION_BUDGET_MS / QUIRKYD_STOP_COMPLETION_POLL_MS
)
