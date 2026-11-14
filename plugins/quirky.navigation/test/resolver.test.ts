import { afterEach, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createProcessRunner, type OwnedProcessRunner, type ProcessSpawner, type SpawnOptions, type SpawnedProcess } from '../../../packages/process/src/api'
import { MessageReader } from '../src/framing'
import { startLspServer } from '../src/lsp-client'
import type { NavigationServer, ServerLocation } from '../src/servers'

const python = Bun.which('python3')
const resolverPath = join(import.meta.dir, '..', 'assets', 'resolver.py')
const temporaryRoots: string[] = []
const runners: OwnedProcessRunner[] = []
const servers: NavigationServer[] = []

function workspace(): { root: string; home: string } {
  const temporary = mkdtempSync(join(tmpdir(), 'nav py é-'))
  temporaryRoots.push(temporary)
  const root = join(temporary, 'workspace')
  const home = join(temporary, 'home')
  mkdirSync(home, { recursive: true })
  cpSync(join(import.meta.dir, 'fixtures/py'), root, { recursive: true })
  return { root: realpathSync(root), home }
}

function runner(home: string): ProcessSpawner {
  const real = createProcessRunner({ owner: 'quirky.navigation.resolver.test' })
  runners.push(real)
  return {
    spawn(argv: readonly string[], options: SpawnOptions): SpawnedProcess {
      const freshHome = mkdtempSync(join(home, 'spawn-home-'))
      return real.spawn(argv, { ...options, env: { ...globalThis.process.env, HOME: freshHome, QUIRKY_HOME: freshHome } })
    }
  }
}

async function start(root: string, home: string) {
  if (!python) throw new Error('python3 is required for resolver tests')
  const server = await startLspServer({
    process: runner(home),
    argv: [python, '-I', resolverPath],
    root,
    runtime: python,
    serverPath: resolverPath
  })
  servers.push(server)
  return server
}

function positions(root: string, locations: ServerLocation[]) {
  return locations.map(({ path, line, column, endLine, endColumn }) => [
    relative(root, path).split(sep).join('/'), line, column, endLine, endColumn
  ])
}

function sortedPositions(root: string, locations: ServerLocation[]) {
  return positions(root, locations).sort((a, b) => {
    const pathOrder = String(a[0]).localeCompare(String(b[0]))
    return pathOrder || Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2])
  })
}

function edgeFiles(root: string): void {
  const edge = [
    'from pkg.mod import (  # greet here is a comment',
    '    Greeter as G,',
    '    greet,',
    ')',
    'import pkg',
    '',
    '',
    'def deco(fn):',
    '    return fn',
    '',
    '',
    'class Loud(G):',
    '    @deco',
    '    def shout(self):',
    '        return f"{self.hello(\'x\')} {greet(\'y\')}"',
    '',
    '',
    'def make() -> G:',
    '    return G("a")',
    '',
    '',
    'count = 0',
    '',
    '',
    'def bump():',
    '    global count',
    '    count = count + 1',
    '    return [count for count in range(3)]',
    '',
    '',
    'make().hello("b")',
    'Loud("c").hello("d")',
    'pkg.mod.greet("e")',
    '(w := Loud("z")).shout()'
  ].join('\n') + '\n'
  writeFileSync(join(root, 'edge.py'), edge, 'utf8')
  writeFileSync(join(root, 'crlf.py'), Buffer.from('from pkg.mod import greet\r\nx = "é"; greet(x)\r\n', 'utf8'))
  writeFileSync(join(root, 'cr.py'), Buffer.from('from pkg.mod import greet\rgreet(1)\r', 'utf8'))
  writeFileSync(join(root, 'bom.py'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('greet = 1\ngreet\n', 'utf8')]))
  writeFileSync(join(root, 'latin.py'), Buffer.concat([
    Buffer.from('# -*- coding: latin-1 -*-\nfrom pkg.mod import greet\nx = "', 'ascii'),
    Buffer.from([0xe9]),
    Buffer.from('"; greet(x)\n', 'ascii')
  ]))
  writeFileSync(join(root, 'ls.py'), Buffer.from('s = "a\u2028b"\nfrom pkg.mod import greet\ngreet(s)\n', 'utf8'))
  writeFileSync(join(root, 'broken.py'), Buffer.from('from pkg.mod import greet\ngreet(\n', 'utf8'))
  for (const directory of ['.venv', 'node_modules', 'env2/lib']) {
    mkdirSync(join(root, directory), { recursive: true })
    writeFileSync(join(root, directory, 'a.py'), 'from pkg import greet\ngreet("v")\n')
  }
  writeFileSync(join(root, 'env2/pyvenv.cfg'), '')
  symlinkSync('crlf.py', join(root, 'linked.py'))
}

type JsonRpcMessage = { id?: number | null; method?: string; result?: unknown; error?: { code: number; message: string } }
type RawClient = {
  process: SpawnedProcess
  send(body: string): Promise<boolean>
  sendBytes(bytes: Uint8Array): Promise<boolean>
  next(): Promise<JsonRpcMessage>
}

function frame(body: string): Uint8Array {
  const bytes = Buffer.from(body, 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`, 'ascii'), bytes])
}

function rawProcess(root: string, home: string) {
  if (!python) throw new Error('python3 is required for resolver tests')
  const process = runner(home).spawn([python, '-I', resolverPath], {
    cwd: root, timeoutMs: null, stdin: 'pipe', stdout: 'pipe', stderr: 'tail'
  })
  const reader = new MessageReader()
  const messages: JsonRpcMessage[] = []
  const waiters: Array<(message: JsonRpcMessage) => void> = []
  void (async () => {
    const stream = process.stdout.getReader()
    try {
      while (true) {
        const next = await stream.read()
        if (next.done) break
        for (const message of reader.push(next.value)) {
          const value = message as JsonRpcMessage
          const waiter = waiters.shift()
          if (waiter) waiter(value)
          else messages.push(value)
        }
      }
    } catch {
      // Process exit is observed through its own completion promise.
    }
  })()
  return {
    process,
    send(body: string) { return process.write(frame(body)) },
    sendBytes(bytes: Uint8Array) { return process.write(bytes) },
    next(): Promise<JsonRpcMessage> {
      const queued = messages.shift()
      if (queued) return Promise.resolve(queued)
      // Bound protocol waits because a broken child can remain alive without answering.
      const { promise, resolve, reject } = Promise.withResolvers<JsonRpcMessage>()
      const timer = setTimeout(() => reject(new Error('timed out waiting for resolver message')), 5000)
      waiters.push((message) => { clearTimeout(timer); resolve(message) })
      return promise
    }
  }
}

async function initializeRaw(client: RawClient, root: string) {
  await client.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: pathToFileURL(root).href } }))
  const response = await client.next()
  await client.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }))
  return response
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()))
  await Promise.allSettled(runners.splice(0).map((item) => item.dispose()))
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('1-10: definitions resolve imports, re-exports, attributes, modules, shadowing and empty positions', async () => {
  const { root, home } = workspace()
  const server = await start(root, home)
  const def = (path: string, line: number, column: number) => server.definition(join(root, path), line, column)
  const greet = [['pkg/mod.py', 4, 5, 4, 10]]
  const greeter = [['pkg/mod.py', 8, 7, 8, 14]]
  const hello = [['pkg/mod.py', 12, 9, 12, 14]]

  expect(positions(root, await def('main.py', 5, 21))).toEqual(greet)
  expect(positions(root, await def('main.py', 2, 17))).toEqual(greet)
  expect(positions(root, await def('pkg/__init__.py', 1, 18))).toEqual(greet)
  expect(positions(root, await def('main.py', 3, 21))).toEqual(greeter)
  expect(positions(root, await def('main.py', 7, 9))).toEqual(hello)
  expect(positions(root, await def('main.py', 8, 9))).toEqual(greet)
  expect(positions(root, await def('main.py', 8, 39))).toEqual(hello)
  for (const [line, column, expected] of [
    [8, 7, ['pkg/mod.py', 1, 1, 1, 1]],
    [1, 19, ['pkg/mod.py', 1, 1, 1, 1]],
    [1, 12, ['pkg/mod.py', 1, 1, 1, 1]],
    [1, 8, ['pkg/__init__.py', 1, 1, 1, 1]]
  ] as const) expect(positions(root, await def('main.py', line, column))).toEqual([[...expected]])
  expect(positions(root, await def('pkg/mod.py', 16, 21))).toEqual(hello)
  expect(positions(root, await def('pkg/mod.py', 16, 40))).toEqual(hello)
  expect(positions(root, await def('pkg/mod.py', 13, 21))).toEqual([['pkg/mod.py', 10, 14, 10, 20]])
  expect(positions(root, await def('pkg/mod.py', 5, 12))).toEqual([['pkg/mod.py', 1, 1, 1, 9]])
  const shadowed = [['main.py', 11, 9, 11, 14]]
  expect(positions(root, await def('main.py', 12, 12))).toEqual(shadowed)
  expect(positions(root, await def('main.py', 11, 9))).toEqual(shadowed)
  for (const [path, line, column] of [['main.py', 4, 1], ['main.py', 8, 1], ['main.py', 5, 12]] as const) {
    expect(await def(path, line, column)).toEqual([])
  }
}, 60000)

test('11-16: references stay within symbols and include declarations', async () => {
  const { root, home } = workspace()
  const server = await start(root, home)
  const refs = (path: string, line: number, column: number) => server.references(join(root, path), line, column)

  expect(sortedPositions(root, await refs('main.py', 5, 21))).toEqual([
    ['main.py', 2, 17, 2, 22], ['main.py', 5, 21, 5, 26], ['main.py', 8, 9, 8, 14],
    ['pkg/__init__.py', 1, 18, 1, 23], ['pkg/mod.py', 4, 5, 4, 10], ['pkg/mod.py', 13, 36, 13, 41]
  ])
  expect(sortedPositions(root, await refs('pkg/mod.py', 12, 9))).toEqual([
    ['main.py', 7, 9, 7, 14], ['main.py', 8, 39, 8, 44], ['pkg/mod.py', 12, 9, 12, 14],
    ['pkg/mod.py', 16, 21, 16, 26], ['pkg/mod.py', 16, 40, 16, 45]
  ])
  expect(sortedPositions(root, await refs('main.py', 3, 21))).toEqual([
    ['main.py', 3, 21, 3, 28], ['main.py', 6, 11, 6, 18], ['main.py', 8, 25, 8, 32],
    ['pkg/mod.py', 8, 7, 8, 14]
  ])
  expect(sortedPositions(root, await refs('pkg/mod.py', 10, 14))).toEqual([
    ['pkg/mod.py', 10, 14, 10, 20], ['pkg/mod.py', 13, 21, 13, 27]
  ])
  expect(sortedPositions(root, await refs('main.py', 11, 9))).toEqual([
    ['main.py', 11, 9, 11, 14], ['main.py', 12, 12, 12, 17]
  ])
  expect(sortedPositions(root, await refs('pkg/mod.py', 1, 1))).toEqual([
    ['pkg/mod.py', 1, 1, 1, 9], ['pkg/mod.py', 5, 12, 5, 20]
  ])
}, 60000)

test('17: resolves Python aliases, f-strings, inheritance, annotations, walrus and lexical scopes', async () => {
  const { root, home } = workspace()
  edgeFiles(root)
  const server = await start(root, home)
  const def = (line: number, column: number) => server.definition(join(root, 'edge.py'), line, column)

  expect(positions(root, await def(2, 5))).toEqual([['pkg/mod.py', 8, 7, 8, 14]])
  expect(positions(root, await def(2, 16))).toEqual([['pkg/mod.py', 8, 7, 8, 14]])
  expect(positions(root, await def(15, 24))).toEqual([['pkg/mod.py', 12, 9, 12, 14]])
  expect(positions(root, await def(15, 37))).toEqual([['pkg/mod.py', 4, 5, 4, 10]])
  expect(positions(root, await def(31, 8))).toEqual([['pkg/mod.py', 12, 9, 12, 14]])
  expect(positions(root, await def(32, 11))).toEqual([['pkg/mod.py', 12, 9, 12, 14]])
  expect(positions(root, await def(34, 19))).toEqual([['edge.py', 14, 9, 14, 14]])
  expect(positions(root, await def(27, 8))).toEqual([
    ['edge.py', 22, 1, 22, 6], ['edge.py', 27, 5, 27, 10]
  ])
  expect(positions(root, await def(28, 14))).toEqual([['edge.py', 28, 23, 28, 28]])
  expect(await def(1, 30)).toEqual([])
}, 60000)

test('resolves imports in local, nested, class, global and nonlocal binding scopes', async () => {
  const { root, home } = workspace()
  const file = 'scope-imports.py'
  const source = [
    'def local_import():',
    '    from pkg.mod import greet as local_greet',
    '    return local_greet("local")',
    'local_greet("module")',
    '',
    'def outer_import():',
    '    def inner_import():',
    '        from pkg.mod import greet as nested_greet',
    '        return nested_greet("nested")',
    '    return inner_import()',
    'nested_greet("module")',
    '',
    'class C:',
    '    from pkg.mod import greet',
    '',
    'greet("module")',
    'C.greet("class")',
    '',
    'def global_import():',
    '    global global_greet',
    '    from pkg.mod import greet as global_greet',
    '    return global_greet("global")',
    '',
    'global_greet("outside")',
    '',
    'def outer_nonlocal():',
    '    nonlocal_greet = None',
    '    def inner_nonlocal():',
    '        nonlocal nonlocal_greet',
    '        from pkg.mod import greet as nonlocal_greet',
    '        return nonlocal_greet("nonlocal")',
    '    return inner_nonlocal()'
  ].join('\n') + '\n'
  writeFileSync(join(root, file), source, 'utf8')
  const server = await start(root, home)
  const def = (line: number, column: number) => server.definition(join(root, file), line, column)
  const refs = (line: number, column: number) => server.references(join(root, file), line, column)
  const inFile = async (line: number, column: number) =>
    positions(root, await refs(line, column)).filter(([candidate]) => candidate === file)
  const greet = [['pkg/mod.py', 4, 5, 4, 10]]

  expect(positions(root, await def(3, 12))).toEqual(greet)
  expect(positions(root, await def(9, 16))).toEqual(greet)
  expect(positions(root, await def(17, 3))).toEqual(greet)
  expect(positions(root, await def(22, 12))).toEqual(greet)
  expect(positions(root, await def(31, 16))).toEqual(greet)
  expect(await def(4, 1)).toEqual([])
  expect(await def(11, 1)).toEqual([])
  expect(await def(16, 1)).toEqual([])

  expect(await inFile(3, 12)).toEqual([
    [file, 2, 34, 2, 45], [file, 3, 12, 3, 23]
  ])
  expect(await inFile(9, 16)).toEqual([
    [file, 8, 38, 8, 50], [file, 9, 16, 9, 28]
  ])
  expect(await inFile(17, 3)).toEqual([
    [file, 2, 25, 2, 30], [file, 8, 29, 8, 34],
    [file, 14, 25, 14, 30], [file, 17, 3, 17, 8],
    [file, 21, 25, 21, 30], [file, 30, 29, 30, 34]
  ])
  expect(await inFile(24, 1)).toEqual([
    [file, 20, 12, 20, 24], [file, 21, 34, 21, 46],
    [file, 22, 12, 22, 24], [file, 24, 1, 24, 13]
  ])
  expect(await inFile(31, 16)).toEqual([
    [file, 27, 5, 27, 19], [file, 29, 18, 29, 32],
    [file, 30, 38, 30, 52], [file, 31, 16, 31, 30]
  ])
}, 60000)

test('annotated parameters resolve their exact identifiers and UTF-16 references', async () => {
  const { root, home } = workspace()
  const file = join(root, 'annotated.py')
  const source = [
    'def annotated(',
    '    é: str,',
    '    positional_only: str,',
    '    /,',
    '    positional: str,',
    '    *variadic: str,',
    '    keyword_only: str,',
    '    **keywords: str,',
    ') -> str:',
    '    return "é🙂" + str(é) + positional_only + positional + variadic[0] + keyword_only + keywords["x"]'
  ].join('\n') + '\n'
  writeFileSync(file, source, 'utf8')
  const server = await start(root, home)

  for (const [name, declarationLine, declarationColumn, declarationEnd, useColumn] of [
    ['é', 2, 5, 6, 24],
    ['positional_only', 3, 5, 20, 29],
    ['positional', 5, 5, 15, 47],
    ['variadic', 6, 6, 14, 60],
    ['keyword_only', 7, 5, 17, 74],
    ['keywords', 8, 7, 15, 89]
  ] as const) {
    const declaration = ['annotated.py', declarationLine, declarationColumn, declarationLine, declarationEnd]
    const use = ['annotated.py', 10, useColumn, 10, useColumn + name.length]
    expect(positions(root, await server.definition(file, 10, useColumn))).toEqual([declaration])
    expect(positions(root, await server.definition(file, declarationLine, declarationColumn))).toEqual([declaration])
    expect(positions(root, await server.references(file, 10, useColumn))).toEqual([declaration, use])
  }
}, 60000)

test('18-19: honors source encodings and Python line endings and skips syntax errors', async () => {
  const { root, home } = workspace()
  edgeFiles(root)
  const server = await start(root, home)
  const greet = [['pkg/mod.py', 4, 5, 4, 10]]

  for (const [path, line, column] of [
    ['crlf.py', 2, 12], ['cr.py', 2, 1], ['latin.py', 3, 10], ['ls.py', 3, 1]
  ] as const) expect(positions(root, await server.definition(join(root, path), line, column))).toEqual(greet)
  expect(positions(root, await server.definition(join(root, 'bom.py'), 2, 1))).toEqual([['bom.py', 1, 1, 1, 6]])
  expect(await server.definition(join(root, 'broken.py'), 2, 1)).toEqual([])
}, 60000)

test('20: references sweep eligible source files only and ignore symlinks, virtual environments and comments', async () => {
  const { root, home } = workspace()
  edgeFiles(root)
  const server = await start(root, home)

  expect(sortedPositions(root, await server.references(join(root, 'pkg/mod.py'), 4, 5))).toEqual([
    ['cr.py', 1, 21, 1, 26], ['cr.py', 2, 1, 2, 6],
    ['crlf.py', 1, 21, 1, 26], ['crlf.py', 2, 10, 2, 15],
    ['edge.py', 3, 5, 3, 10], ['edge.py', 15, 37, 15, 42], ['edge.py', 33, 9, 33, 14],
    ['latin.py', 2, 21, 2, 26], ['latin.py', 3, 10, 3, 15],
    ['ls.py', 2, 21, 2, 26], ['ls.py', 3, 1, 3, 6],
    ['main.py', 2, 17, 2, 22], ['main.py', 5, 21, 5, 26], ['main.py', 8, 9, 8, 14],
    ['pkg/__init__.py', 1, 18, 1, 23], ['pkg/mod.py', 4, 5, 4, 10], ['pkg/mod.py', 13, 36, 13, 41]
  ])
}, 60000)

test('21: refreshes changed imports and definitions from disk on the same server', async () => {
  const { root, home } = workspace()
  const server = await start(root, home)
  const firstPid = server.pid

  expect(positions(root, await server.definition(join(root, 'main.py'), 5, 21))).toEqual([['pkg/mod.py', 4, 5, 4, 10]])
  expect(positions(root, await server.definition(join(root, 'main.py'), 7, 9))).toEqual([['pkg/mod.py', 12, 9, 12, 14]])
  writeFileSync(join(root, 'pkg/mod.py'), '\n\n' + readFileSync(join(root, 'pkg/mod.py'), 'utf8'))
  expect(server.pid).toBe(firstPid)
  expect(positions(root, await server.definition(join(root, 'main.py'), 5, 21))).toEqual([['pkg/mod.py', 6, 5, 6, 10]])
  expect(positions(root, await server.definition(join(root, 'main.py'), 7, 9))).toEqual([['pkg/mod.py', 14, 9, 14, 14]])
}, 60000)

test('decodes file URIs once for literal percent escapes in roots and source names', async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'nav py é-')))
  temporaryRoots.push(temporary)
  const root = join(temporary, 'workspace %20 py é')
  const decodedRoot = join(temporary, 'workspace   py é')
  const home = join(temporary, 'home')
  const source = join(root, 'literal%20name.py')
  mkdirSync(root, { recursive: true })
  mkdirSync(decodedRoot, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(source, 'def selected():\n    return "actual"\nselected()\n', 'utf8')
  writeFileSync(join(root, 'literal name.py'),
    '# source-name decoy\n\ndef selected():\n    return "space filename"\nselected()\n', 'utf8')
  writeFileSync(join(decodedRoot, 'literal name.py'),
    '# root and source decoy\n\n\ndef selected():\n    return "decoded root"\nselected()\n', 'utf8')
  const server = await start(root, home)

  expect(pathToFileURL(root).href).toContain('workspace%20%2520%20py%20%C3%A9')
  expect(pathToFileURL(source).href).toContain('literal%2520name.py')
  expect(positions(root, await server.definition(source, 3, 1))).toEqual([
    ['literal%20name.py', 1, 5, 1, 13]
  ])
  expect(positions(root, await server.references(source, 1, 5))).toEqual([
    ['literal%20name.py', 1, 5, 1, 13], ['literal%20name.py', 3, 1, 3, 9]
  ])
}, 60000)

test('22: returns references from hundreds of generated modules', async () => {
  const { root, home } = workspace()
  for (let index = 0; index < 400; index++) {
    const number = String(index).padStart(3, '0')
    const directory = join(root, 'gen')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `m${number}.py`), `from pkg import greet\n\n\ndef f${index}():\n    return greet("${index}")\n`)
  }
  const server = await start(root, home)

  expect((await server.references(join(root, 'pkg/mod.py'), 4, 5)).length).toBe(806)
}, 60000)

test('23: initializes with UTF-16 capabilities and both providers', async () => {
  const { root, home } = workspace()
  const client = rawProcess(root, home)
  const response = await initializeRaw(client, root)

  expect(response).toMatchObject({
    jsonrpc: '2.0', id: 1,
    result: {
      capabilities: { positionEncoding: 'utf-16', definitionProvider: true, referencesProvider: true },
      serverInfo: { name: 'quirky-python-resolver' }
    }
  })
}, 15000)

test('24: reports protocol errors, recovers after malformed JSON and ignores notifications', async () => {
  const { root, home } = workspace()
  const client = rawProcess(root, home)

  await client.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'textDocument/definition', params: {} }))
  expect(await client.next()).toMatchObject({ id: 1, error: { code: -32002 } })
  await initializeRaw(client, root)
  await client.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'textDocument/hover', params: {} }))
  expect(await client.next()).toMatchObject({ id: 2, error: { code: -32601 } })
  await client.sendBytes(Buffer.from('Content-Length: 4\r\n\r\nnope', 'ascii'))
  expect(await client.next()).toMatchObject({ id: null, error: { code: -32700 } })
  await client.send(JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {} }))
  await client.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'textDocument/definition', params: {
    textDocument: { uri: pathToFileURL(join(root, 'main.py')).href }, position: { line: 4, character: 20 }
  } }))
  expect(await client.next()).toMatchObject({ id: 3, result: [{ uri: pathToFileURL(join(root, 'pkg/mod.py')).href }] })
}, 15000)

test('25: enforces shutdown and exit status and closes cleanly on stdin EOF', async () => {
  const { root, home } = workspace()
  const normal = rawProcess(root, home)
  await initializeRaw(normal, root)
  await normal.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null }))
  expect(await normal.next()).toMatchObject({ id: 2, result: null })
  await normal.send(JSON.stringify({ jsonrpc: '2.0', method: 'exit', params: null }))
  expect((await normal.process.exited).exitCode).toBe(0)

  const unclean = rawProcess(root, home)
  await initializeRaw(unclean, root)
  await unclean.send(JSON.stringify({ jsonrpc: '2.0', method: 'exit', params: null }))
  expect((await unclean.process.exited).exitCode).toBe(1)

  const eof = rawProcess(root, home)
  await eof.process.closeInput()
  expect((await eof.process.exited).exitCode).toBe(0)
}, 15000)

test('26: parses the resolver using Python 3.8 grammar', async () => {
  const { root, home } = workspace()
  if (!python) throw new Error('python3 is required for resolver tests')
  const child = runner(home).spawn([python, '-I', '-c',
    'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), feature_version=(3, 8))', resolverPath
  ], { cwd: root, timeoutMs: 30000, stdin: 'ignore', stdout: 'pipe', stderr: 'tail' })
  const stdout = await new Response(child.stdout).text()
  const exit = await child.exited
  expect(exit.exitCode).toBe(0)
  expect(stdout).toBe('')
}, 40000)
