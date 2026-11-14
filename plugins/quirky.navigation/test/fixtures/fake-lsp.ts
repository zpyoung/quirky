import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MessageReader } from '../../src/framing'

const mode = process.argv[2] ?? ''
const root = process.cwd()
const pidPath = join(root, '.fake-lsp.pid')
writeFileSync(pidPath, String(process.pid))

const reader = new MessageReader()
let initialized = false
let initializationId: number | string | null | undefined
let initializationIsValid = false
let gotConfigurationReply = false
let gotRegistrationReply = false
let definitionCount = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function send(value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
}

function result(id: number | string | null, value: unknown): void {
  send({ jsonrpc: '2.0', id, result: value })
}

function failure(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function initializationResult(positionEncoding = 'utf-16'): unknown {
  return {
    capabilities: {
      positionEncoding,
      definitionProvider: true,
      referencesProvider: true,
    },
    serverInfo: { name: 'fake-lsp' },
  }
}

function validInitialization(params: unknown): boolean {
  if (!isRecord(params) || !Array.isArray(params.workspaceFolders) || !isRecord(params.capabilities)) return false
  const expectedUri = pathToFileURL(root).href
  const folders = params.workspaceFolders
  const capabilities = params.capabilities
  const general = capabilities.general
  return params.rootUri === expectedUri && folders.length === 1 && isRecord(folders[0]) &&
    folders[0].uri === expectedUri && isRecord(general) &&
    Array.isArray(general.positionEncodings) && general.positionEncodings.length === 1 &&
    general.positionEncodings[0] === 'utf-16'
}

function targetUri(sourceUri: string, name = 'target.py'): string {
  const sourcePath = fileURLToPath(sourceUri)
  return pathToFileURL(join(dirname(sourcePath), name)).href
}

function location(uri: string, line: number, character: number, endLine: number, endCharacter: number): unknown {
  return {
    uri,
    range: {
      start: { line, character },
      end: { line: endLine, character: endCharacter },
    },
  }
}

function validNavigationParams(method: string, params: unknown): boolean {
  if (!isRecord(params) || !isRecord(params.textDocument) || typeof params.textDocument.uri !== 'string' ||
    !isRecord(params.position)) return false
  const expectedUri = pathToFileURL(join(root, 'source.py')).href
  if (params.textDocument.uri !== expectedUri || params.position.line !== 4 || params.position.character !== 20) {
    return false
  }
  if (method === 'textDocument/references') {
    return isRecord(params.context) && params.context.includeDeclaration === true
  }
  return true
}

function finishInitialization(): void {
  if (initializationId === undefined) return
  if (!initializationIsValid) {
    failure(initializationId, -32602, 'bad initialize parameters')
  } else {
    result(initializationId, initializationResult())
  }
  initializationId = undefined
}

if (mode === 'die') {
  process.stderr.write('boom\n')
  process.exit(7)
}

async function handle(value: unknown): Promise<void> {
  if (!isRecord(value)) return
  if (typeof value.method === 'string') {
    const method = value.method
    process.stderr.write(`${method}\n`)
    const id = typeof value.id === 'number' || typeof value.id === 'string' || value.id === null
      ? value.id
      : undefined
    if (method === 'initialize') {
      if (mode === 'silent') return
      initializationIsValid = validInitialization(value.params)
      if (id === undefined) return
      if (mode === 'asks') {
        initializationId = id
        send({
          jsonrpc: '2.0',
          id: 'configuration',
          method: 'workspace/configuration',
          params: { items: [{ section: 'one' }, { section: 'two' }] },
        })
        send({
          jsonrpc: '2.0',
          id: 'registration',
          method: 'client/registerCapability',
          params: { registrations: [] },
        })
        return
      }
      if (mode === 'utf8') {
        if (!initializationIsValid) failure(id, -32602, 'bad initialize parameters')
        else result(id, initializationResult('utf-8'))
        return
      }
      if (!initializationIsValid) failure(id, -32602, 'bad initialize parameters')
      else result(id, initializationResult())
      return
    }
    if (method === 'initialized') {
      initialized = true
      return
    }
    if (method === 'textDocument/definition' || method === 'textDocument/references') {
      if (!initialized) {
        if (id !== undefined) failure(id, -32002, 'request before initialized')
        return
      }
      if (mode === 'normal' && !validNavigationParams(method, value.params)) {
        if (id !== undefined) failure(id, -32602, 'bad navigation parameters')
        return
      }
      if (mode === 'exit-on-request') process.exit(9)
      if (id === undefined) return
      if (mode === 'error' && definitionCount++ === 0) {
        failure(id, -32603, 'kaput')
        return
      }
      if (mode === 'shapes' && method === 'textDocument/definition') {
        const params = value.params as { textDocument: { uri: string } }
        const target = targetUri(params.textDocument.uri)
        const first = location(target, 3, 16, 3, 21)
        switch (definitionCount++) {
          case 0:
            result(id, first)
            return
          case 1:
            result(id, [first, location(targetUri(params.textDocument.uri, 'other.py'), 1, 2, 1, 4)])
            return
          case 2:
            result(id, [{
              targetUri: target,
              targetRange: {
                start: { line: 1, character: 1 },
                end: { line: 1, character: 8 },
              },
              targetSelectionRange: {
                start: { line: 5, character: 2 },
                end: { line: 5, character: 6 },
              },
            }])
            return
          case 3:
            result(id, null)
            return
          default:
            result(id, [first, location('untitled:x', 0, 0, 0, 1)])
            return
        }
      }
      if (method === 'textDocument/references') {
        result(id, [])
        return
      }
      const params = value.params as { textDocument: { uri: string } }
      result(id, location(targetUri(params.textDocument.uri), 3, 16, 3, 21))
      return
    }
    if (method === 'shutdown') {
      if (mode !== 'stubborn' && id !== undefined) result(id, null)
      return
    }
    if (method === 'exit') {
      if (mode !== 'stubborn') process.exit(0)
    }
    return
  }

  if (value.id === 'configuration') {
    gotConfigurationReply = Array.isArray(value.result) && value.result.length === 2 &&
      value.result.every((item) => item === null)
  } else if (value.id === 'registration') {
    gotRegistrationReply = value.result === null
  }
  if (mode === 'asks' && initializationId !== undefined && gotConfigurationReply && gotRegistrationReply) {
    finishInitialization()
  }
}

for await (const chunk of process.stdin) {
  for (const message of reader.push(chunk)) await handle(message)
}

if (mode === 'stubborn') setInterval(() => {}, 60_000)
