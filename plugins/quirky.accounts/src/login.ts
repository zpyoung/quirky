import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountSummary, ManagedProvider, PendingLogin } from './types'
import { AccountProfiles, isProviderAuth, redactProviderError, type ProviderIdentity } from './profiles'

export type LoginRequest = {
  provider: ManagedProvider
  accountId: string
  home: string
  label: string | null
  copyLink: boolean
  reauthenticating: boolean
  mutationGeneration: number
}

export type LoginCompletion = {
  request: LoginRequest
  status: 'complete' | 'error' | 'cancelled'
  identity: ProviderIdentity | null
  error: string | null
  superseded: boolean
}

export type LoginFinished = (completion: LoginCompletion) => Promise<AccountSummary | null>
export type LoginChanged = (pending: PendingLogin) => void

export type LoginTask = {
  pending: PendingLogin
  request: LoginRequest
  baselineAuthHash: string | null
  browserScript: string | null
  browserUrlFile: string | null
  child: ChildProcess | null
  stdout: string
  finalizing: boolean
  done: boolean
  cancelled: boolean
  mustCommit: boolean
  superseded: boolean
  finished: Promise<void>
  finish: () => void
  pollTimer: ReturnType<typeof setInterval> | null
  linkTimeout: ReturnType<typeof setTimeout> | null
  killTimer: ReturnType<typeof setTimeout> | null
}

const MAX_LOGIN_TASKS = 32
const MAX_OUTPUT_CHARS = 8192
const LOGIN_TIMEOUT_MS: Record<ManagedProvider, number> = { claude: 600_000, codex: 180_000 }
const COPY_LINK_WINDOW_MS = 60_000

export class AccountLoginManager {
  private readonly tasks = new Map<string, LoginTask>()

  constructor(
    private readonly profiles: AccountProfiles,
    private readonly onFinished: LoginFinished,
    private readonly onChanged: LoginChanged
  ) {}

  begin(request: LoginRequest): PendingLogin {
    const id = randomUUID()
    const { promise, resolve } = Promise.withResolvers<void>()
    const pending: PendingLogin = {
      id,
      provider: request.provider,
      accountId: request.accountId,
      status: 'pending',
      url: null,
      error: null,
      result: null
    }
    const task: LoginTask = {
      pending,
      request,
      baselineAuthHash: request.provider === 'codex' ? codexAuthHash(request.home) : null,
      browserScript: null,
      browserUrlFile: null,
      child: null,
      stdout: '',
      finalizing: false,
      done: false,
      cancelled: false,
      mustCommit: false,
      superseded: false,
      finished: promise,
      finish: resolve,
      pollTimer: null,
      linkTimeout: null,
      killTimer: null
    }
    this.tasks.set(id, task)
    this.trimCompleted()
    try {
      this.spawnTask(task)
    } catch {
      void this.finishTask(task, null, true)
    }
    return copyPending(task.pending)
  }

  status(id: string): PendingLogin | null {
    const task = this.tasks.get(id)
    return task ? copyPending(task.pending) : null
  }

  async cancel(id: string): Promise<PendingLogin | null> {
    const task = this.tasks.get(id)
    if (!task) return null
    if (task.pending.status !== 'pending' || task.done) return copyPending(task.pending)
    if (task.finalizing) {
      await task.finished
      return copyPending(task.pending)
    }
    if (task.request.provider === 'codex' && this.codexAuthChanged(task)) {
      task.mustCommit = true
      this.killProcess(task)
      await task.finished
      return copyPending(task.pending)
    }
    task.cancelled = true
    this.killProcess(task)
    if (!task.child) void this.finishTask(task, null, false)
    await task.finished
    return copyPending(task.pending)
  }

  async supersedePending(waitForFinalizing = true): Promise<void> {
    const pending = [...this.tasks.values()].filter((task) => task.pending.status === 'pending')
    const waitFor: LoginTask[] = []
    for (const task of pending) {
      task.superseded = true
      if (task.finalizing || task.done) {
        if (waitForFinalizing) waitFor.push(task)
        continue
      }
      if (task.request.provider === 'codex' && this.codexAuthChanged(task)) task.mustCommit = true
      else task.cancelled = true
      this.killProcess(task)
      if (!task.child) void this.finishTask(task, null, false)
      waitFor.push(task)
    }
    await Promise.all(waitFor.map((task) => task.finished))
  }

  async cancelPending(): Promise<void> {
    const pending = [...this.tasks.values()].filter((task) => task.pending.status === 'pending')
    for (const task of pending) await this.cancel(task.pending.id)
    await Promise.all(pending.map((task) => task.finished))
  }

  async shutdown(): Promise<void> {
    await this.cancelPending()
  }

  private spawnTask(task: LoginTask): void {
    const { request } = task
    const args = request.provider === 'claude' ? ['auth', 'login', '--claudeai'] : ['login']
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (request.provider === 'claude') env.CLAUDE_CONFIG_DIR = request.home
    else env.CODEX_HOME = request.home
    if (request.provider === 'claude' && request.copyLink) {
      const capture = createBrowserCapture(request.home)
      task.browserScript = capture.script
      task.browserUrlFile = capture.urlFile
      env.BROWSER = capture.script
      this.watchClaudeLink(task)
    }
    const child = spawn(request.provider, args, {
      cwd: request.home,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    task.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.onOutput(task, chunk.toString('utf8')))
    child.once('error', () => void this.finishTask(task, null, true))
    child.once('close', (code) => void this.finishTask(task, code, false))
    if (request.provider === 'claude' && request.copyLink) {
      task.linkTimeout = setTimeout(() => {
        if (task.pollTimer) clearInterval(task.pollTimer)
        task.pollTimer = null
        task.linkTimeout = null
      }, COPY_LINK_WINDOW_MS)
    }
    const timeout = setTimeout(() => {
      if (task.done || task.finalizing) return
      this.killProcess(task)
    }, LOGIN_TIMEOUT_MS[request.provider])
    timeout.unref()
    child.once('close', () => clearTimeout(timeout))
  }

  private onOutput(task: LoginTask, chunk: string): void {
    if (task.done || task.finalizing) return
    task.stdout = `${task.stdout}${chunk}`.slice(-MAX_OUTPUT_CHARS)
    if (task.request.provider === 'codex') {
      const url = trustedCodexUrl(task.stdout)
      if (url && task.pending.url !== url) this.publishUrl(task, url)
    }
  }

  private watchClaudeLink(task: LoginTask): void {
    const path = task.browserUrlFile
    if (path === null) return
    const check = (): void => {
      try {
        const stat = lstatSync(path)
        if (stat.isSymbolicLink() || !stat.isFile()) return
        const url = trustedClaudeUrl(readFileSync(path, 'utf8').trim())
        if (url) {
          this.publishUrl(task, url)
          if (task.pollTimer) clearInterval(task.pollTimer)
          task.pollTimer = null
          if (task.linkTimeout) clearTimeout(task.linkTimeout)
          task.linkTimeout = null
        }
      } catch {
        // The provider may not have emitted a callback URL yet.
      }
    }
    check()
    if (task.pending.url === null) task.pollTimer = setInterval(check, 200)
  }

  private publishUrl(task: LoginTask, url: string): void {
    if (task.done || task.finalizing || task.pending.status !== 'pending') return
    task.pending = { ...task.pending, url }
    this.onChanged(copyPending(task.pending))
  }

  private async finishTask(task: LoginTask, exitCode: number | null, spawnFailed: boolean): Promise<void> {
    if (task.done || task.finalizing) return
    task.finalizing = true
    this.clearTaskTimers(task)
    const codexAuthChanged = task.request.provider === 'codex' && this.codexAuthChanged(task)
    const shouldCommit = codexAuthChanged || (!task.cancelled && (exitCode === 0 || task.mustCommit))
    let status: LoginCompletion['status'] = task.cancelled && !codexAuthChanged ? 'cancelled' : 'error'
    let identity: ProviderIdentity | null = null
    let error = status === 'cancelled' ? null : redactProviderError(task.request.provider)
    if (shouldCommit) {
      try {
        this.profiles.protectAuthFile(task.request.provider, task.request.home)
        identity = this.profiles.readIdentity(task.request.provider, task.request.home)
        if (isProviderAuth(identity)) {
          status = 'complete'
          error = null
        } else {
          status = 'error'
          error = redactProviderError(task.request.provider)
          identity = null
        }
      } catch {
        status = 'error'
        error = redactProviderError(task.request.provider)
        identity = null
      }
    } else if (spawnFailed) {
      error = redactProviderError(task.request.provider)
    }
    try {
      const result = await this.onFinished({ request: task.request, status, identity, error, superseded: task.superseded })
      task.pending = {
        ...task.pending,
        status,
        error,
        result: status === 'complete' ? result : null,
        url: task.pending.url
      }
    } catch (finishError) {
      const safeError = finishError instanceof Error && /already added/i.test(finishError.message)
        ? finishError.message
        : redactProviderError(task.request.provider)
      task.pending = {
        ...task.pending,
        status: 'error',
        error: safeError,
        result: null
      }
    } finally {
      task.done = true
      task.finalizing = false
      try {
        this.removeBrowserCapture(task)
        this.onChanged(copyPending(task.pending))
      } finally {
        task.finish()
      }
    }
  }

  private codexAuthChanged(task: LoginTask): boolean {
    const current = codexAuthHash(task.request.home)
    return current !== null && current !== task.baselineAuthHash
  }

  private killProcess(task: LoginTask): void {
    const child = task.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.stdin?.end()
    const pid = child.pid
    if (pid !== undefined && process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      task.killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }
      }, 2000)
      task.killTimer.unref()
      return
    }
    child.kill('SIGTERM')
    task.killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
    task.killTimer.unref()
  }

  private clearTaskTimers(task: LoginTask): void {
    if (task.pollTimer) clearInterval(task.pollTimer)
    if (task.linkTimeout) clearTimeout(task.linkTimeout)
    if (task.killTimer) clearTimeout(task.killTimer)
    task.pollTimer = null
    task.linkTimeout = null
    task.killTimer = null
  }

  private removeBrowserCapture(task: LoginTask): void {
    for (const path of [task.browserScript, task.browserUrlFile]) {
      if (path !== null) rmSync(path, { force: true })
    }
  }

  private trimCompleted(): void {
    if (this.tasks.size <= MAX_LOGIN_TASKS) return
    for (const [id, task] of this.tasks) {
      if (task.done) this.tasks.delete(id)
      if (this.tasks.size <= MAX_LOGIN_TASKS) return
    }
  }
}

function createBrowserCapture(home: string): { script: string; urlFile: string } {
  const nonce = randomUUID()
  const script = join(home, `.quirky-login-browser-${nonce}`)
  const urlFile = join(home, `.quirky-login-url-${nonce}`)
  const contents = [
    '#!/bin/sh',
    `file=${shellQuote(urlFile)}`,
    'tmp="${file}.$$"',
    'printf \'%s\' "$1" > "$tmp"',
    'chmod 600 "$tmp"',
    'mv "$tmp" "$file"'
  ].join('\n') + '\n'
  writeFileSync(script, contents, { flag: 'wx', mode: 0o700 })
  chmodSync(script, 0o700)
  return { script, urlFile }
}

function trustedClaudeUrl(text: string): string | null {
  try {
    if (!text || text.length > 8192 || /[\u0000-\u001f\u007f]/.test(text)) return null
    const url = new URL(text)
    if (url.protocol !== 'https:' || !['claude.ai', 'claude.com'].includes(url.hostname) || url.pathname !== '/oauth/authorize') return null
    const redirectText = url.searchParams.get('redirect_uri')
    if (!redirectText) return null
    const redirect = new URL(redirectText)
    if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}

function trustedCodexUrl(output: string): string | null {
  const marker = 'navigate to this url to authenticate:'
  const start = output.toLocaleLowerCase('en-US').indexOf(marker)
  if (start < 0) return null
  const searchable = output.slice(start + marker.length)
  const match = /(https:\/\/\S+?)[.,;:)\]]*(?:\s|$)/.exec(searchable)
  if (!match?.[1]) return null
  try {
    const url = new URL(match[1])
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.pathname !== '/oauth/authorize') return null
    return url.toString()
  } catch {
    return null
  }
}

function codexAuthHash(home: string): string | null {
  const path = join(home, 'auth.json')
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) return null
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function copyPending(pending: PendingLogin): PendingLogin {
  return { ...pending, result: pending.result ? { ...pending.result } : null }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
