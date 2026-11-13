import type { ProcessSpawner, SpawnedProcess } from '@quirky/protocol'
import type { ExternalAction } from '../ui-contracts'
import { OPENCLAW_ACTION_TIMEOUT_MS, OPENCLAW_OUTPUT_LIMIT_BYTES } from './local'

export const OPENCLAW_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/

type CronCommand = 'disable' | 'enable' | 'run' | 'rm'

export class OpenClawCommandError extends Error {}

function actionCommand(action: ExternalAction): CronCommand {
  if (action === 'pause') return 'disable'
  if (action === 'resume') return 'enable'
  if (action === 'run') return 'run'
  if (action === 'delete') return 'rm'
  throw new OpenClawCommandError('Unsupported OpenClaw action')
}

function outputText(parts: Uint8Array[]): string {
  return Buffer.concat(parts).toString('utf8').trim()
}

export function runOpenClawCommand(spawner: ProcessSpawner, executable: string, home: string, jobId: string, action: ExternalAction): Promise<void> {
  if (!OPENCLAW_JOB_ID_RE.test(jobId)) return Promise.reject(new OpenClawCommandError('OpenClaw job ID must use only letters, numbers, dot, underscore, colon, or hyphen'))
  const command = actionCommand(action)
  let child: SpawnedProcess
  try {
    child = spawner.spawn([executable, 'cron', command, jobId], {
      cwd: home,
      env: process.env,
      timeoutMs: OPENCLAW_ACTION_TIMEOUT_MS,
      killGraceMs: 0,
      stderr: 'pipe'
    })
  } catch (error) {
    return Promise.reject(new OpenClawCommandError(`Could not start OpenClaw: ${error instanceof Error ? error.message : String(error)}`))
  }

  const stdout: Uint8Array[] = []
  const stderr: Uint8Array[] = []
  const stdoutReader = child.stdout.getReader()
  const stderrReader = child.stderr.getReader()
  let outputBytes = 0
  let outputLimitExceeded = false
  let timedOut = false
  let streamError: unknown
  const stop = () => {
    void stdoutReader.cancel().catch(() => {})
    void stderrReader.cancel().catch(() => {})
    void child.stop({ signal: 'SIGKILL' })
  }
  const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>, target: Uint8Array[]) => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        outputBytes += value.byteLength
        if (outputBytes > OPENCLAW_OUTPUT_LIMIT_BYTES) {
          outputLimitExceeded = true
          stop()
          return
        }
        target.push(value)
      }
    } catch (error) {
      if (!outputLimitExceeded && !timedOut) {
        streamError ??= error
        stop()
      }
    } finally {
      reader.releaseLock()
    }
  }
  const timeout = setTimeout(() => {
    timedOut = true
    stop()
  }, OPENCLAW_ACTION_TIMEOUT_MS)
  const exited = child.exited.then(exit => {
    if (exit.stopped) {
      if (exit.stopped === 'timeout') timedOut = true
      stop()
    }
    return exit
  })

  return Promise.all([exited, drain(stdoutReader, stdout), drain(stderrReader, stderr)]).then(([exit]) => {
    if (outputLimitExceeded) {
      throw new OpenClawCommandError(`OpenClaw output exceeded the ${OPENCLAW_OUTPUT_LIMIT_BYTES}-byte limit`)
    }
    if (timedOut || exit.stopped === 'timeout') {
      throw new OpenClawCommandError(`OpenClaw command timed out after ${OPENCLAW_ACTION_TIMEOUT_MS / 1000} seconds`)
    }
    if (exit.spawnError) {
      throw new OpenClawCommandError(`Could not start OpenClaw: ${exit.spawnError.message}`)
    }
    if (exit.exitCode !== 0) {
      const detail = outputText(stderr) || outputText(stdout)
      const reason = exit.exitCode === null ? `terminated by ${exit.signal ?? 'an unknown signal'}` : `exited with status ${exit.exitCode}`
      throw new OpenClawCommandError(`OpenClaw cron ${command} ${jobId} ${reason}${detail ? `: ${detail}` : ''}`)
    }
    if (exit.stopped === 'aborted' || exit.stopped === 'stop') {
      throw new OpenClawCommandError(`OpenClaw cron ${command} ${jobId} was aborted`)
    }
    if (streamError !== undefined) {
      throw new OpenClawCommandError(`OpenClaw cron ${command} ${jobId} output stream failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`)
    }
    if (exit.groupSurvived) {
      throw new OpenClawCommandError(`OpenClaw cron ${command} ${jobId} process group could not be stopped`)
    }
  }).finally(() => clearTimeout(timeout))
}
