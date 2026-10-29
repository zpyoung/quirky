import { createScanner } from './scanner/index'
import { createSearch } from './search/index'
import type {
  ListRequest,
  ScanProgress,
  SearchOptions,
  SearchPolicy,
  SearchRequest,
  SearchStatus,
  VaultScanner,
  VaultSearch,
  WorkerRequest,
  WorkerResponse
} from './types'

type SharedList = {
  key: string
  controller: AbortController
  callers: Set<ListCaller>
  promise: Promise<unknown>
}
type ListCaller = {
  token: string
  scan: SharedList
  resolve(value: unknown): void
  reject(error: unknown): void
  active: boolean
}

const pendingLists = new Map<string, ListCaller>()
const sharedLists = new Map<string, SharedList>()
let scanner: VaultScanner | undefined
let search: VaultSearch | undefined
let initializing: Promise<void> | undefined
let closed = false

const post = (value: WorkerResponse | { event: 'scanProgress' | 'searchStatus'; data: ScanProgress | SearchStatus }) => self.postMessage(value)

function workerEnvironment(value: unknown): Record<string, string | undefined> {
  if (value === undefined) return { ...process.env }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('vault worker environment is malformed')
  const environment: Record<string, string | undefined> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') environment[name] = entry
  }
  return environment
}

function initialize(dataDir: string, environmentValue: unknown): Promise<void> {
  if (initializing) return initializing
  const env = workerEnvironment(environmentValue)
  initializing = Promise.resolve().then(() => {
    scanner = createScanner({
      sourceHome: env.QUIRKY_VAULT_SOURCE_HOME || env.HOME || '/',
      dataDir,
      env,
      progress: (value) => post({ event: 'scanProgress', data: value })
    })
    const options: SearchOptions = {
      dataDir,
      scanner,
      progress: (status) => post({ event: 'searchStatus', data: status })
    }
    search = createSearch(options)
  }).catch((error: unknown) => {
    initializing = undefined
    throw error
  })
  return initializing
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`vault worker has no ${name}`)
  return value
}

function listKey(dataDir: string, request: ListRequest): string {
  // A request token identifies one caller, not the scan shared by equivalent callers.
  return JSON.stringify([
    dataDir,
    request.agents ?? null,
    request.scopePaths ?? null,
    request.limit ?? null,
    request.unlimited ?? null,
    request.force ?? null,
    request.sort ?? null,
    request.hideEmpty ?? null
  ])
}

function settleListCaller(caller: ListCaller, finish: () => void): void {
  if (!caller.active) return
  caller.active = false
  caller.scan.callers.delete(caller)
  if (pendingLists.get(caller.token) === caller) pendingLists.delete(caller.token)
  finish()
}

function cancelList(token: string): boolean {
  const caller = pendingLists.get(token)
  if (!caller) return false
  settleListCaller(caller, () => caller.reject(new Error('Scan cancelled')))
  if (caller.scan.callers.size === 0) {
    if (sharedLists.get(caller.scan.key) === caller.scan) sharedLists.delete(caller.scan.key)
    caller.scan.controller.abort()
  }
  return true
}

function joinList(scan: SharedList, token: string): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  const caller: ListCaller = { token, scan, resolve, reject, active: true }
  scan.callers.add(caller)
  pendingLists.set(token, caller)
  scan.promise.then(
    (result) => settleListCaller(caller, () => resolve(result)),
    (error: unknown) => settleListCaller(caller, () => reject(error))
  )
  return promise
}

function listForCall(scanner: VaultScanner, dataDir: string, request: ListRequest, token: string): Promise<unknown> {
  const key = listKey(dataDir, request)
  let scan = sharedLists.get(key)
  if (!scan) {
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => scanner.list(request, controller.signal))
    scan = { key, controller, callers: new Set(), promise }
    sharedLists.set(key, scan)
    const startedScan = scan
    void promise.then(
      () => { if (sharedLists.get(key) === startedScan) sharedLists.delete(key) },
      () => { if (sharedLists.get(key) === startedScan) sharedLists.delete(key) }
    )
  }
  return joinList(scan, token)
}

async function handle(request: WorkerRequest): Promise<unknown> {
  const args = request.args
  if (request.op === 'cancelList') {
    const token = args.requestToken
    if (typeof token !== 'string') return { cancelled: false }
    return { cancelled: cancelList(token) }
  }
  if (request.op === 'close') {
    closed = true
    for (const scan of sharedLists.values()) scan.controller.abort()
    pendingLists.clear()
    sharedLists.clear()
    await search?.close()
    await scanner?.close()
    return { closed: true }
  }
  if (closed) throw new Error('vault worker is closed')

  const dataDir = args.dataDir
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('dataDir is required')
  await initialize(dataDir, args.environment)
  const activeScanner = required(scanner, 'scanner')
  const activeSearch = required(search, 'search index')

  switch (request.op) {
    case 'list': {
      const listRequest = args.request as ListRequest
      const token = listRequest.requestToken ?? String(request.id)
      return listForCall(activeScanner, dataDir, listRequest, token)
    }
    case 'get':
      return activeScanner.get(String(args.id))
    case 'firstPrompt':
      return activeScanner.firstPrompt(String(args.id))
    case 'subagents':
      return activeScanner.subagents(String(args.id))
    case 'deleteTargets':
      return activeScanner.deleteTargets(String(args.id))
    case 'invalidate':
      activeScanner.invalidate(String(args.id))
      await activeSearch.remove(String(args.id))
      return { invalidated: true }
    case 'search':
      return activeSearch.search(args.request as SearchRequest)
    case 'searchStatus':
      return activeSearch.status()
    case 'applySearch':
      await activeSearch.apply(args.policy as SearchPolicy)
      return activeSearch.status()
    case 'clearSearchIndex':
      await activeSearch.clear()
      return activeSearch.status()
    default:
      throw new Error(`unknown vault worker operation '${request.op}'`)
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (typeof request !== 'object' || request === null || typeof request.id !== 'number' || typeof request.op !== 'string') return
  void handle(request).then(
    (result) => post({ id: request.id, result }),
    (error: unknown) => post({
      id: request.id,
      error: {
        kind: error instanceof Error && 'kind' in error && typeof error.kind === 'string' ? error.kind : 'worker-error',
        message: error instanceof Error ? error.message : String(error)
      }
    })
  )
})
