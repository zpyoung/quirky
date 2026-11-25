import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'
import type {
  ConnectionLogEntry,
  ConnectionState,
  MobileConnectionDiagnosticPath
} from '../transport/types'

export type ConnectionDiagnosis = {
  likelyCause: string
  nextStep: string
}

type DiagnoseConnectionArgs = {
  endpoint: string
  state: ConnectionState
  activePath?: MobileConnectionDiagnosticPath
  entries: readonly ConnectionLogEntry[]
}

export function diagnoseConnection(args: DiagnoseConnectionArgs): ConnectionDiagnosis {
  if (args.state === 'connected') {
    return {
      likelyCause: `Connection is healthy${args.activePath ? ` via ${formatPath(args.activePath)}` : ''}.`,
      nextStep: 'No action needed.'
    }
  }
  const selected = selectDiagnosticFailure(args.entries)
  const failure = selected?.entry
  const evidence = failure ? diagnosticEvidence(failure) : ''
  const diagnosis = diagnoseFailure(args, failure, evidence)
  if (!selected?.staleSince) {
    return diagnosis
  }
  // Evidence from before the last resume or network change is still the best
  // account of a host that has not answered since; it is just not a current,
  // sendable incident.
  const boundary =
    selected.staleSince === 'network-changed' ? 'the last network change' : 'the app last resumed'
  return {
    likelyCause: `Before ${boundary}: ${diagnosis.likelyCause}`,
    nextStep: diagnosis.nextStep
  }
}

function diagnoseFailure(
  args: DiagnoseConnectionArgs,
  failure: ConnectionLogEntry | undefined,
  evidence: string
): ConnectionDiagnosis {
  if (/liveness-timeout|liveness timeout|connection health check failed/i.test(evidence)) {
    return {
      likelyCause: 'The connected host stopped answering authenticated health checks.',
      nextStep: 'Quirky closed the stale session and started recovery.'
    }
  }

  if (/authentication-rejected|unauthorized|pairing may be revoked/i.test(evidence)) {
    return {
      likelyCause: 'The desktop rejected this device during authentication.',
      nextStep: 'Confirm the device is still paired; pair it again if the rejection repeats.'
    }
  }

  if (/connect-timeout|websocket connect timeout/i.test(evidence)) {
    return {
      likelyCause: isTailscaleEndpoint(args.endpoint)
        ? 'The saved Tailscale endpoint did not answer before the connection timeout.'
        : 'The saved direct endpoint did not answer before the connection timeout.',
      nextStep: 'Check the local/VPN network and confirm the desktop is awake.'
    }
  }

  if (/handshake-timeout|handshake timeout/i.test(evidence)) {
    return {
      likelyCause: 'The endpoint opened, but the encrypted Quirky handshake did not finish.',
      nextStep: 'Confirm the desktop is running a compatible Quirky version and retry.'
    }
  }

  return {
    likelyCause: 'No single failure cause can be determined from the recorded events.',
    nextStep: 'Run diagnostics and copy the report again after the next connection attempt.'
  }
}

// Newest failure since the last resume/network change; failing that, the newest
// since the last connection or session start, flagged stale. The window used to
// stop at every resume, and iOS resumes the app often enough that a host that
// never answers left the window empty and the report cause-less.
function selectDiagnosticFailure(
  entries: readonly ConnectionLogEntry[]
): { entry: ConnectionLogEntry; staleSince: ResumeBoundary | null } | undefined {
  const sessionStart = entries.findLastIndex(isSessionBoundary) + 1
  const sinceSession = entries.slice(sessionStart)
  const boundaryIndex = sinceSession.findLastIndex(isResumeBoundary)
  const current = newestFailure(sinceSession.slice(boundaryIndex + 1))
  if (current) {
    return { entry: current, staleSince: null }
  }
  const stale = newestFailure(sinceSession.slice(0, boundaryIndex + 1))
  const boundary = sinceSession[boundaryIndex]?.code
  return stale && isResumeBoundaryCode(boundary)
    ? { entry: stale, staleSince: boundary }
    : undefined
}

function newestFailure(entries: readonly ConnectionLogEntry[]): ConnectionLogEntry | undefined {
  return entries.toReversed().find(isDiagnosticFailure)
}

function isSessionBoundary(entry: ConnectionLogEntry): boolean {
  return (
    entry.code === 'client-session-started' ||
    entry.code === 'direct-connected' ||
    entry.message === 'Authenticated'
  )
}

type ResumeBoundary = 'app-resumed' | 'network-changed'

function isResumeBoundaryCode(code: ConnectionLogEntry['code']): code is ResumeBoundary {
  return code === 'app-resumed' || code === 'network-changed'
}

function isResumeBoundary(entry: ConnectionLogEntry): boolean {
  return isResumeBoundaryCode(entry.code)
}

function diagnosticEvidence(entry: ConnectionLogEntry): string {
  return `${entry.code ?? ''} ${entry.message} ${entry.detail ?? ''}`
}

function isDiagnosticFailure(entry: ConnectionLogEntry): boolean {
  return /liveness-timeout|liveness timeout|connection health check failed|authentication-rejected|unauthorized|pairing may be revoked|connect-timeout|websocket connect timeout|handshake-timeout|handshake timeout/i.test(
    diagnosticEvidence(entry)
  )
}

function formatPath(path: MobileConnectionDiagnosticPath): string {
  return path === 'tailscale' ? 'Tailscale/direct' : 'LAN/direct'
}
