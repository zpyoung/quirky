import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExternalJob } from '../ui-contracts'
import { readOpenClawJobs } from './jobs'

export const OPENCLAW_ACTION_TIMEOUT_MS = 30_000
export const OPENCLAW_OUTPUT_LIMIT_BYTES = 64 * 1024
export const OPENCLAW_LOOKUP_TIMEOUT_MS = 5_000

export type LocalOpenClawSnapshot = {
  home: string
  executable: string | null
  jobs: ExternalJob[]
  readError: string | null
  cliError: string | null
  generation: string
}

function userHome(): string {
  const configured = process.env.HOME?.trim() || process.env.USERPROFILE?.trim()
  if (configured) return resolve(configured)
  return resolve(homedir())
}

function findExecutable(): { path: string | null; identity: string | null; error: string | null } {
  const startedAt = performance.now()
  let located: string | null
  try {
    located = Bun.which('openclaw', { PATH: process.env.PATH ?? '' })
  } catch (error) {
    return { path: null, identity: null, error: `Could not check for the OpenClaw CLI: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (performance.now() - startedAt > OPENCLAW_LOOKUP_TIMEOUT_MS) {
    return { path: null, identity: null, error: 'OpenClaw CLI discovery timed out after 5 seconds' }
  }
  if (!located) return { path: null, identity: null, error: null }

  try {
    const path = realpathSync(located)
    const stat = statSync(path, { bigint: true })
    if (!stat.isFile()) return { path: null, identity: null, error: 'The OpenClaw CLI path is not a regular file' }
    const identity = [
      path,
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
      stat.mode
    ].map(String).join(':')
    return { path, identity, error: null }
  } catch (error) {
    return { path: null, identity: null, error: `Could not inspect the OpenClaw CLI: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function inspectLocalOpenClaw(): Promise<LocalOpenClawSnapshot> {
  const home = userHome()
  const jobsPath = join(home, '.openclaw', 'cron', 'jobs.json')
  const executable = findExecutable()
  let jobs: ExternalJob[] = []
  let fileIdentity = 'missing'
  let readError: string | null = null

  try {
    const file = await readOpenClawJobs(jobsPath)
    jobs = file.jobs
    fileIdentity = file.identity
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error)
    fileIdentity = `error:${readError}`
  }

  const generationInput = JSON.stringify({
    provider: 'openclaw',
    hostId: 'local',
    home,
    jobsPath,
    executable: executable.identity,
    executableError: executable.error,
    jobs: fileIdentity
  })
  const generation = createHash('sha256').update(generationInput).digest('hex')

  return {
    home,
    executable: executable.path,
    jobs,
    readError,
    cliError: executable.error,
    generation
  }
}
