/**
 * Making sure a managed quirkyd is serving before a client relies on it: a server that answers
 * costs one round trip; one that does not is checked on the host and, only if proven stopped
 * (an idle stop, a kill, a host reboot), started from its activated slot. A daemon that survived
 * is adopted by the new quirkyd with its terminals; after a reboot both start fresh.
 *
 * Never throws. A server that cannot be started stays `unverifiable` with the reason, and is
 * never read as evidence that its terminals exited.
 */
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import { quirkydBoundPort } from './quirkyd-managed-bound-port'
import { managedQuirkydSlot } from './quirkyd-managed-runtime-context'
import { wakeStoppedManagedQuirkyd } from './quirkyd-managed-wake'
import { resolveQuirkydRemoteContext } from '../install/quirkyd-remote-context'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'

export type QuirkydManagedServing =
  | { state: 'serving' }
  /** `boundPort` is the port the restarted server bound, which a forward must follow. */
  | { state: 'started'; boundPort: number | null }
  | { state: 'unverifiable'; detail: string }

export type QuirkydManagedServingInput = {
  environment: KnownRuntimeEnvironment
  target: SshTarget
  connection: QuirkydHostTransport
  remotePort: number
  probe: (environment: KnownRuntimeEnvironment, timeoutMs: number) => Promise<boolean>
  /** When this environment's ready control socket last heard from its server, if it has. */
  answeredAt?: (environmentId: string) => number | null
}

/** A wake refused because another update, rollback or recovery holds the host; it clears itself. */
export const MANAGED_QUIRKYD_FENCED_DETAIL =
  'An update, rollback or recovery holds this host; it was not started.'

/** The host has no active version, e.g. another desktop stopped it; a connect redeploys it. */
export const MANAGED_QUIRKYD_NOT_ACTIVATED_DETAIL =
  'This host has no activated Quirky server to start.'

const PROBE_TIMEOUT_MS = 5_000
// Why: a connect checks right after its fresh tunnel did; one verdict serves both, on that
// transport and port only, so a kill, reboot or rebind is never answered from cache.
const VERDICT_REUSE_MS = 5_000
// Why: the control socket hears a pong every 10 s while healthy, and a kill, reboot, rebind or
// stop closes it, so a recent answer on it proves serving without a fresh probe socket.
const LIVE_ANSWER_PROOF_MS = 20_000

type ServingTransport = { connection: QuirkydHostTransport; generation: number; remotePort: number }
// Why per transport: a check on a dropped connection fails, and a caller on the reconnected one
// must run its own instead of inheriting that failure as "could not be started".
type ServingCheck = ServingTransport & { check: Promise<QuirkydManagedServing>; settledAt?: number }
const checks = new Map<string, ServingCheck>()

function sameTransport(a: ServingTransport, b: ServingTransport): boolean {
  return (
    a.connection === b.connection && a.generation === b.generation && a.remotePort === b.remotePort
  )
}
export type ManagedQuirkydStartListener = {
  /** Shows "Starting managed server…" for the host. */
  starting: (target: SshTarget) => void
  /** The start finished; an `unverifiable` result carries why, with quirkyd.log's tail. */
  settled: (target: SshTarget, environmentId: string, serving: QuirkydManagedServing) => void
}

let startListener: ManagedQuirkydStartListener | null = null

/** The SSH status wiring registers where a start is shown. */
export function setManagedQuirkydStartListener(listener: ManagedQuirkydStartListener | null): void {
  startListener = listener
}

export function ensureManagedQuirkydServing(
  input: QuirkydManagedServingInput,
  now: () => number = Date.now
): Promise<QuirkydManagedServing> {
  const id = input.environment.id
  const transport: ServingTransport = {
    connection: input.connection,
    generation: input.connection.getConnectGeneration(),
    remotePort: input.remotePort
  }
  const entry = checks.get(id)
  if (
    entry &&
    sameTransport(entry, transport) &&
    (entry.settledAt === undefined || now() - entry.settledAt < VERDICT_REUSE_MS)
  ) {
    return entry.check
  }
  const answeredAt = input.answeredAt?.(id) ?? null
  const answerAge = answeredAt === null ? null : now() - answeredAt
  // Why the lower bound: a wall clock set backwards must not stretch the proof.
  if (answerAge !== null && answerAge >= 0 && answerAge < LIVE_ANSWER_PROOF_MS) {
    return Promise.resolve({ state: 'serving' })
  }
  const next: ServingCheck = { ...transport, check: checkAndStart(input) }
  checks.set(id, next)
  // A rejected check is never reused.
  void next.check.then(
    () => {
      next.settledAt = now()
    },
    () => {
      next.settledAt = -Infinity
    }
  )
  return next.check
}

/** Test-only: forget cached verdicts. */
export function resetManagedQuirkydServingForTests(): void {
  checks.clear()
}

async function checkAndStart(input: QuirkydManagedServingInput): Promise<QuirkydManagedServing> {
  if (await input.probe(input.environment, PROBE_TIMEOUT_MS)) {
    return { state: 'serving' }
  }
  let starting = false
  const serving = await wakeIfStopped(input, () => {
    starting = true
    startListener?.starting(input.target)
  })
  if (starting) {
    startListener?.settled(input.target, input.environment.id, serving)
  }
  return serving
}

async function wakeIfStopped(
  input: QuirkydManagedServingInput,
  onStarting: () => void
): Promise<QuirkydManagedServing> {
  const label = input.target.label
  try {
    const context = await resolveQuirkydRemoteContext(input.target, input.connection)
    const wake = await wakeStoppedManagedQuirkyd(
      managedQuirkydSlot(context, input.remotePort),
      onStarting
    )
    if (wake.outcome === 'started') {
      const idle = wake.readiness.health?.previousIdleStop
      const cause = idle
        ? `it had stopped after idling at ${idle.stoppedAt}`
        : 'it had stopped without an idle-stop record (crash, signal or host restart)'
      console.info(`[ssh] Started the managed Quirky server on ${label}; ${cause}.`)
      return { state: 'started', boundPort: quirkydBoundPort(wake.readiness) }
    }
    // A live process that did not answer may still be starting; it is not restarted.
    if (wake.outcome === 'serving') {
      // Why: a live PID proves the process exists, not that it answers.
      if (await input.probe(input.environment, PROBE_TIMEOUT_MS)) {
        return { state: 'serving' }
      }
      const detail = 'This host’s Quirky server process is live but is not answering.'
      console.warn(`[ssh] The managed Quirky server on ${label} is not answering: ${detail}`)
      return { state: 'unverifiable', detail }
    }
    const detail = wake.outcome === 'recovery-refused' ? wake.reason : wakeRefusal(wake.outcome)
    console.warn(`[ssh] The managed Quirky server on ${label} is not answering: ${detail}`)
    return { state: 'unverifiable', detail }
  } catch (error) {
    console.warn(`[ssh] Could not start the managed Quirky server on ${label}:`, error)
    return { state: 'unverifiable', detail: error instanceof Error ? error.message : String(error) }
  }
}

function wakeRefusal(outcome: 'not-activated' | 'unverifiable' | 'fenced'): string {
  switch (outcome) {
    case 'fenced':
      return MANAGED_QUIRKYD_FENCED_DETAIL
    case 'not-activated':
      return MANAGED_QUIRKYD_NOT_ACTIVATED_DETAIL
    case 'unverifiable':
      return 'Whether the server process is still running could not be proven, so it was not started.'
  }
}
