// Composition root for the local diagnostics lane: wires the local NDJSON sink into the
// active tracer, and exposes a single init/shutdown pair the main process calls from
// `src/main/index.ts`. Nothing here leaves the machine.
//
// QUIRKY_DIAGNOSTICS_DISABLED=1 disables local file writes; CI detection disables everything.

import { createLocalFileSink, type LocalFileSink } from './local-file-sink'
import { getTraceFilePath } from './logs-directory'
import { setActiveSink, startSpan } from './tracer'
import { setSecurePathHardeningReporter } from '../../shared/secure-path-hardening-report'

const CI_ENV_VARS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION'
] as const

export type ObservabilityConsent = {
  /** Whether the local NDJSON sink is active. */
  readonly localFileEnabled: boolean
  readonly disabledReason?: 'quirky_diagnostics_disabled' | 'ci'
}

function envOn(name: string): boolean {
  const v = process.env[name]
  if (!v) {
    return false
  }
  const norm = v.trim().toLowerCase()
  return norm === '1' || norm === 'true'
}

function inCI(): boolean {
  return CI_ENV_VARS.some((v) => process.env[v] !== undefined && process.env[v] !== '')
}

/** Resolve the per-launch consent state for this lane. Pure — reads only
 *  process.env, so callers can re-evaluate any time without holding state. */
export function resolveObservabilityConsent(): ObservabilityConsent {
  if (inCI()) {
    return { localFileEnabled: false, disabledReason: 'ci' }
  }
  if (envOn('QUIRKY_DIAGNOSTICS_DISABLED')) {
    return { localFileEnabled: false, disabledReason: 'quirky_diagnostics_disabled' }
  }
  return { localFileEnabled: true }
}

// Re-exported so existing importers of the trace path keep working; the
// resolution now lives in one place alongside the daemon log path.
export { getTraceFilePath } from './logs-directory'

// ── Module-level state ───────────────────────────────────────────────────

let sink: LocalFileSink | null = null

/** Create the local file sink, install it as the active tracer sink, and
 *  update module-level `sink`. */
function installLocalSink(filePath: string): void {
  try {
    const localSink = createLocalFileSink({ filePath })
    sink = localSink
    setActiveSink(localSink)
  } catch (error) {
    // Diagnostics are optional: a logs folder that cannot be opened must not stop the app or host.
    console.warn(`[observability] tracing is off: cannot open ${filePath}`, error)
  }
}

/** `traceFilePath` names another process's own file; the desktop's is the default. */
export function initObservability(options?: { traceFilePath?: string }): ObservabilityConsent {
  const c = resolveObservabilityConsent()
  if (!c.localFileEnabled) {
    // Disabled at the CI / QUIRKY_DIAGNOSTICS_DISABLED level — leave the
    // tracer's active sink unset, so all spans are no-ops.
    return c
  }
  installLocalSink(options?.traceFilePath ?? getTraceFilePath())
  installSecurePathHardeningReporter()
  return c
}

/**
 * Why route it here: Windows path hardening lives in `src/shared` and defaults to `console.warn`,
 * which reaches nothing in a packaged build — the main process is GUI-subsystem and owns no
 * console. A credential file left on inherited ACLs is exactly what a diagnostic bundle should
 * show, so it becomes a span in the trace sink.
 *
 * `recovered` ends successfully rather than failing: a host that climbs back out of the
 * rate-limited state has to be as visible as one that fell into it, or the degraded state is only
 * ever half-diagnosable.
 */
function installSecurePathHardeningReporter(): void {
  setSecurePathHardeningReporter((entry) => {
    const span = startSpan('secure-path.windows-acl', {
      attributes: { targetPath: entry.targetPath, stage: entry.stage, detail: entry.detail }
    })
    if (entry.stage === 'recovered') {
      span.end()
      console.info('[secure-path.windows-acl] path hardening recovered', entry)
      return
    }
    span.fail(entry.detail)
    console.warn('[secure-path.windows-acl] failed to restrict path', entry)
  })
}

/** Writes buffered lines now, for an exit that runs no shutdown. */
export function flushObservability(): void {
  try {
    sink?.flush()
  } catch {
    // Nothing is left to report to.
  }
}

export async function shutdownObservability(): Promise<void> {
  setSecurePathHardeningReporter(null)
  // Order matters: tracer first so no new pushes arrive while the local sink
  // is closing and flushing buffered lines.
  setActiveSink(null)
  if (sink) {
    sink.close()
    sink = null
  }
}
