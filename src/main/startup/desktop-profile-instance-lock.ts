/**
 * The desktop app takes quirkyd's instance lock on its userData profile, so `quirky serve` on
 * quirkyd and the desktop refuse each other instead of both writing one profile.
 *
 * Electron's single-instance lock only fences other Electron launches; quirkyd is a plain Node
 * process that cannot see it. Sharing quirkyd's lock file gives both hosts one owner record.
 */
import {
  acquireQuirkydInstanceLock,
  type QuirkydInstanceLock
} from '../quirkyd/quirkyd-instance-lock'
import { QuirkydInstanceLockError } from '../quirkyd/quirkyd-data-root-privacy'
import { writeStartupDiagnosticLine, type StartupDiagnosticSink } from './startup-diagnostics'

export type DesktopProfileLockResult =
  | { state: 'acquired'; lock: QuirkydInstanceLock }
  | { state: 'held'; message: string }
  /** The lock could not be taken for another reason; the desktop starts as it did before it. */
  | { state: 'unavailable' }

export function acquireDesktopProfileInstanceLock(
  userDataPath: string,
  acquire: typeof acquireQuirkydInstanceLock = acquireQuirkydInstanceLock,
  write?: StartupDiagnosticSink
): DesktopProfileLockResult {
  try {
    const lock = acquire(userDataPath, { role: 'desktop' })
    // Best effort: a lock left by a dead pid is reclaimed on the next start anyway.
    process.once('exit', () => lock.release())
    return { state: 'acquired', lock }
  } catch (error) {
    if (error instanceof QuirkydInstanceLockError && error.code === 'quirkyd_instance_lock_held') {
      writeStartupDiagnosticLine(`[single-instance] ${error.message}`, write)
      return { state: 'held', message: error.message }
    }
    // Why not refuse: only a proven live holder may stop a desktop that never took this lock before.
    console.warn('[single-instance] Could not take the shared profile lock:', error)
    return { state: 'unavailable' }
  }
}
