import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, TerminalArtifactResult } from '@quirky/protocol'
import { TerminalArtifactsService } from '../src/artifacts'

const RETENTION_MS = 30 * 60 * 1000
const GRANT_MS = 5 * 60 * 1000
const callers = {
  phoneA: { role: 'mobile', deviceId: 'device-a' } as const,
  phoneB: { role: 'mobile', deviceId: 'device-b' } as const
}

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

type Listed = Extract<TerminalArtifactResult, { kind: 'listed' }>
type Preview = Extract<TerminalArtifactResult, { kind: 'preview' }>

function listed(result: TerminalArtifactResult): Listed {
  if (result.kind !== 'listed') throw new Error(`expected listed artifacts, got ${result.kind}`)
  return result
}

function preview(result: TerminalArtifactResult): Preview {
  if (result.kind !== 'preview') throw new Error(`expected artifact preview, got ${result.kind}`)
  return result
}

type ServiceFixtureOptions = {
  live?: boolean
  onSessionLookup?: (count: number) => void
}

function makeService(
  now: () => number,
  path: string,
  identity: { processIncarnation: string; runtimeEpoch: string },
  options: ServiceFixtureOptions = {}
) {
  const cwd = join(root!, 'cwd')
  const session = {
    id: 'session-1',
    kind: 'terminal',
    worktreeId: 'worktree-1',
    status: 'running'
  }
  let sessionLookups = 0
  const context = {
    pluginId: 'quirky.terminal',
    pty: {
      connected: true,
      async list() {
        return [{ sessionId: session.id, state: 'running', alive: true, pid: 1, cwd, offset: 1 }]
      },
      async read() {
        return { lines: [path], cols: 80, rows: 24, alt: false }
      }
    },
    async call(method: string, params?: Record<string, unknown>) {
      if (method !== 'quirky.session/get' || params?.session !== session.id) {
        throw new Error(`unexpected public API call: ${method}`)
      }
      options.onSessionLookup?.(++sessionLookups)
      return session
    },
    launch: {
      sessionIdentity(sessionId: string) {
        if (sessionId !== session.id) return null
        return {
          sessionId,
          live: options.live ?? true,
          source: 'terminal_launch',
          processIncarnation: identity.processIncarnation,
          runtimeEpoch: identity.runtimeEpoch
        }
      }
    }
  } as unknown as PluginContext
  return new TerminalArtifactsService(context, { now })
}

function request(action: 'list' | 'preview' | 'refresh' | 'save', extra: Record<string, unknown> = {}) {
  return { action, worktree: 'worktree-1', session: 'session-1', ...extra }
}

test('binds a grant to the authenticated mobile device, not its connection or request fields', async () => {
  root = mkdtempSync(join(tmpdir(), 'terminal-artifact-api-'))
  const cwd = join(root, 'cwd')
  mkdirSync(cwd)
  const path = join(cwd, 'printed.txt')
  writeFileSync(path, 'source text\n')
  const service = makeService(() => 1_000, path, { processIncarnation: 'process-a', runtimeEpoch: 'runtime-a' })
  const artifact = listed(await service.handle(request('list'), callers.phoneA)).artifacts[0]!

  const denied = await service.handle(request('preview', { artifactId: artifact.artifactId, grant: artifact.grant }), callers.phoneB)
  expect(denied).toMatchObject({ kind: 'refused', reason: 'grant-invalid' })
})

test('caps discovered artifacts at fifty while reporting scan limits', async () => {
  root = mkdtempSync(join(tmpdir(), 'terminal-artifact-list-limit-'))
  const cwd = join(root, 'cwd')
  mkdirSync(cwd)
  const paths = Array.from({ length: 55 }, (_, index) => join(cwd, `item-${index}.txt`))
  for (const path of paths) writeFileSync(path, 'text\n')
  const service = makeService(() => 2_000, paths.join(' '), { processIncarnation: 'process-a', runtimeEpoch: 'runtime-a' })

  const result = listed(await service.handle(request('list'), callers.phoneA))
  expect(result.artifacts).toHaveLength(50)
  expect(result.limited).toBe(true)
})

test('requires live kernel launch authority even when terminal metadata names an existing local file', async () => {
  root = mkdtempSync(join(tmpdir(), 'terminal-artifact-remote-session-'))
  const cwd = join(root, 'cwd')
  mkdirSync(cwd)
  const path = join(cwd, 'printed.txt')
  writeFileSync(path, 'local file text\n')
  const service = makeService(
    () => 3_000,
    path,
    { processIncarnation: 'process-a', runtimeEpoch: 'runtime-a' },
    { live: false }
  )

  expect(await service.handle(request('list'), callers.phoneA))
    .toMatchObject({ kind: 'refused', reason: 'source-unavailable' })
})


test('expires grants at five minutes and refresh keeps the original preview revision through disk changes', async () => {
  root = mkdtempSync(join(tmpdir(), 'terminal-artifact-clock-'))
  const cwd = join(root, 'cwd')
  mkdirSync(cwd)
  const path = join(cwd, 'printed.txt')
  writeFileSync(path, 'preview base\n')
  let now = 10_000
  const service = makeService(() => now, path, { processIncarnation: 'process-a', runtimeEpoch: 'runtime-a' })
  const artifact = listed(await service.handle(request('list'), callers.phoneA)).artifacts[0]!
  const original = preview(await service.handle(request('preview', { artifactId: artifact.artifactId, grant: artifact.grant }), callers.phoneA))

  now += GRANT_MS + 1
  expect(await service.handle(request('preview', { artifactId: artifact.artifactId, grant: artifact.grant }), callers.phoneA))
    .toMatchObject({ kind: 'refused', reason: 'grant-expired' })

  writeFileSync(path, 'external update after preview\n')
  const refreshed = await service.handle(request('refresh', { artifactId: artifact.artifactId, grant: artifact.grant }), callers.phoneA)
  expect(refreshed.kind).toBe('refreshed')
  if (refreshed.kind !== 'refreshed') throw new Error('expected a renewed capability')
  expect(refreshed.artifact.grant).not.toBe(artifact.grant)
  const refused = await service.handle(request('save', {
    artifactId: artifact.artifactId,
    grant: refreshed.artifact.grant,
    expectedRevision: original.revision,
    content: 'stale draft\n'
  }), callers.phoneA)
  expect(refused).toMatchObject({ kind: 'refused', reason: 'file-changed' })
  expect(readFileSync(path, 'utf8')).toBe('external update after preview\n')

  now = 10_000 + RETENTION_MS + 1
  expect(await service.handle(request('refresh', { artifactId: artifact.artifactId, grant: refreshed.artifact.grant }), callers.phoneA))
    .toMatchObject({ kind: 'refused', reason: 'grant-invalid' })
})

test('refuses a same-path inode replacement before writing through the pinned descriptor', async () => {
  root = mkdtempSync(join(tmpdir(), 'terminal-artifact-inode-race-'))
  const cwd = join(root, 'cwd')
  mkdirSync(cwd)
  const path = join(cwd, 'printed.txt')
  const replacement = join(cwd, 'replacement.txt')
  writeFileSync(path, 'preview base\n')
  writeFileSync(replacement, 'replacement file bytes\n')
  let replaced = false
  const service = makeService(
    () => 30_000,
    path,
    { processIncarnation: 'process-a', runtimeEpoch: 'runtime-a' },
    {
      onSessionLookup(count) {
        if (count === 6) {
          renameSync(replacement, path)
          replaced = true
        }
      }
    }
  )
  const artifact = listed(await service.handle(request('list'), callers.phoneA)).artifacts[0]!
  const original = preview(await service.handle(request('preview', {
    artifactId: artifact.artifactId,
    grant: artifact.grant
  }), callers.phoneA))

  const result = await service.handle(request('save', {
    artifactId: artifact.artifactId,
    grant: artifact.grant,
    expectedRevision: original.revision,
    content: 'must not write through a stale descriptor\n'
  }), callers.phoneA)
  expect(replaced).toBe(true)
  expect(result).toMatchObject({ kind: 'refused', reason: 'file-changed' })
  expect(readFileSync(path, 'utf8')).toBe('replacement file bytes\n')
})

test('refuses a capability after its terminal process incarnation changes', async () => {
  root = mkdtempSync(join(tmpdir(), 'terminal-artifact-source-'))
  const path = join(root, 'source.txt')
  mkdirSync(join(root, 'cwd'))
  writeFileSync(path, 'text\n')
  let processIncarnation = 'process-a'
  const service = makeService(() => 25_000, path, {
    get processIncarnation() { return processIncarnation },
    runtimeEpoch: 'runtime-a'
  })
  const artifact = listed(await service.handle(request('list'), callers.phoneA)).artifacts[0]!
  processIncarnation = 'process-b'
  expect(await service.handle(request('preview', { artifactId: artifact.artifactId, grant: artifact.grant }), callers.phoneA))
    .toMatchObject({ kind: 'refused', reason: 'source-unavailable' })
})

test('shutdown drops every in-memory artifact grant', async () => {
  root = mkdtempSync(join(tmpdir(), 'terminal-artifact-shutdown-'))
  const cwd = join(root, 'cwd')
  mkdirSync(cwd)
  const path = join(cwd, 'printed.txt')
  writeFileSync(path, 'source text\n')
  const service = makeService(() => 40_000, path, { processIncarnation: 'process-a', runtimeEpoch: 'runtime-a' })
  const artifact = listed(await service.handle(request('list'), callers.phoneA)).artifacts[0]!
  service.shutdown()

  expect(await service.handle(request('preview', { artifactId: artifact.artifactId, grant: artifact.grant }), callers.phoneA))
    .toMatchObject({ kind: 'refused', reason: 'source-unavailable' })
  const reactivated = makeService(() => 40_001, path, { processIncarnation: 'process-a', runtimeEpoch: 'runtime-a' })
  expect(await reactivated.handle(request('preview', { artifactId: artifact.artifactId, grant: artifact.grant }), callers.phoneA))
    .toMatchObject({ kind: 'refused', reason: 'grant-invalid' })
})
