import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createProcessScope, type ProcessScope } from './test-support/process-scope'

const processScopeModule = new URL('./test-support/process-scope.ts', import.meta.url).href
const homes = new Set<string>()
const scopes: ProcessScope[] = []
const sentinels: { child: IsolatedSubprocess; identity?: ProcessIdentity }[] = []

type ProcessIdentity = { pid: number; started: string; command: string }
type IsolatedSubprocess = Bun.Subprocess<'ignore', 'ignore', 'ignore'>
type DetachedSpawnOptions = Bun.SpawnOptions.OptionsObject<'ignore', 'ignore', 'ignore'> & { detached: true }

function spawnDetached(command: string[], options: DetachedSpawnOptions): IsolatedSubprocess {
  const { detached, ...nativeOptions } = options
  const bunOptions: Bun.SpawnOptions.OptionsObject<'ignore', 'ignore', 'ignore'> = nativeOptions
  Object.assign(bunOptions, { detached })
  return Bun.spawn(command, bunOptions)
}

function processTable(): Map<number, ProcessIdentity> {
  const result = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=,pgid=,lstart=,command='])
  if (result.exitCode !== 0) return new Map()
  const rows = new Map<number, ProcessIdentity>()
  for (const line of result.stdout.toString().split('\n')) {
    const columns = line.trim().split(/\s+/)
    const pid = Number(columns[0])
    if (!Number.isInteger(pid) || columns.length < 9) continue
    rows.set(pid, { pid, started: columns.slice(3, 8).join(' '), command: columns.slice(8).join(' ') })
  }
  return rows
}

function sameProcess(left: ProcessIdentity | undefined, right: ProcessIdentity | undefined): boolean {
  return !!left && !!right && left.pid === right.pid && left.started === right.started && left.command === right.command
}

async function waitForProcess(pid: number): Promise<ProcessIdentity> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const identity = processTable().get(pid)
    if (identity) return identity
    await Bun.sleep(20)
  }
  throw new Error(`process ${pid} did not appear in ps`)
}

async function waitForHomeProcessesGone(home: string, pids: number[] = []): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const rows = processTable()
    const remaining = pids.some((pid) => rows.get(pid)?.command.includes(home)) || [...rows.values()].some((row) => row.command.includes(home))
    if (!remaining) return
    await Bun.sleep(20)
  }
  const remaining = [...processTable().values()].filter((row) => row.command.includes(home)).map((row) => `${row.pid} ${row.command}`)
  throw new Error(`processes still mention owned home ${home}: ${remaining.join('; ')}`)
}

function killHomeProcesses(home: string): void {
  // Test-only backstop: kill only processes whose argv includes this unique temp home, after
  // re-reading their start time and command so a recycled PID or unrelated process is untouched.
  for (const row of processTable().values()) {
    if (!row.command.includes(home) || row.pid === process.pid) continue
    if (!sameProcess(row, processTable().get(row.pid))) continue
    try {
      process.kill(row.pid, 'SIGKILL')
    } catch {
      // The process may have exited between the identity check and signal.
    }
  }
}


function leafProgram(home: string, manifest: string, ready: string): string {
  return `
    const fs = await import('node:fs')
    const home = ${JSON.stringify(home)}
    fs.appendFileSync(${JSON.stringify(manifest)}, String(process.pid) + '\\n')
    fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid))
    setInterval(() => {}, 60_000)
  `
}

function branchProgram(home: string, manifest: string, branchReady: string, leafReady: string): string {
  const leaf = leafProgram(home, manifest, leafReady)
  return `
    const fs = await import('node:fs')
    const home = ${JSON.stringify(home)}
    const leaf = Bun.spawn(['bun', '-e', ${JSON.stringify(leaf)}], {
      detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
    })
    fs.appendFileSync(${JSON.stringify(manifest)}, String(process.pid) + '\\n' + String(leaf.pid) + '\\n')
    for (let attempt = 0; attempt < 500 && !fs.existsSync(${JSON.stringify(leafReady)}); attempt++) await Bun.sleep(10)
    if (!fs.existsSync(${JSON.stringify(leafReady)})) process.exit(78)
    fs.writeFileSync(${JSON.stringify(branchReady)}, String(process.pid))
    setInterval(() => {}, 60_000)
  `
}

function hostProgram(home: string, manifest: string, ready: string): string {
  const branchReady = join(home, 'branch.ready')
  const leafReady = join(home, 'leaf.ready')
  const branch = branchProgram(home, manifest, branchReady, leafReady)
  return `
    const fs = await import('node:fs')
    const path = await import('node:path')
    const home = ${JSON.stringify(home)}
    if (process.env.QUIRKY_HOME !== home) process.exit(79)
    fs.writeFileSync(path.join(home, 'pty.pid'), String(process.pid))
    fs.appendFileSync(${JSON.stringify(manifest)}, String(process.pid) + '\\n')
    const branch = Bun.spawn(['bun', '-e', ${JSON.stringify(branch)}], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
    })
    fs.appendFileSync(${JSON.stringify(manifest)}, String(branch.pid) + '\\n')
    for (let attempt = 0; attempt < 500 && !fs.existsSync(${JSON.stringify(branchReady)}); attempt++) await Bun.sleep(10)
    if (!fs.existsSync(${JSON.stringify(branchReady)})) process.exit(77)
    fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid))
    process.stdout.write(JSON.stringify({ pid: process.pid, home, extra: process.env.PROCESS_SCOPE_EXTRA ?? null }) + '\\n')
    setInterval(() => {}, 60_000)
  `
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes('\n')) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`subprocess exited before writing a line: ${text}`)
    text += decoder.decode(value, { stream: true })
  }
  return text.slice(0, text.indexOf('\n'))
}

async function startSentinel(): Promise<{ child: IsolatedSubprocess; identity: ProcessIdentity }> {
  const marker = `unrelated-${randomUUID()}`
  const child = spawnDetached(['bun', '-e', `const marker = ${JSON.stringify(marker)}; setInterval(() => {}, 60_000)`], {
    detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
  })
  const entry: { child: IsolatedSubprocess; identity?: ProcessIdentity } = { child }
  sentinels.push(entry)
  const identity = await waitForProcess(child.pid)
  entry.identity = identity
  return { child, identity }
}

afterEach(async () => {
  for (const scope of scopes.splice(0)) {
    try {
      scope.killNow()
    } catch {
      // Continue to the PID-identity-checked fallback below.
    }
    try {
      await scope.cleanup()
    } catch {
      // Continue to the PID-identity-checked fallback below.
    }
  }
  for (const home of homes) {
    for (let attempt = 0; attempt < 300; attempt++) {
      killHomeProcesses(home)
      if (![...processTable().values()].some((row) => row.command.includes(home))) break
      await Bun.sleep(20)
    }
  }
  for (const sentinel of sentinels.splice(0)) {
    if (!sentinel.identity) {
      if (sentinel.child.exitCode === null) sentinel.child.kill('SIGKILL')
      continue
    }
    if (!sameProcess(sentinel.identity, processTable().get(sentinel.identity.pid))) continue
    try {
      process.kill(sentinel.identity.pid, 'SIGKILL')
    } catch {
      // The sentinel may have exited already.
    }
  }
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  homes.clear()
})

test('scope.spawn keeps the real Bun process, owns nested detached trees, and cleanup is idempotent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'process-scope-normal-'))
  homes.add(home)
  const scope = createProcessScope(home)
  scopes.push(scope)
  expect(scope.home).toBe(home)
  expect(scope.env.QUIRKY_HOME).toBe(home)

  writeFileSync(join(home, 'runtime.json'), JSON.stringify({ pid: process.pid }))
  const manifest = join(home, 'owned-pids')
  const ready = join(home, 'host.ready')
  const child = scope.spawn(['bun', '-e', hostProgram(home, manifest, ready)], {
    detached: true,
    env: { ...process.env, ...scope.env, PROCESS_SCOPE_EXTRA: 'caller-env' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore'
  })
  if (!child.stdout) throw new Error('scope.spawn did not preserve the requested stdout pipe')
  const report = JSON.parse(await readLine(child.stdout)) as { pid: number; home: string; extra: string }
  expect(report).toEqual({ pid: child.pid, home, extra: 'caller-env' })
  expect(readFileSync(join(home, 'pty.pid'), 'utf8')).toBe(String(child.pid))
  const pids = readFileSync(manifest, 'utf8').trim().split('\n').map(Number)
  expect(new Set(pids).size).toBe(3)
  expect(pids).toContain(child.pid)
  const ownedIdentities = await Promise.all([...new Set(pids)].map(waitForProcess))

  await scope.cleanup()
  await scope.cleanup()
  scope.killNow()
  await waitForHomeProcessesGone(home, pids)
  expect(ownedIdentities.every((identity) => !sameProcess(identity, processTable().get(identity.pid)))).toBe(true)
  expect(processTable().has(process.pid)).toBe(true)
}, 15_000)

test('scope adopts a fresh runtime.json daemon PID without an explicit track call', async () => {
  const home = mkdtempSync(join(tmpdir(), 'process-scope-runtime-'))
  homes.add(home)
  const scope = createProcessScope(home)
  scopes.push(scope)
  const program = `
    const home = ${JSON.stringify(home)}
    setInterval(() => {}, 60_000)
  `
  const daemon = spawnDetached(['bun', '-e', program], {
    detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
  })
  const identity = await waitForProcess(daemon.pid)
  writeFileSync(join(home, 'runtime.json'), JSON.stringify({ pid: daemon.pid }))

  await scope.cleanup()
  await waitForHomeProcessesGone(home, [daemon.pid])
  expect(sameProcess(identity, processTable().get(daemon.pid))).toBe(false)
}, 15_000)

test('a default scope registers a fresh home and track cleans an already-started process', async () => {
  const scope = createProcessScope()
  scopes.push(scope)
  const home = scope.home
  homes.add(home)
  expect(home).toBeTruthy()
  expect(scope.env.QUIRKY_HOME).toBe(home)
  expect(existsSync(home)).toBe(true)

  const program = `
    const home = ${JSON.stringify(home)}
    setInterval(() => {}, 60_000)
  `
  const tracked = spawnDetached(['bun', '-e', program], {
    detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, ...scope.env }
  })
  scope.track(tracked.pid)
  const identity = await waitForProcess(tracked.pid)
  expect(identity.command).toContain(home)

  await scope.cleanup()
  await scope.cleanup()
  expect(sameProcess(identity, processTable().get(tracked.pid))).toBe(false)
  expect(existsSync(home)).toBe(false)
})

test('a guardian cleans a pty.pid process tree after owner SIGKILL without killing runtime owner or sentinel', async () => {
  const home = mkdtempSync(join(tmpdir(), 'process-scope-owner-kill-'))
  homes.add(home)
  const sentinel = await startSentinel()
  const manifest = join(home, 'owned-pids')
  const ready = join(home, 'owner.ready')
  const hostReady = join(home, 'host.ready')
  const host = hostProgram(home, manifest, hostReady)
  const ownerSource = `
    const fs = await import('node:fs')
    const scopeModule = await import(${JSON.stringify(processScopeModule)})
    const home = ${JSON.stringify(home)}
    const scope = scopeModule.createProcessScope(home)
    fs.writeFileSync(${JSON.stringify(join(home, 'runtime.json'))}, JSON.stringify({ pid: process.pid }))
    const host = Bun.spawn(['bun', '-e', ${JSON.stringify(host)}], {
      detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, ...scope.env }
    })
    for (let attempt = 0; attempt < 500 && !fs.existsSync(${JSON.stringify(hostReady)}); attempt++) await Bun.sleep(10)
    if (!fs.existsSync(${JSON.stringify(hostReady)})) process.exit(76)
    fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ owner: process.pid, host: host.pid }))
    setInterval(() => {}, 60_000)
  `
  const owner = spawnDetached(['bun', '-e', ownerSource], {
    detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, QUIRKY_HOME: home }
  })
  const ownerIdentity = await waitForProcess(owner.pid)
  const readyInfo = await waitForFileJson(ready)
  expect(readyInfo.owner).toBe(owner.pid)
  expect(readFileSync(join(home, 'runtime.json'), 'utf8')).toContain(String(owner.pid))
  expect(readFileSync(join(home, 'pty.pid'), 'utf8')).toBe(String(readyInfo.host))

  const pids = readFileSync(manifest, 'utf8').trim().split('\n').map(Number)
  expect(new Set(pids).size).toBe(3)
  expect(pids).not.toContain(owner.pid)
  const ownedIdentities = await Promise.all([...new Set(pids)].map(waitForProcess))
  owner.kill('SIGKILL')
  await owner.exited
  await waitForHomeProcessesGone(home)
  expect(ownedIdentities.every((identity) => !sameProcess(identity, processTable().get(identity.pid)))).toBe(true)
  expect(sameProcess(sentinel.identity, processTable().get(sentinel.child.pid))).toBe(true)
  // The owner process identity itself was captured before termination, not a same-number replacement.
  expect(sameProcess(ownerIdentity, processTable().get(owner.pid))).toBe(false)
}, 15_000)

async function waitForFileJson(path: string): Promise<Record<string, number>> {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      await Bun.sleep(10)
    }
  }
  throw new Error(`file was not written: ${path}`)
}
