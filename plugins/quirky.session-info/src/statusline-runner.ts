import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type StatuslineRunnerOptions = { watchdogMs?: number }

const DEFAULT_WATCHDOG_MS = 1_000

const RUNNER_SOURCE = String.raw`'use strict'

const { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs')
const crypto = require('node:crypto')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')

const RECURSION_ENV = 'QUIRKY_SESSION_INFO_STATUSLINE_RECURSION'
const THROTTLE_MS = 15_000
const POST_TIMEOUT_MS = 1_500
const LOCK_STALE_MS = 30_000

function readInput() {
  const chunks = []
  return (async function collect() {
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  })()
}

function readPayload(input) {
  try {
    const value = JSON.parse(input.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function currentPort() {
  try {
    const home = process.env.QUIRKY_HOME
    if (!home) return null
    const runtime = JSON.parse(readFileSync(path.join(home, 'runtime.json'), 'utf8'))
    return Number.isInteger(runtime.port) && runtime.port > 0 && runtime.port < 65_536 ? runtime.port : null
  } catch {
    return null
  }
}

function validHookEnvironment() {
  const hookUrl = process.env.QUIRKY_HOOK_URL
  const token = process.env.QUIRKY_HOOK_TOKEN
  const session = process.env.QUIRKY_SESSION_ID
  if (!hookUrl || !token || !session || process.env.CLAUDE_JOB_DIR !== undefined) return null
  try {
    const base = new URL(hookUrl)
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') return null
    if (base.username || base.password || base.pathname.replace(/\/+$/, '') !== '/hook') return null
    const port = currentPort()
    if (port === null) return null
    return {
      port,
      token,
      path: '/hook/session-info-claude?session=' + encodeURIComponent(session),
      session
    }
  } catch {
    return null
  }
}

function allowPost(session, stateDirectory) {
  try {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
    chmodSync(stateDirectory, 0o700)
  } catch {
    return false
  }

  const digest = crypto.createHash('sha256').update(session).digest('hex')
  const stamp = path.join(stateDirectory, digest + '.stamp')
  const lock = stamp + '.lock'
  let held = false

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 })
      held = true
      break
    } catch (error) {
      if (error.code !== 'EEXIST') return false
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {
        return false
      }
      return false
    }
  }
  if (!held) return false

  try {
    const now = Date.now()
    try {
      // Runner processes share this file's wall-clock mtime; process-local clocks cannot throttle across invocations.
      const previous = statSync(stamp).mtimeMs
      if (now - previous < THROTTLE_MS) return false
    } catch {
      // Missing or unreadable state means this session has no recent post.
    }

    const temporary = stamp + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
    try {
      writeFileSync(temporary, '', { mode: 0o600, flag: 'wx' })
      chmodSync(temporary, 0o600)
      renameSync(temporary, stamp)
      chmodSync(stamp, 0o600)
      return true
    } catch {
      rmSync(temporary, { force: true })
      return false
    }
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function post(input, hook) {
  const { promise, resolve } = Promise.withResolvers()
  let finished = false
  const done = () => {
    if (finished) return
    finished = true
    resolve()
  }
  try {
    const request = http.request({
      hostname: '127.0.0.1',
      port: hook.port,
      path: hook.path,
      method: 'POST',
      headers: {
        'x-quirky-hook-token': hook.token,
        'content-type': 'application/json',
        'content-length': input.length
      }
    }, (response) => {
      response.on('error', done)
      response.on('close', done)
      response.on('end', done)
      response.resume()
    })
    request.setTimeout(POST_TIMEOUT_MS, () => request.destroy())
    request.on('error', done)
    request.end(input)
  } catch {
    done()
  }
  return promise
}

function startPost(input, payload, config) {
  try {
    if (!payload) return Promise.resolve()
    const hook = validHookEnvironment()
    if (!hook) return Promise.resolve()
    if (!allowPost(hook.session, config.stateDirectory)) return Promise.resolve()
    return post(input, hook)
  } catch {
    return Promise.resolve()
  }
}

function killGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // The child process group has already exited.
    }
  }
}

function runCustom(command, input, watchdogMs) {
  const environment = { ...process.env, [RECURSION_ENV]: '1' }
  let child
  try {
    child = spawn('/bin/sh', ['-c', command], {
      env: environment,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
  } catch {
    return Promise.resolve({ success: false, stdout: Buffer.alloc(0) })
  }

  const output = []
  child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)))
  const result = Promise.withResolvers()
  let timedOut = false
  let killTimer
  const watchdog = setTimeout(() => {
    timedOut = true
    killGroup(child.pid, 'SIGTERM')
    killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 100)
  }, watchdogMs)
  child.once('error', () => {
    clearTimeout(watchdog)
    if (killTimer && !timedOut) clearTimeout(killTimer)
    result.resolve({ success: false, stdout: Buffer.alloc(0) })
  })
  child.once('close', (code, signal) => {
    clearTimeout(watchdog)
    if (killTimer && !timedOut) clearTimeout(killTimer)
    result.resolve({
      success: !timedOut && code === 0 && signal === null,
      stdout: Buffer.concat(output)
    })
  })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  return result.promise
}

function writeStdout(output) {
  const { promise, resolve } = Promise.withResolvers()
  process.stdout.write(output, resolve)
  return promise
}

async function main() {
  if (process.env[RECURSION_ENV] === '1') return
  let config
  try {
    config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  } catch {
    return
  }
  if (!config || (config.customCommand !== null && typeof config.customCommand !== 'string')) return
  const watchdogMs = Number.isSafeInteger(config.watchdogMs) && config.watchdogMs > 0 ? config.watchdogMs : 5_000
  let input
  try {
    input = await readInput()
  } catch {
    input = Buffer.alloc(0)
  }
  const payload = readPayload(input)
  const telemetry = startPost(input, payload, config)
  const custom = config.customCommand === null
    ? Promise.resolve(null)
    : runCustom(config.customCommand, input, watchdogMs)
  const [result] = await Promise.all([custom, telemetry])
  if (result && result.success && result.stdout.length > 0) await writeStdout(result.stdout)
}

process.exitCode = 0
main().catch(() => {
  process.exitCode = 0
})
`

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function writePrivateFile(path: string, contents: string, mode: number): void {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, contents, { mode, flag: 'wx' })
    chmodSync(temporary, mode)
    renameSync(temporary, path)
    chmodSync(path, mode)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function writeStatuslineRunner(
  dataDir: string,
  customCommand: string | null,
  options: StatuslineRunnerOptions = {}
): string {
  const runnerDirectory = join(resolve(dataDir), 'statusline-runner')
  mkdirSync(runnerDirectory, { recursive: true, mode: 0o700 })
  chmodSync(runnerDirectory, 0o700)

  const runnerPath = join(runnerDirectory, 'runner.cjs')
  const watchdogMs =
    typeof options.watchdogMs === 'number' && Number.isSafeInteger(options.watchdogMs) && options.watchdogMs > 0
      ? options.watchdogMs
      : DEFAULT_WATCHDOG_MS
  const configContents = JSON.stringify({
    customCommand,
    watchdogMs,
    stateDirectory: join(runnerDirectory, 'state')
  })
  const configHash = createHash('sha256').update(configContents).digest('hex')
  const configPath = join(runnerDirectory, `config-${configHash}.json`)

  writePrivateFile(runnerPath, RUNNER_SOURCE, 0o700)
  writePrivateFile(configPath, configContents, 0o600)

  return `${shellQuote(process.execPath)} ${shellQuote(runnerPath)} ${shellQuote(configPath)}`
}
