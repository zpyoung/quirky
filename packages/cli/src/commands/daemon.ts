import {
  ensureDaemon,
  isDaemonAlive,
  quirkyHome,
  readRuntime,
  signalDaemon,
  waitForDaemonExit
} from '@quirky/protocol/node'
import { flagBoolean, takePositionals } from '../args'
import { ConnectionLostError, DaemonUnavailableError } from '../link'
import type { Command, Context } from './types'

const DEFAULT_REQUEST_MS = 5_000
const DEFAULT_STOP_MS = 10_000
const DEFAULT_KILL_MS = 2_000

type Stopped = 'clean' | 'terminated' | 'killed' | 'not-running'
type RequestOutcome = 'answered' | 'unanswered' | 'lost'

function validateDaemonPid(pid: unknown): asserts pid is number {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('invalid daemon pid')
  }
  if (pid === process.pid) throw new Error(`refusing to signal this process (pid ${pid})`)
}

async function requestStop(ctx: Context, requestMs: number): Promise<RequestOutcome> {
  const deadline = Symbol('daemon.stop request deadline')
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(deadline), requestMs)
  try {
    await Promise.race([
      ctx.rpc.call('daemon.stop', {}, { timeoutMs: requestMs }),
      timeout.promise
    ])
    return 'answered'
  } catch (error) {
    if (
      error === deadline ||
      error instanceof DaemonUnavailableError ||
      (error instanceof Error && error.message === `RPC call timed out after ${requestMs} ms`)
    ) {
      return 'unanswered'
    }
    if (error instanceof ConnectionLostError) return 'lost'
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function seconds(milliseconds: number): string {
  return `${milliseconds / 1000}s`
}

export function createDaemonRestart(
  timings: { requestMs?: number; stopMs?: number; killMs?: number } = {}
): Command {
  const requestMs = timings.requestMs ?? DEFAULT_REQUEST_MS
  const stopMs = timings.stopMs ?? DEFAULT_STOP_MS
  const killMs = timings.killMs ?? DEFAULT_KILL_MS

  return {
    name: 'daemon restart',
    summary: 'stop quirkyd and start a new one; --disable-plugins starts it in safe mode for this run',
    positionals: [],
    flags: {
      'disable-plugins': {
        type: 'boolean',
        description: 'safe mode: installed plugins, stored disables and the distro layer are off for this run'
      }
    },
    methods: ['daemon.stop'],
    plugin: null,
    async run(args, ctx) {
      takePositionals(args, [])
      const safeMode = flagBoolean(args, 'disable-plugins')
      const home = ctx.env.QUIRKY_HOME ?? quirkyHome()
      let linkClosed = false
      const closeLink = () => {
        if (linkClosed) return
        linkClosed = true
        ctx.rpc.close()
      }

      try {
        const running = readRuntime(home)
        let stopped: Stopped
        let suffix: string

        if (running === null) {
          stopped = 'not-running'
          suffix = '; the old daemon was not running'
          closeLink()
        } else {
          const pid = running.pid
          validateDaemonPid(pid)
          if (!(await isDaemonAlive(running))) {
            stopped = 'not-running'
            suffix = '; the old daemon was not running'
            closeLink()
          } else {
            const outcome = await requestStop(ctx, requestMs)
            closeLink()

            if (outcome === 'answered' || outcome === 'lost') {
              const exit = await waitForDaemonExit(pid, { timeoutMs: stopMs, killWaitMs: killMs })
              if (exit === 'killed') {
                stopped = 'killed'
                suffix = `; the old daemon (pid ${pid}) did not stop within ${seconds(stopMs)} and was killed`
              } else {
                stopped = 'clean'
                suffix = ''
              }
            } else {
              const sent = signalDaemon(pid, 'SIGTERM')
              const exit = await waitForDaemonExit(pid, { timeoutMs: stopMs, killWaitMs: killMs })
              if (exit === 'killed') {
                stopped = 'killed'
                suffix = `; the old daemon (pid ${pid}) did not stop within ${seconds(stopMs)} and was killed`
              } else if (sent) {
                stopped = 'terminated'
                suffix = `; the old daemon (pid ${pid}) did not answer daemon.stop within ${seconds(requestMs)} and was sent SIGTERM`
              } else {
                stopped = 'clean'
                suffix = ''
              }
            }
          }
        }

        const info = await ensureDaemon({
          home,
          args: safeMode ? ['--disable-plugins'] : [],
          stopTimeoutMs: stopMs,
          killWaitMs: killMs
        })
        ctx.out.result({ pid: info.pid, port: info.port, safeMode, stopped }, () =>
          `restarted quirkyd${safeMode ? ' in safe mode' : ''} (pid ${info.pid})${suffix}`
        )
      } catch (error) {
        closeLink()
        throw error
      }
    }
  }
}

export const daemonRestart = createDaemonRestart()
