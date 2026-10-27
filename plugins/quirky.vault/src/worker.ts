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

const pendingLists = new Map<string, AbortController>()
let scanner: VaultScanner | undefined
let search: VaultSearch | undefined
let initializing: Promise<void> | undefined
let closed = false

const post = (value: WorkerResponse | { event: 'scanProgress' | 'searchStatus'; data: ScanProgress | SearchStatus }) => self.postMessage(value)

function initialize(dataDir: string): Promise<void> {
  if (initializing) return initializing
  initializing = Promise.resolve().then(() => {
    const env: Record<string, string | undefined> = { ...process.env }
    scanner = createScanner({
      sourceHome: env.QUIRKY_VAULT_SOURCE_HOME || process.env.HOME || '/',
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

async function handle(request: WorkerRequest): Promise<unknown> {
  const args = request.args
  if (request.op === 'cancelList') {
    const token = args.requestToken
    if (typeof token !== 'string') return { cancelled: false }
    const controller = pendingLists.get(token)
    controller?.abort()
    return { cancelled: controller !== undefined }
  }
  if (request.op === 'close') {
    closed = true
    for (const controller of pendingLists.values()) controller.abort()
    pendingLists.clear()
    await search?.close()
    await scanner?.close()
    return { closed: true }
  }
  if (closed) throw new Error('vault worker is closed')

  const dataDir = args.dataDir
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('dataDir is required')
  await initialize(dataDir)
  const activeScanner = required(scanner, 'scanner')
  const activeSearch = required(search, 'search index')

  switch (request.op) {
    case 'list': {
      const listRequest = args.request as ListRequest
      const token = listRequest.requestToken ?? String(request.id)
      const controller = new AbortController()
      pendingLists.set(token, controller)
      try {
        return await activeScanner.list(listRequest, controller.signal)
      } finally {
        if (pendingLists.get(token) === controller) pendingLists.delete(token)
      }
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
