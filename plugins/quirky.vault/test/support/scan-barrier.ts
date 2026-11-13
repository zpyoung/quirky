import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type ScanBarrierKind = 'list' | 'index'

export interface ScanBarrier {
  arm(filePath: string, kinds: Array<'list' | 'index'>): Promise<void>
  waitUntilBlocked(kind: 'list' | 'index'): Promise<void>
  listStarts(): Promise<number>
  release(): Promise<void>
  close(): Promise<void>
}

type BarrierConfig = { generation: number; filePath: string; kinds: ScanBarrierKind[] }

const WAIT_INTERVAL_MS = 10
const WAIT_TIMEOUT_MS = 30_000
const CLEANUP_TIMEOUT_MS = 2_000

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function waitForFile(path: string, description: string, timeoutMs: number, closedPath?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (await exists(path)) return
    if (closedPath && await exists(closedPath)) throw new Error(`scan barrier closed while waiting for ${description}`)
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    const { promise, resolve: resume } = Promise.withResolvers<void>()
    setTimeout(resume, WAIT_INTERVAL_MS)
    await promise
  }
}

function scannerWrapper(stateDir: string): string {
  return [
    "import { appendFile } from 'node:fs/promises'",
    "import { createScanner as createRealScanner } from './index.real'",
    "import type { ListRequest, ScannerOptions, VaultScanner } from '../types'",
    '',
    `const listStartsPath = ${JSON.stringify(join(stateDir, 'list-starts.txt'))}`,
    'let listStartCount = 0',
    'let recordedStarts: Promise<void> = Promise.resolve()',
    '',
    'export function createScanner(options: ScannerOptions): VaultScanner {',
    '  const scanner = createRealScanner(options)',
    '  return {',
    '    ...scanner,',
    '    async list(request: ListRequest, signal?: AbortSignal) {',
    '      const count = ++listStartCount',
    '      const recorded = recordedStarts.then(() => appendFile(listStartsPath, String(count) + String.fromCharCode(10)))',
    '      recordedStarts = recorded',
    '      await recorded',
    '      return scanner.list(request, signal)',
    '    }',
    '  }',
    '}'
  ].join('\n')
}

function parserWrapper(stateDir: string): string {
  return [
    "import { access, readFile, writeFile } from 'node:fs/promises'",
    "import { join, resolve } from 'node:path'",
    "import { parsePrimary as parseRealPrimary } from './primary.real'",
    "import type { ParserContext } from './shared'",
    '',
    "type BarrierKind = 'list' | 'index'",
    'type BarrierConfig = { generation: number; filePath: string; kinds: BarrierKind[] }',
    'type RawBarrierConfig = { generation?: unknown; filePath?: unknown; kinds?: unknown }',
    `const stateDir = ${JSON.stringify(stateDir)}`,
    '',
    'function isBarrierKind(value: unknown): value is BarrierKind {',
    "  return value === 'list' || value === 'index'",
    '}',
    '',
    'async function exists(path: string): Promise<boolean> {',
    '  try {',
    '    await access(path)',
    '    return true',
    '  } catch (error) {',
    "    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false",
    '    throw error',
    '  }',
    '}',
    '',
    'async function activeConfig(): Promise<BarrierConfig | null> {',
    '  let text: string',
    "  try { text = await readFile(join(stateDir, 'config.json'), 'utf8') } catch { return null }",
    '  let value: unknown',
    '  try { value = JSON.parse(text) } catch { return null }',
    "  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null",
    '  const candidate = value as RawBarrierConfig',
    '  const generation = candidate.generation',
    '  const filePath = candidate.filePath',
    '  const rawKinds = candidate.kinds',
    "  if (typeof generation !== 'number' || typeof filePath !== 'string' || !Array.isArray(rawKinds)) return null",
    '  const kinds = rawKinds.filter(isBarrierKind)',
    '  if (kinds.length !== rawKinds.length) return null',
    '  return { generation, filePath, kinds }',
    '}',
    '',
    'async function waitForBarrier(context: ParserContext): Promise<void> {',
    '  const config = await activeConfig()',
    '  if (!config) return',
    '  const isListParse = context.capturePrompts === false && context.onMessage === undefined',
    "  const kind: BarrierKind | undefined = isListParse ? 'list' : context.onMessage !== undefined ? 'index' : undefined",
    '  if (!kind || !config.kinds.includes(kind) || resolve(config.filePath) !== resolve(context.candidate.filePath)) return',
    '  const generation = config.generation',
    "  const blockedPath = join(stateDir, 'blocked-' + generation + '-' + kind)",
    "  const releasePath = join(stateDir, 'release-' + generation)",
    "  const closedPath = join(stateDir, 'closed-' + generation)",
    "  const settledPath = join(stateDir, 'settled-' + generation + '-' + kind)",
    "  await writeFile(blockedPath, '')",
    '  try {',
    `    const deadline = Date.now() + ${WAIT_TIMEOUT_MS}`,
    '    while (true) {',
    "      if (context.signal?.aborted) throw context.signal.reason ?? new Error('Scan cancelled')",
    '      if (await exists(closedPath)) throw new Error(\'scan barrier closed\')',
    '      if (await exists(releasePath)) return',
    "      if (Date.now() >= deadline) throw new Error('timed out waiting for scan barrier release: ' + kind)",
    '      const { promise, resolve: resume } = Promise.withResolvers<void>()',
    `      setTimeout(resume, ${WAIT_INTERVAL_MS})`,
    '      await promise',
    '    }',
    '  } finally {',
    "    await writeFile(settledPath, '')",
    '  }',
    '}',
    '',
    'export async function parsePrimary(context: ParserContext) {',
    '  await waitForBarrier(context)',
    '  return parseRealPrimary(context)',
    '}'
  ].join('\n')
}

export function installScanBarrier(home: string, pluginRoot: string): void {
  const stateDir = join(home, 'scan-barrier')
  mkdirSync(stateDir, { recursive: true })
  const scannerDir = join(pluginRoot, 'src', 'scanner')
  const scannerIndex = join(scannerDir, 'index.ts')
  renameSync(scannerIndex, join(scannerDir, 'index.real.ts'))
  writeFileSync(scannerIndex, scannerWrapper(stateDir))
  const parserDir = join(scannerDir, 'parsers')
  const primaryParser = join(parserDir, 'primary.ts')
  renameSync(primaryParser, join(parserDir, 'primary.real.ts'))
  writeFileSync(primaryParser, parserWrapper(stateDir))
}

export function createScanBarrier(home: string): ScanBarrier {
  const stateDir = join(home, 'scan-barrier')
  const configPath = join(stateDir, 'config.json')
  const listStartsPath = join(stateDir, 'list-starts.txt')
  let generation = 0
  let kinds: ScanBarrierKind[] = []
  let closed = false

  const pathFor = (prefix: string, activeGeneration = generation, kind?: ScanBarrierKind) => {
    const suffix = kind === undefined ? String(activeGeneration) : `${activeGeneration}-${kind}`
    return join(stateDir, `${prefix}-${suffix}`)
  }

  async function waitForSettled(activeGeneration: number, activeKinds: ScanBarrierKind[], timeoutMs: number): Promise<void> {
    const blockedKinds: ScanBarrierKind[] = []
    for (const kind of activeKinds) {
      if (await exists(pathFor('blocked', activeGeneration, kind))) blockedKinds.push(kind)
    }
    await Promise.all(blockedKinds.map(kind => waitForFile(
      pathFor('settled', activeGeneration, kind),
      `scan barrier ${kind} parser to settle`,
      timeoutMs
    )))
  }

  return {
    async arm(filePath, requestedKinds) {
      if (closed) throw new Error('scan barrier is closed')
      if (generation > 0) await waitForSettled(generation, kinds, WAIT_TIMEOUT_MS)
      generation++
      kinds = [...requestedKinds]
      await mkdir(stateDir, { recursive: true })
      const config: BarrierConfig = { generation, filePath: resolve(filePath), kinds }
      await writeFile(configPath, JSON.stringify(config))
    },
    async waitUntilBlocked(kind) {
      if (generation === 0 || !kinds.includes(kind)) throw new Error(`scan barrier is not armed for ${kind}`)
      await waitForFile(pathFor('blocked', generation, kind), `${kind} parser barrier`, WAIT_TIMEOUT_MS, pathFor('closed'))
    },
    async listStarts() {
      try {
        const contents = await readFile(listStartsPath, 'utf8')
        return contents.split('\n').filter(Boolean).length
      } catch (error) {
        if (isMissing(error)) return 0
        throw error
      }
    },
    async release() {
      if (generation === 0 || closed) return
      await writeFile(pathFor('release'), '')
      await waitForSettled(generation, kinds, WAIT_TIMEOUT_MS)
    },
    async close() {
      if (closed) return
      closed = true
      if (generation === 0) return
      await writeFile(pathFor('closed'), '')
      await waitForSettled(generation, kinds, CLEANUP_TIMEOUT_MS).catch(() => {})
    }
  }
}
