import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { ExternalAction } from '../ui-contracts'
import type { Readable } from 'node:stream'
import { OPENCLAW_ACTION_TIMEOUT_MS, OPENCLAW_OUTPUT_LIMIT_BYTES } from './local'

export const OPENCLAW_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/

type OpenClawChild = ChildProcessByStdio<null, Readable, Readable>
type CronCommand = 'disable' | 'enable' | 'run' | 'rm'

export class OpenClawCommandError extends Error {}

function actionCommand(action: ExternalAction): CronCommand {
  if (action === 'pause') return 'disable'
  if (action === 'resume') return 'enable'
  if (action === 'run') return 'run'
  if (action === 'delete') return 'rm'
  throw new OpenClawCommandError('Unsupported OpenClaw action')
}

function outputText(parts: Buffer[]): string {
  return Buffer.concat(parts).toString('utf8').trim()
}

function killProcessTree(child: OpenClawChild): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // Fall back if the process group already exited.
    }
  }
  child.kill('SIGKILL')
}

export function runOpenClawCommand(executable: string, home: string, jobId: string, action: ExternalAction): Promise<void> {
  if (!OPENCLAW_JOB_ID_RE.test(jobId)) return Promise.reject(new OpenClawCommandError('OpenClaw job ID must use only letters, numbers, dot, underscore, colon, or hyphen'))
  const command = actionCommand(action)
  const argv = ['cron', command, jobId]
  let child: OpenClawChild
  try {
    child = spawn(executable, argv, {
      cwd: home,
      env: process.env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    return Promise.reject(new OpenClawCommandError(`Could not start OpenClaw: ${error instanceof Error ? error.message : String(error)}`))
  }

  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outputBytes = 0
  let outputLimitExceeded = false
  let timedOut = false
  let spawnError: Error | null = null

  const collect = (target: Buffer[], chunk: Buffer): void => {
    if (outputLimitExceeded) return
    const remaining = OPENCLAW_OUTPUT_LIMIT_BYTES - outputBytes
    const accepted = Math.min(chunk.length, Math.max(0, remaining))
    if (accepted > 0) target.push(chunk.subarray(0, accepted))
    outputBytes += chunk.length
    if (chunk.length > accepted) {
      outputLimitExceeded = true
      killProcessTree(child)
    }
  }

  child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
  child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
  child.once('error', (error) => { spawnError = error })

  const timeout = setTimeout(() => {
    timedOut = true
    killProcessTree(child)
  }, OPENCLAW_ACTION_TIMEOUT_MS)

  child.once('close', (code, signal) => {
    clearTimeout(timeout)
    if (outputLimitExceeded) {
      reject(new OpenClawCommandError(`OpenClaw output exceeded the ${OPENCLAW_OUTPUT_LIMIT_BYTES}-byte limit`))
      return
    }
    if (timedOut) {
      reject(new OpenClawCommandError(`OpenClaw command timed out after ${OPENCLAW_ACTION_TIMEOUT_MS / 1000} seconds`))
      return
    }
    if (spawnError) {
      reject(new OpenClawCommandError(`Could not start OpenClaw: ${spawnError.message}`))
      return
    }
    if (code !== 0) {
      const detail = outputText(stderr) || outputText(stdout)
      const reason = code === null ? `terminated by ${signal ?? 'an unknown signal'}` : `exited with status ${code}`
      reject(new OpenClawCommandError(`OpenClaw cron ${command} ${jobId} ${reason}${detail ? `: ${detail}` : ''}`))
      return
    }
    resolve()
  })
  return promise
}
