import { afterAll, expect, mock, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginCaller, PluginContext, TerminalArtifactRequest } from '@quirky/protocol'
import type { DaemonLink } from '../packages/cli/src/link'
import { run } from '../packages/cli/src/main'

const ARTIFACT_GUIDANCE = 'Terminal artifacts require a supported local terminal host and an exact artifact request.'
const SIMULATOR_REASON = 'iOS Simulator preview requires macOS and Xcode.'
const PLIST_MESSAGE = 'Native Browser label host ATS configuration requires macOS and plutil.'
const DEVICE_UDID = '00000000-0000-0000-0000-000000000001'
const BUILD_HOOK_ENV = ['ELECTROBUN_BUILD_DIR', 'ELECTROBUN_OS'] as const
const savedBuildHookEnv = {
  ELECTROBUN_BUILD_DIR: process.env.ELECTROBUN_BUILD_DIR,
  ELECTROBUN_OS: process.env.ELECTROBUN_OS
}
const worldDependencyCalls: string[] = []
const fileAuthorityCalls: string[] = []
const externalProcessCalls: string[] = []
let recordingWorldOperations = false

function guardedWorldOperation<T>(kind: 'filesystem' | 'process', name: string, operation: () => T): T {
  if (recordingWorldOperations) {
    if (kind === 'filesystem') fileAuthorityCalls.push(name)
    else externalProcessCalls.push(name)
    throw new Error(`unexpected ${kind} operation: ${name}`)
  }
  return operation()
}

const TRACKED_FS_OPERATIONS: Record<string, true> = {
  closeSync: true,
  existsSync: true,
  fstatSync: true,
  fsyncSync: true,
  ftruncateSync: true,
  mkdirSync: true,
  openSync: true,
  readFileSync: true,
  readSync: true,
  readdirSync: true,
  realpathSync: true,
  renameSync: true,
  rmSync: true,
  statSync: true,
  unlinkSync: true,
  writeFileSync: true,
  writeSync: true
}

const trackedFs = new Proxy({ ...fs }, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver)
    if (typeof property !== 'string' || TRACKED_FS_OPERATIONS[property] !== true || typeof value !== 'function') return value
    return (...args: unknown[]) => guardedWorldOperation(
      'filesystem', property, () => Reflect.apply(value, fs, args)
    )
  }
})

const savedFiles = { ...fs }
const savedChildProcess = { ...childProcess }

// Import after installing file/process recorders and clearing build-hook inputs.
const testModules = await (async () => {
  for (const key of BUILD_HOOK_ENV) delete process.env[key]
  try {
    mock.module('node:fs', () => trackedFs)
    mock.module('node:child_process', () => ({
      ...savedChildProcess,
      spawnSync: (...args: Parameters<typeof childProcess.spawnSync>) => guardedWorldOperation(
        'process', 'spawnSync', () => savedChildProcess.spawnSync(...args)
      )
    }))
    const [artifacts, emulator, plist] = await Promise.all([
      import('../plugins/quirky.terminal/src/artifacts'),
      import('../plugins/quirky.terminal/src/emulator'),
      import('../apps/desktop/scripts/allow-label-hosts')
    ])
    return { artifacts, emulator, plist }
  } catch (error) {
    mock.module('node:fs', () => savedFiles)
    mock.module('node:child_process', () => savedChildProcess)
    throw error
  } finally {
    for (const key of BUILD_HOOK_ENV) {
      const value = savedBuildHookEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})()
const { TerminalArtifactsService } = testModules.artifacts
const { EmulatorService } = testModules.emulator
const { allowLabelHosts } = testModules.plist

afterAll(() => {
  recordingWorldOperations = false
  mock.module('node:fs', () => savedFiles)
  mock.module('node:child_process', () => savedChildProcess)
})

let platformOverrideQueue = Promise.resolve()

async function withLinuxPlatform<T>(operation: () => Promise<T>): Promise<T> {
  const previous = platformOverrideQueue
  const turn = Promise.withResolvers<void>()
  platformOverrideQueue = previous.then(() => turn.promise)
  await previous

  let original: PropertyDescriptor | undefined
  let overridden = false
  try {
    if (process.platform !== 'linux') {
      original = Object.getOwnPropertyDescriptor(process, 'platform')
      if (!original) throw new Error('process.platform has no own property descriptor')
      const linux: PropertyDescriptor = 'value' in original
        ? { ...original, value: 'linux' }
        : { configurable: true, enumerable: original.enumerable, writable: true, value: 'linux' }
      Object.defineProperty(process, 'platform', linux)
      overridden = true
    }
    return await operation()
  } finally {
    try {
      if (overridden && original) Object.defineProperty(process, 'platform', original)
    } finally {
      turn.resolve()
    }
  }
}

function forbiddenDependency(name: string): never {
  worldDependencyCalls.push(name)
  throw new Error(`unexpected world-facing dependency call: ${name}`)
}

test('valid terminal artifact requests, simulator preview, and plist access are refused on Linux', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'quirky-linux-platform-refusals-'))
  const home = join(root, 'home')
  const buildDirectory = join(root, 'build')
  const appContents = join(buildDirectory, 'Quirky.app', 'Contents')
  const artifactPath = join(home, 'printed.txt')
  const artifactBytes = Buffer.from('original terminal output\n')
  const plistPath = join(appContents, 'Info.plist')
  const plistBytes = Buffer.from('<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>dev.quirky.app</string></dict></plist>\n')
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(appContents, { recursive: true })
    fs.writeFileSync(artifactPath, artifactBytes)
    fs.writeFileSync(plistPath, plistBytes)
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true })
    throw error
  }

  const requests: TerminalArtifactRequest[] = [
    { action: 'list', worktree: 'worktree-1', session: 'session-1' },
    { action: 'preview', worktree: 'worktree-1', session: 'session-1', artifactId: 'artifact-1', grant: 'b'.repeat(64) },
    { action: 'refresh', worktree: 'worktree-1', session: 'session-1', artifactId: 'artifact-1', grant: 'b'.repeat(64) },
    {
      action: 'save', worktree: 'worktree-1', session: 'session-1', artifactId: 'artifact-1', grant: 'b'.repeat(64),
      expectedRevision: 'a'.repeat(64), content: 'replacement output\n'
    }
  ]
  expect(requests[3]?.expectedRevision).toMatch(/^[a-f0-9]{64}$/)
  const callers: PluginCaller[] = [
    { role: 'mobile', deviceId: 'authenticated-device-1' },
    { role: 'cli', ownerGrantId: 'authenticated-owner-1' }
  ]
  const artifactContext = {
    pluginId: 'quirky.terminal',
    pty: new Proxy({}, { get: (_target, property) => forbiddenDependency(`pty.${String(property)}`) }),
    async call(method: string) { return forbiddenDependency(`session.${method}`) },
    launch: {
      sessionIdentity() { return forbiddenDependency('launch.sessionIdentity') }
    },
    async createFileResource() { return forbiddenDependency('file-authority.createFileResource') }
  } as unknown as PluginContext
  const artifacts = new TerminalArtifactsService(artifactContext)
  const simulatorProcesses: string[][] = []
  const simulatorErrors: Array<{ kind: string; message: string }> = []
  const emulator = new EmulatorService({
    process: {
      async run(argv: string[]) {
        simulatorProcesses.push(argv)
        throw new Error(`unexpected simulator process: ${argv.join(' ')}`)
      }
    },
    error(kind: string, message: string) {
      simulatorErrors.push({ kind, message })
      return new Error(message)
    }
  } as unknown as PluginContext)

  try {
    await withLinuxPlatform(async () => {
      recordingWorldOperations = true
      try {
        const refusal = { kind: 'refused', reason: 'unsupported', guidance: ARTIFACT_GUIDANCE }
        for (const caller of callers) {
          for (const request of requests) {
            expect(await artifacts.handle({ ...request }, caller)).toEqual(refusal)
          }
        }

        expect(await emulator.list()).toEqual({ available: false, devices: [], reason: SIMULATOR_REASON })
        let frameError: unknown
        try {
          await emulator.frame({ device: DEVICE_UDID })
        } catch (error) {
          frameError = error
        }
        if (!(frameError instanceof Error)) throw new Error('emulator.frame did not reject the valid UDID')
        expect(frameError.message).toBe(SIMULATOR_REASON)
        expect(simulatorErrors).toEqual([{ kind: 'conflict', message: SIMULATOR_REASON }])
        expect(simulatorProcesses).toEqual([])

        let plistError: unknown
        try {
          allowLabelHosts(buildDirectory)
        } catch (error) {
          plistError = error
        }
        if (!(plistError instanceof Error)) throw new Error('allowLabelHosts did not reject the Linux platform')
        expect(plistError.message).toBe(PLIST_MESSAGE)
        expect(fileAuthorityCalls).toEqual([])
        expect(externalProcessCalls).toEqual([])
        expect(worldDependencyCalls).toEqual([])
      } finally {
        recordingWorldOperations = false
      }
    })

    for (const daemon of ['connected', 'stalled'] as const) {
      const stdout: string[] = []
      const stderr: string[] = []
      const cliCalls: string[] = []
      const link = {
        requestBase: 'linux-open-refusal',
        async call(method: string) {
          cliCalls.push(`call:${method}`)
          if (daemon === 'stalled') return await new Promise<never>(() => {})
          return { clients: [{ role: 'desktop' }] }
        },
        async callAny(method: string) {
          cliCalls.push(`callAny:${method}`)
          if (daemon === 'stalled') return await new Promise<never>(() => {})
          return {}
        },
        async reconnect() {
          cliCalls.push('reconnect')
          if (daemon === 'stalled') await new Promise<never>(() => {})
        },
        close() {}
      } as unknown as DaemonLink
      const runtime = {
        argv: ['open', '--json'],
        env: { QUIRKY_HOME: home },
        cwd: home,
        platform: 'linux',
        writer: { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) },
        link,
        async openDesktopApp() {
          cliCalls.push('openDesktopApp')
          return { ok: true }
        }
      }
      expect(await run(runtime)).toBe(1)
      expect(JSON.parse(stdout.join(''))).toEqual({
        error: { code: 'internal', message: '`quirky open` is only supported on macOS' }
      })
      expect(stderr.join('')).toBe('')
      expect(cliCalls).toEqual([])
    }

    expect(fs.readFileSync(artifactPath)).toEqual(artifactBytes)
    expect(fs.readFileSync(plistPath)).toEqual(plistBytes)
  } finally {
    recordingWorldOperations = false
    fs.rmSync(root, { recursive: true, force: true })
  }
})
