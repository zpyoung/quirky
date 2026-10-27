import { randomUUID } from 'node:crypto'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { validateValue, type Schema } from '@quirky/protocol'
import { fault } from './errors'
import type { BrowserChild, BrowserDependencies } from './dependencies'
import { stopOwned } from './process'

const MAX_FRAME_BYTES = 50 * 1024 * 1024
const RESPONSE_SCHEMA: Schema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    success: { type: 'boolean' },
    data: {},
    error: { type: 'string' },
    warning: { type: 'string' }
  },
  required: ['id', 'success'],
  additionalProperties: false
}

export type NativeResponse = { id: string; success: boolean; data?: unknown; error?: string; warning?: string }
export type NativeHelper = {
  child: BrowserChild
  session: string
  socketDir: string
  socketAliasRoot: string
  socketPath: string
  asyncClose(): Promise<void>
}
export class NativeTransportError extends Error {
  readonly reason: 'browser_tab_changed' | 'browser_timeout'

  constructor(reason: 'browser_tab_changed' | 'browser_timeout', message: string) {
    super(message)
    this.name = 'NativeTransportError'
    this.reason = reason
  }
}

function environment(overrides: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string' || key.startsWith('AGENT_BROWSER_') || key.startsWith('QUIRKY_BROWSER_')) continue
    clean[key] = value
  }
  return Object.assign(clean, overrides)
}

function platformBinaryName(): string {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'darwin' && arch === 'arm64') return 'agent-browser-darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'agent-browser-darwin-x64'
  if (platform === 'linux' && arch === 'arm64') return 'agent-browser-linux-arm64'
  if (platform === 'linux' && arch === 'x64') return 'agent-browser-linux-x64'
  return ''
}

export function resolveHelperBinary(runtimeRoot: string): string {
  const packaged = join(runtimeRoot, 'bin', 'agent-browser')
  const packagedManifest = join(runtimeRoot, 'quirky-plugin.json')
  if (existsSync(packagedManifest) && existsSync(packaged)) {
    try { accessSync(packaged, constants.X_OK) } catch { throw fault('browser_unavailable', 'packaged agent-browser helper is not executable') }
    return packaged
  }
  let packageJsonPath: string
  try {
    packageJsonPath = createRequire(join(runtimeRoot, 'package.json')).resolve('agent-browser/package.json')
  } catch {
    throw fault('browser_unavailable', 'the pinned agent-browser helper is missing; run bun install and rebuild the desktop plugin assets')
  }
  let packageValue: unknown
  try { packageValue = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown } catch {
    throw fault('browser_unavailable', 'the installed agent-browser package metadata is unreadable')
  }
  const failure = validateValue({
    type: 'object',
    properties: { name: { type: 'string' }, version: { type: 'string' } },
    required: ['name', 'version'],
    additionalProperties: true
  }, packageValue, 'agent-browser package')
  if (failure) throw fault('browser_unavailable', 'the installed agent-browser package metadata is invalid')
  const metadata = packageValue as { name: string; version: string }
  if (metadata.name !== 'agent-browser' || metadata.version !== '0.27.0') throw fault('browser_unavailable', 'agent-browser must be pinned to version 0.27.0')
  const binaryName = platformBinaryName()
  if (binaryName === '') throw fault('browser_unavailable', `agent-browser has no supported native binary for ${process.platform}-${process.arch}`)
  const binary = join(dirname(packageJsonPath), 'bin', binaryName)
  if (!existsSync(binary)) throw fault('browser_unavailable', 'the pinned agent-browser native binary is missing; run bun install and rebuild the desktop plugin assets')
  try { accessSync(binary, constants.X_OK) } catch { throw fault('browser_unavailable', 'the pinned agent-browser native binary is not executable') }
  return binary
}

export async function nativeRequest(
  socketPath: string,
  action: string,
  fields: Record<string, unknown> = {},
  timeoutMs = 90_000,
  signal?: AbortSignal
): Promise<NativeResponse> {
  if (signal?.aborted) throw fault('browser_tab_closed', 'the browser operation was cancelled')
  const id = `qb-${randomUUID()}`
  const request = JSON.stringify({ ...fields, id, action })
  if (Buffer.byteLength(request) > MAX_FRAME_BYTES) throw fault('browser_error', 'native helper request exceeds the 50 MiB frame limit')
  const socket: Socket = createConnection({ path: socketPath })
  const response = Promise.withResolvers<NativeResponse>()
  let frame = ''
  let settled = false
  let onAbort: (() => void) | undefined
  const cleanupAbort = () => {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    cleanupAbort()
    socket.destroy()
    response.reject(new NativeTransportError('browser_timeout', `native helper action ${action} timed out`))
  }, timeoutMs)
  const finishFailure = (detail: string) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    cleanupAbort()
    socket.destroy()
    response.reject(new NativeTransportError('browser_tab_changed', detail))
  }
  onAbort = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    cleanupAbort()
    socket.destroy()
    response.reject(fault('browser_tab_closed', 'the browser operation was cancelled'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  socket.setEncoding('utf8')
  socket.once('connect', () => {
    if (!settled) socket.write(`${request}\n`)
  })
  socket.on('data', (chunk: string) => {
    if (settled) return
    frame += chunk
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      finishFailure('native helper response exceeded the 50 MiB frame limit')
      return
    }
    const boundary = frame.indexOf('\n')
    if (boundary === -1) return
    if (frame.slice(boundary + 1).trim() !== '') {
      finishFailure('native helper returned multiple response frames')
      return
    }
    let value: unknown
    try { value = JSON.parse(frame.slice(0, boundary)) as unknown } catch {
      finishFailure('native helper returned malformed JSON')
      return
    }
    const failure = validateValue(RESPONSE_SCHEMA, value, 'native helper response')
    if (failure) {
      finishFailure('native helper returned a malformed response envelope')
      return
    }
    const parsed = value as NativeResponse
    if (parsed.id !== id) {
      finishFailure('native helper response correlation did not match the request')
      return
    }
    settled = true
    clearTimeout(timer)
    cleanupAbort()
    socket.end()
    response.resolve(parsed)
  })
  socket.once('error', (error) => finishFailure(error.message))
  socket.once('close', () => {
    if (!settled) finishFailure('native helper socket closed before its response')
  })
  return await response.promise
}
export async function startNativeHelper(
  profileRoot: string,
  cdpUrl: string,
  dependencies: BrowserDependencies
): Promise<NativeHelper> {
  const binary = resolveHelperBinary(dependencies.runtimeRoot)
  const session = randomUUID().replaceAll('-', '').slice(0, 12)
  const socketBase = join(profileRoot, 's')
  const socketDir = join(socketBase, session)
  const helperHome = join(profileRoot, 'helper-home')
  mkdirSync(socketBase, { recursive: true, mode: 0o700 })
  chmodSync(socketBase, 0o700)
  mkdirSync(socketDir, { recursive: true, mode: 0o700 })
  mkdirSync(helperHome, { recursive: true, mode: 0o700 })
  chmodSync(socketDir, 0o700)
  chmodSync(helperHome, 0o700)
  mkdirSync(join(helperHome, '.config'), { recursive: true, mode: 0o700 })
  let socketAliasRoot: string
  try {
    socketAliasRoot = mkdtempSync(join('/tmp', 'qbr-'))
  } catch {
    rmSync(socketDir, { recursive: true, force: true })
    rmSync(helperHome, { recursive: true, force: true })
    throw fault('browser_unavailable', 'private native helper socket directory could not be created')
  }
  const socketAccessDir = join(socketAliasRoot, 's')
  try {
    chmodSync(socketAliasRoot, 0o700)
    symlinkSync(socketDir, socketAccessDir)
  } catch {
    rmSync(socketAliasRoot, { recursive: true, force: true })
    rmSync(socketDir, { recursive: true, force: true })
    rmSync(helperHome, { recursive: true, force: true })
    throw fault('browser_unavailable', 'private native helper socket path could not be created')
  }
  const socketPath = join(socketAccessDir, `${session}.sock`)
  if (Buffer.byteLength(socketPath) >= 100) {
    rmSync(socketAliasRoot, { recursive: true, force: true })
    rmSync(socketDir, { recursive: true, force: true })
    rmSync(helperHome, { recursive: true, force: true })
    throw fault('browser_unavailable', 'private native helper socket path is too long')
  }
  const env = environment({
    AGENT_BROWSER_DAEMON: '1',
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_SOCKET_DIR: socketAccessDir,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '0',
    AGENT_BROWSER_NO_AUTO_DIALOG: '1',
    HOME: helperHome,
    USERPROFILE: helperHome,
    XDG_CONFIG_HOME: join(helperHome, '.config'),
    QUIRKY_HOME: helperHome
  })
  let child: BrowserChild
  try {
    child = dependencies.spawn([binary], {
      cwd: profileRoot,
      env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true
    })
  } catch {
    rmSync(socketDir, { recursive: true, force: true })
    rmSync(socketAliasRoot, { recursive: true, force: true })
    rmSync(helperHome, { recursive: true, force: true })
    throw fault('browser_unavailable', 'the pinned native browser helper could not be started')
  }
  try {
    const deadline = Date.now() + 10_000
    while (!existsSync(socketPath)) {
      if (Date.now() >= deadline) throw new Error('native helper socket startup timed out')
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(20).then(() => false)])
      if (exited) throw new Error('native helper exited before creating its private socket')
    }
    const launched = await nativeRequest(socketPath, 'launch', { cdpUrl }, 10_000)
    if (!launched.success) throw new Error(launched.error ?? 'native helper could not attach to owned Chrome')
  } catch {
    await stopOwned(child, 500)
    rmSync(socketDir, { recursive: true, force: true })
    rmSync(socketAliasRoot, { recursive: true, force: true })
    rmSync(helperHome, { recursive: true, force: true })
    throw fault('browser_unavailable', 'the native browser helper could not attach to the owned Chrome process')
  }
  return {
    child,
    session,
    socketDir,
    socketAliasRoot,
    socketPath,
    async asyncClose() {
      try { await nativeRequest(socketPath, 'close', {}, 5_000) } catch { /* owned helper may already be gone */ }
      await stopOwned(child, 5_000)
      rmSync(socketDir, { recursive: true, force: true })
      rmSync(socketAliasRoot, { recursive: true, force: true })
      rmSync(helperHome, { recursive: true, force: true })
    }
  }
}
