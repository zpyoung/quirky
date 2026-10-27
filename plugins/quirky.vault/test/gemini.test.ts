import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyClient } from '@quirky/protocol'
import { afterEach, describe, expect, test } from 'bun:test'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'

type HostedSession = {
  id: string
  sourceId: string
  hostId: string
  agent: string
  sessionId: string
  title: string
  cwd: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
  previewMessages: { role: string; text: string; timestamp: number | null }[]
  source: { presence: string; filePath?: string }
}

type PublicListResult = { sessions: HostedSession[] }
type ApiFailure = { code: number; message: string }
type TestVault = { sourceHome: string; client: QuirkyClient }

type GeminiFixture = {
  sessionId: string
  prompt: string
  answer: string
  filePath: string
}

const startTime = '2026-10-20T15:04:00.000Z'
const lastUpdated = '2026-10-20T15:06:00.000Z'
const activeHarnesses: Harness[] = []
const temporaryHomes: string[] = []
const sourceHomes: string[] = []
let originalSourceHome: string | undefined
let sourceHomeOverridden = false

afterEach(async () => {
  try {
    for (const harness of activeHarnesses.splice(0)) await harness.cleanup()
  } finally {
    await Promise.all([...temporaryHomes.splice(0), ...sourceHomes.splice(0)].map((home) => rm(home, { recursive: true, force: true })))
    if (sourceHomeOverridden) {
      if (originalSourceHome === undefined) delete process.env.QUIRKY_VAULT_SOURCE_HOME
      else process.env.QUIRKY_VAULT_SOURCE_HOME = originalSourceHome
      originalSourceHome = undefined
      sourceHomeOverridden = false
    }
  }
})

async function startVault(): Promise<TestVault> {
  const sourceHome = makeTempHome('qv-gemini-source-')
  sourceHomes.push(sourceHome)
  if (!sourceHomeOverridden) {
    originalSourceHome = process.env.QUIRKY_VAULT_SOURCE_HOME
    sourceHomeOverridden = true
  }
  process.env.QUIRKY_VAULT_SOURCE_HOME = sourceHome

  const home = makeTempHome('qv-gemini-daemon-')
  temporaryHomes.push(home)
  const harness = await startHarness({ home, builtinPluginsDir: builtinsDir(), safeMode: true })
  activeHarnesses.push(harness)
  return { sourceHome, client: await harness.connect() }
}

function projectHash(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex')
}

async function createProjectRoot(sourceHome: string, name: string): Promise<string> {
  const root = join(sourceHome, 'workspaces', name)
  await mkdir(root, { recursive: true })
  return root
}

async function writeProjectMarker(sourceHome: string, slug: string, projectRoot: string): Promise<void> {
  await mkdir(join(sourceHome, '.gemini', 'tmp', slug), { recursive: true })
  await writeFile(join(sourceHome, '.gemini', 'tmp', slug, '.project_root'), projectRoot)
}

async function writeProjectRegistry(sourceHome: string, projects: Record<string, string>): Promise<void> {
  const geminiHome = join(sourceHome, '.gemini')
  await mkdir(geminiHome, { recursive: true })
  await writeFile(join(geminiHome, 'projects.json'), JSON.stringify({ projects }, null, 2))
}

async function writeGeminiSession(
  sourceHome: string,
  slug: string,
  format: 'json' | 'jsonl',
  options: { projectRoot?: string; includeProjectHash?: boolean; cwd?: string } = {}
): Promise<GeminiFixture> {
  const sessionId = randomUUID()
  const prompt = `Gemini ${format.toUpperCase()} cwd recovery prompt ${sessionId}`
  const answer = 'The session transcript has a real user and assistant exchange.'
  const metadata = {
    sessionId,
    ...(options.includeProjectHash === false || options.projectRoot === undefined ? {} : { projectHash: projectHash(options.projectRoot) }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    startTime,
    lastUpdated
  }
  const messages = [
    { id: randomUUID(), type: 'user', timestamp: startTime, content: [{ text: prompt }] },
    { id: randomUUID(), type: 'gemini', timestamp: lastUpdated, content: [{ text: answer }], model: 'gemini-2.5-pro' }
  ]
  const chats = join(sourceHome, '.gemini', 'tmp', slug, 'chats')
  await mkdir(chats, { recursive: true })
  const filePath = format === 'json'
    ? join(chats, `${sessionId}.json`)
    : join(chats, `session-${startTime.slice(0, 16).replace(/:/g, '-')}-${sessionId.slice(0, 8)}.jsonl`)
  const contents = format === 'json'
    ? JSON.stringify({ ...metadata, messages }, null, 2)
    : [metadata, ...messages].map((record) => JSON.stringify(record)).join('\n') + '\n'
  await writeFile(filePath, contents)
  return { sessionId, prompt, answer, filePath }
}

async function listGemini(client: TestVault['client']): Promise<HostedSession[]> {
  const rawResult = await client.callAny('quirky.vault/list', {
    host: 'local',
    unlimited: true,
    agents: ['gemini']
  })
  const result = rawResult as PublicListResult
  return result.sessions
}

async function sessionById(client: TestVault['client'], sessionId: string): Promise<HostedSession> {
  const session = (await listGemini(client)).find((item) => item.sessionId === sessionId)
  if (!session) throw new Error(`Gemini session ${sessionId} was not listed`)
  return session
}

function expectGeminiSession(
  session: HostedSession,
  fixture: GeminiFixture,
  projectRoot: string | null
): void {
  // Bun 1.4 asymmetric matchers mutate received fields; preserve IDs used by later RPC calls.
  expect(typeof session.id).toBe('string')
  expect(typeof session.sourceId).toBe('string')
  expect({
    hostId: session.hostId,
    agent: session.agent,
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount
  }).toEqual({
    hostId: 'local',
    agent: 'gemini',
    sessionId: fixture.sessionId,
    title: fixture.prompt,
    cwd: projectRoot,
    createdAt: Date.parse(startTime),
    updatedAt: Date.parse(lastUpdated),
    messageCount: 2
  })
  expect(session.previewMessages.map(({ role, text, timestamp }) => ({ role, text, timestamp }))).toEqual([
    { role: 'user', text: fixture.prompt, timestamp: Date.parse(startTime) },
    { role: 'assistant', text: fixture.answer, timestamp: Date.parse(lastUpdated) }
  ])
  expect(session.source.presence).toBe('present')
  expect(session.source.filePath).toBe(fixture.filePath)
  expect(session.id).not.toBe(session.sourceId)
}

async function rpcFailure(call: Promise<unknown>): Promise<ApiFailure> {
  try {
    await call
  } catch (error) {
    return error as ApiFailure
  }
  throw new Error('expected the daemon API call to fail')
}

describe('Gemini cwd recovery through the daemon API', () => {
  test('recovers cwd for JSON and JSONL chats from the real project-root marker', async () => {
    const { sourceHome, client } = await startVault()
    const projectRoot = await createProjectRoot(sourceHome, 'gemini-marker-root')
    const slug = 'gemini-marker-project'
    await writeProjectMarker(sourceHome, slug, projectRoot)
    const json = await writeGeminiSession(sourceHome, slug, 'json', { projectRoot })
    const jsonl = await writeGeminiSession(sourceHome, slug, 'jsonl', { projectRoot })

    for (const fixture of [json, jsonl]) {
      const listed = await sessionById(client, fixture.sessionId)
      expectGeminiSession(listed, fixture, projectRoot)

      const fetched = (await client.callAny('quirky.vault/get', { id: listed.id })) as HostedSession | null
      expect(fetched).not.toBeNull()
      expectGeminiSession(fetched!, fixture, projectRoot)
    }
  })
  test('preserves an explicit transcript cwd over marker and registry metadata', async () => {
    const { sourceHome, client } = await startVault()
    const explicitRoot = await createProjectRoot(sourceHome, 'gemini-explicit-cwd')
    const markerRoot = await createProjectRoot(sourceHome, 'gemini-explicit-marker')
    const registryRoot = await createProjectRoot(sourceHome, 'gemini-explicit-registry')
    const slug = 'gemini-explicit-precedence'
    await writeProjectMarker(sourceHome, slug, markerRoot)
    await writeProjectRegistry(sourceHome, { [registryRoot]: slug })

    for (const format of ['json', 'jsonl'] as const) {
      const fixture = await writeGeminiSession(sourceHome, slug, format, {
        projectRoot: registryRoot,
        cwd: explicitRoot
      })
      const listed = await sessionById(client, fixture.sessionId)
      expectGeminiSession(listed, fixture, explicitRoot)
    }
  })

  test('uses the project marker before registry data', async () => {
    const { sourceHome, client } = await startVault()
    const markerRoot = await createProjectRoot(sourceHome, 'gemini-marker-precedence')
    const registryRoot = await createProjectRoot(sourceHome, 'gemini-registry-precedence')
    const slug = 'gemini-marker-precedence'
    await writeProjectMarker(sourceHome, slug, markerRoot)
    await writeProjectRegistry(sourceHome, { [registryRoot]: slug })
    const fixture = await writeGeminiSession(sourceHome, slug, 'jsonl', { includeProjectHash: false })

    const listed = await sessionById(client, fixture.sessionId)
    expectGeminiSession(listed, fixture, markerRoot)
  })

  test('reparses unchanged transcripts when Gemini project registry metadata changes', async () => {
    const { sourceHome, client } = await startVault()
    const firstRoot = await createProjectRoot(sourceHome, 'gemini-registry-before-change')
    const secondRoot = await createProjectRoot(sourceHome, 'gemini-registry-after-change')
    const slug = 'gemini-registry-changing'
    await writeProjectRegistry(sourceHome, { [firstRoot]: slug })
    const fixture = await writeGeminiSession(sourceHome, slug, 'json', { includeProjectHash: false })

    const before = await sessionById(client, fixture.sessionId)
    expectGeminiSession(before, fixture, firstRoot)

    await writeProjectRegistry(sourceHome, { [secondRoot]: slug })
    const after = await sessionById(client, fixture.sessionId)

    expect(after.sourceId).toBe(before.sourceId)
    expectGeminiSession(after, fixture, secondRoot)
  })

  test('reparses unchanged transcript metadata when the project-root marker changes', async () => {
    const { sourceHome, client } = await startVault()
    const oldRoot = await createProjectRoot(sourceHome, 'gemini-root-before-marker-change')
    const newRoot = await createProjectRoot(sourceHome, 'gemini-root-after-marker-change-with-longer-name')
    const slug = 'gemini-changing-marker'
    const fixture = await writeGeminiSession(sourceHome, slug, 'json', { projectRoot: oldRoot })
    await writeProjectMarker(sourceHome, slug, oldRoot)

    const before = await sessionById(client, fixture.sessionId)
    expectGeminiSession(before, fixture, oldRoot)

    await writeProjectMarker(sourceHome, slug, newRoot)
    const after = await sessionById(client, fixture.sessionId)

    expect(after.sourceId).toBe(before.sourceId)
    expectGeminiSession(after, fixture, newRoot)
  })

  test('resolves a hashed session through Gemini’s root-to-slug project registry', async () => {
    const { sourceHome, client } = await startVault()
    const projectRoot = await createProjectRoot(sourceHome, 'gemini-registry-known-root')
    const slug = 'gemini-registry-project'
    await writeProjectRegistry(sourceHome, { [projectRoot]: slug })
    const fixture = await writeGeminiSession(sourceHome, slug, 'jsonl', { projectRoot })

    const listed = await sessionById(client, fixture.sessionId)
    expectGeminiSession(listed, fixture, projectRoot)

    const fetched = (await client.callAny('quirky.vault/get', { id: listed.id })) as HostedSession | null
    expect(fetched).not.toBeNull()
    expectGeminiSession(fetched!, fixture, projectRoot)
  })

  test('does not reverse an unmatched project hash or fall back to the process cwd', async () => {
    const { sourceHome, client } = await startVault()
    const unknownRoot = await createProjectRoot(sourceHome, 'gemini-unregistered-project')
    const slug = projectHash(unknownRoot)
    const fixture = await writeGeminiSession(sourceHome, slug, 'jsonl', { projectRoot: unknownRoot })

    const listed = await sessionById(client, fixture.sessionId)
    expectGeminiSession(listed, fixture, null)
    expect(listed.cwd).not.toBe(process.cwd())
    expect(JSON.stringify(listed)).not.toContain(process.cwd())

    const failure = await rpcFailure(client.callAny('quirky.vault/prepareResume', { id: listed.id }))
    expect(failure.code).toBe(RpcErrorCode.Conflict)
  })

  test('keeps a flat legacy Gemini JSON session without metadata cwd-unknown', async () => {
    const { sourceHome, client } = await startVault()
    const sessionId = randomUUID()
    const fixture: GeminiFixture = {
      sessionId,
      prompt: `Legacy Gemini prompt ${sessionId}`,
      answer: 'Legacy Gemini assistant response.',
      filePath: join(sourceHome, '.gemini', 'tmp', `${sessionId}.json`)
    }
    await mkdir(join(sourceHome, '.gemini', 'tmp'), { recursive: true })
    await writeFile(fixture.filePath, JSON.stringify({
      sessionId,
      startTime,
      lastUpdated,
      messages: [
        { type: 'user', timestamp: startTime, content: [{ text: fixture.prompt }] },
        { type: 'gemini', timestamp: lastUpdated, content: [{ text: fixture.answer }], model: 'gemini-2.5-pro' }
      ]
    }))

    const listed = await sessionById(client, fixture.sessionId)
    expectGeminiSession(listed, fixture, null)

    const failure = await rpcFailure(client.callAny('quirky.vault/prepareResume', { id: listed.id }))
    expect(failure.code).toBe(RpcErrorCode.Conflict)
  })
})
