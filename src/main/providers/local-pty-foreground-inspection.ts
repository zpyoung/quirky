import type { PtyChildProcessVerdict } from '../../shared/terminal-process-inspection'
import { getCheapProcessTableSnapshot } from '../../shared/cheap-process-table-snapshot-reader'
import {
  getProcessTableSnapshot,
  getStrictProcessTableSnapshotWithAge
} from '../../shared/process-table-snapshot-reader'
import { confirmShellForegroundProcess } from './agent-foreground-process'
import {
  createPtyForegroundResolver,
  ptyProcessNameIsSpawnFile
} from '../daemon/pty-subprocess/spawn-file-foreground-process'
import { inspectSpawnFileChildProcessesFromRows } from '../daemon/pty-subprocess/spawn-file-child-processes'
import { buildPaneProcessFingerprint } from './posix-pane-foreground-fingerprint'
import { isRetiredPtyMaster } from '../pty/node-pty-master-fd-retirement'
import { resolveForegroundFallbackProcess } from './local-pty-launch-helpers'
import {
  ptyAgentForegroundContextPaths,
  ptyLastRecognizedForeground,
  ptyProcesses,
  getPtyShellName,
  ptyShellPath
} from './local-pty-provider-state'
import { resolveStableForegroundProcess } from './stable-foreground-process'

/**
 * A retired master does not fail loudly: the `process` getter answers with the spawn file, which
 * equals the recorded shell and would otherwise read as a real "nothing is running here". Ask the
 * descriptor before the name, because an unreadable PTY is not evidence that its children exited.
 */
export async function inspectLocalPtyChildProcesses(id: string): Promise<PtyChildProcessVerdict> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return 'no-children'
  }
  if (isRetiredPtyMaster(proc)) {
    return 'unverifiable'
  }
  try {
    if (ptyProcessNameIsSpawnFile(proc)) {
      const snapshot = await getStrictProcessTableSnapshotWithAge()
      return ptyProcesses.get(id) === proc
        ? inspectSpawnFileChildProcessesFromRows(
            snapshot.rows,
            proc.pid,
            getPtyShellName(id) ?? null
          )
        : 'unverifiable'
    }
    const foreground = proc.process
    const shell = getPtyShellName(id)
    if (!shell) {
      return 'children'
    }
    return foreground === shell ? 'no-children' : 'children'
  } catch {
    // An unreadable PTY is not evidence that its children exited.
    return 'unverifiable'
  }
}

export async function hasLocalPtyChildProcesses(id: string): Promise<boolean> {
  return (await inspectLocalPtyChildProcesses(id)) !== 'no-children'
}

/**
 * A pane that already holds a recognized agent re-proves it from the cheap `ps` tier when the
 * subtree fingerprint is unchanged. Panes with no anchor never get here, so start discovery is untouched.
 */
async function revalidateCachedPosixAgent(
  proc: { pid: number },
  cachedEntry: {
    name: string
    steady?: { fingerprint: string; fallbackProcess: string | null } | null
  },
  fallbackProcess: string | null
): Promise<boolean> {
  const steady = cachedEntry.steady
  if (!steady || steady.fallbackProcess !== fallbackProcess) {
    return false
  }
  try {
    const observed = await buildPaneProcessFingerprint(
      await getCheapProcessTableSnapshot(),
      proc.pid
    )
    return observed !== null && observed === steady.fingerprint
  } catch {
    return false
  }
}

export async function getLocalPtyForegroundProcess(id: string): Promise<string | null> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    ptyLastRecognizedForeground.delete(id)
    return null
  }
  const fallbackProcess = resolveForegroundFallbackProcess(
    ptyProcessNameIsSpawnFile(proc) ? (getPtyShellName(id) ?? null) : proc.process || null,
    getPtyShellName(id)
  )
  const cachedEntry = ptyLastRecognizedForeground.get(id)
  const cachedAgent = cachedEntry?.name ?? null
  if (
    cachedEntry &&
    cachedAgent !== null &&
    (await revalidateCachedPosixAgent(proc, cachedEntry, fallbackProcess))
  ) {
    if (ptyProcesses.get(id) !== proc) {
      return null
    }
    ptyLastRecognizedForeground.set(id, { ...cachedEntry, at: Date.now() })
    return cachedAgent
  }
  try {
    const resolution = await createPtyForegroundResolver(proc)(proc.pid, fallbackProcess, {
      contextPaths: ptyAgentForegroundContextPaths.get(id)
    })
    // Why: the scan can outlive PTY teardown/id reuse; stale results must not resurrect cache for a foreign id.
    if (ptyProcesses.get(id) !== proc) {
      return null
    }
    // Why: a degraded scan reporting shell-as-foreground fires a false "agent done"; keep last recognized agent instead.
    const lastRecognizedAgent = ptyLastRecognizedForeground.get(id)?.name ?? null
    const stable = resolveStableForegroundProcess(resolution, lastRecognizedAgent)
    if (stable.lastRecognizedAgent && resolution.available) {
      const steady = await readPosixSteadyState(proc.pid, fallbackProcess)
      if (ptyProcesses.get(id) !== proc) {
        return null
      }
      // Only a positive recognition restarts the age bound.
      ptyLastRecognizedForeground.set(id, {
        name: stable.lastRecognizedAgent,
        pid:
          stable.lastRecognizedAgent === resolution.processName
            ? (resolution.processId ?? null)
            : null,
        at: Date.now(),
        steady
      })
    } else if (!stable.lastRecognizedAgent) {
      ptyLastRecognizedForeground.delete(id)
    }
    return stable.processName
  } catch {
    if (ptyProcesses.get(id) !== proc) {
      return null
    }
    // Why: an inspection error is a degraded read; fall back to last recognized agent (null reads as an exit).
    return ptyLastRecognizedForeground.get(id)?.name ?? null
  }
}

/** The fingerprint of the TTL-shared capture the recognition just read; null when the pane is
 *  unfenced, which simply means the next read pays for the full scan. */
async function readPosixSteadyState(
  shellPid: number,
  fallbackProcess: string | null
): Promise<{ fingerprint: string; fallbackProcess: string | null } | null> {
  try {
    const fingerprint = await buildPaneProcessFingerprint(await getProcessTableSnapshot(), shellPid)
    return fingerprint === null ? null : { fingerprint, fallbackProcess }
  } catch {
    return null
  }
}

export async function confirmLocalPtyForegroundProcess(id: string): Promise<string | null> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return null
  }
  try {
    const resolution = await createPtyForegroundResolver(proc)(
      proc.pid,
      resolveForegroundFallbackProcess(
        ptyProcessNameIsSpawnFile(proc) ? (getPtyShellName(id) ?? null) : proc.process || null,
        getPtyShellName(id)
      ),
      {
        contextPaths: ptyAgentForegroundContextPaths.get(id),
        fresh: true
      }
    )
    // Why: a fresh scan can outlive this PTY id; never publish identity from an exited or same-id-reusing session.
    if (ptyProcesses.get(id) !== proc) {
      return null
    }
    return resolution.available ? resolution.processName : null
  } catch {
    return null
  }
}

export async function confirmLocalPtyShellForeground(id: string): Promise<boolean> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return false
  }
  const confirmed = await confirmShellForegroundProcess(proc.pid, ptyShellPath.get(id))
  return ptyProcesses.get(id) === proc && confirmed
}
