/** Executable entry for `quirkyd`. See `./quirkyd-entry.ts`. */
import process from 'node:process'
import { main } from './quirkyd-entry'
import { resolveQuirkydExitCode } from './quirkyd-exit-code'
import { reserveServeStdoutForReadiness } from '../server/serve-stdout-boundary'
import { runQuirkydNativePreflight } from './quirkyd-native-preflight'
import {
  QUIRKYD_PROFILE_PREFLIGHT_FLAG,
  QUIRKYD_STARTUP_PREFLIGHT_FLAG
} from '../../shared/quirkyd-profile-preflight'
import {
  preflightBundledQuirkydStartup,
  runQuirkydProfilePreflight
} from './quirkyd-profile-preflight'
import { assertQuirkydServerRuntime } from './quirkyd-bundled-runtime'
import {
  formatQuirkydNativePreflightReport,
  QUIRKYD_NATIVE_PREFLIGHT_FLAG
} from '../../shared/quirkyd-native-preflight-report'
import {
  QUIRKYD_CANCEL_MANAGED_STOP_FLAG,
  QUIRKYD_COMPLETE_MANAGED_STOP_FLAG
} from '../../shared/quirkyd-stop-request'
import {
  QUIRKYD_WINDOWS_BREAKAWAY_CONTRACT,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG
} from '../../shared/windows-breakaway-launch'
import { runWindowsBreakawayLaunchIfRequested } from '../../shared/windows-breakaway-launcher'
import { parseArgs } from './quirkyd-command-arguments'

// Why exit before the preflight: reaching this line means the whole module graph resolved
// under plain Node, which is all the build guard needs to prove. Probing natives or
// starting a server to prove it would bind a port and take a data-root lock on a build
// machine.
if (process.argv.includes('--quirkyd-smoke-load-check')) {
  process.exit(0)
}

function failStartup(error: unknown): void {
  console.error('quirkyd: failed to start:', error)
  // Why a resolved code and not a bare 1: a data-root or bind-address refusal is a
  // configuration fault that restarting cannot fix, and a supervisor needs to tell the two
  // apart to avoid restart-spinning on it.
  process.exit(resolveQuirkydExitCode(error))
}

// One-shot launch and stop commands must skip server startup and preflights.
if (process.argv[2] === '--quirkyd-structured-provider-load-check') {
  void import('./quirkyd-structured-provider-smoke')
    .then(({ smokeLoadQuirkydStructuredProviders }) => smokeLoadQuirkydStructuredProviders())
    .then(() => process.exit(0))
    .catch(failStartup)
} else if (process.argv[2] === WINDOWS_BREAKAWAY_LAUNCH_FLAG) {
  runWindowsBreakawayLaunchIfRequested(QUIRKYD_WINDOWS_BREAKAWAY_CONTRACT, process.argv)
} else if (
  process.argv[2] === QUIRKYD_COMPLETE_MANAGED_STOP_FLAG ||
  process.argv[2] === QUIRKYD_CANCEL_MANAGED_STOP_FLAG
) {
  void import('./quirkyd-managed-stop-command').then(({ runQuirkydManagedStopCommandAndExit }) =>
    runQuirkydManagedStopCommandAndExit(process.argv.slice(2))
  )
} else {
  startQuirkydProcess()
}

function startQuirkydProcess(): void {
  try {
    const argv = process.argv.slice(2)
    if ((argv.includes('--help') || argv.includes('-h')) && parseArgs(argv).help) {
      void main(argv).catch(failStartup)
      return
    }
    assertQuirkydServerRuntime()
    const flag = process.argv[2]
    if (flag === QUIRKYD_NATIVE_PREFLIGHT_FLAG && process.argv.length === 3) {
      void import('./node-pty-precondition').then(({ checkNodePtyPrecondition }) => {
        const verdict = checkNodePtyPrecondition()
        const report = formatQuirkydNativePreflightReport(verdict.status, verdict.reason ?? null)
        process.stdout.write(`${report}\n`, () => process.exit(0))
      }, failStartup)
    } else if (
      (flag === QUIRKYD_PROFILE_PREFLIGHT_FLAG || flag === QUIRKYD_STARTUP_PREFLIGHT_FLAG) &&
      process.argv.length === 4
    ) {
      void runQuirkydProfilePreflight(process.argv[3], {
        nativeFeatures: flag === QUIRKYD_PROFILE_PREFLIGHT_FLAG
      })
        // Why exit: the owner reads to EOF, so a lingering native handle must not hold the probe open.
        .then(() => process.stdout.write('', () => process.exit(0)))
        .catch(failStartup)
    } else {
      // Why: stdout is the serve readiness API; incidental diagnostics go to stderr.
      reserveServeStdoutForReadiness()
      void preflightBundledQuirkydStartup()
        .then(() => {
          // Why: must run before anything requires node-pty; the bundle defers require("node-pty")
          // so no import does. See ./node-pty-precondition.ts.
          runQuirkydNativePreflight()
          return main()
        })
        .catch(failStartup)
    }
  } catch (error) {
    failStartup(error)
  }
}
