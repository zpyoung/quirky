import { closeSync, openSync, readlinkSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import { dlopen, ptr, toArrayBuffer, type Pointer } from 'bun:ffi'
import type { ProcessRunner, RunResult } from '@quirky/protocol'

export type ChromeProcessIdentity = {
  pid: number
  ppid: number
  pgid: number
  uid: number
  started: string
  executable: string
  argv: readonly string[]
}

export type ChromeProcessAccess = {
  snapshot(): Promise<readonly ChromeProcessIdentity[]>
  inspect(pid: number): Promise<ChromeProcessIdentity | null>
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
}

export type ChromeProcessAccessOptions = {
  platform?: string
  now?: () => number
  readMacProcessArgs?: (pid: number, maxBytes: number) => Uint8Array | null
  readLinuxProcessArgs?: (pid: number, maxBytes: number) => Uint8Array | null
  readLinuxExecutable?: (pid: number) => string
}

type ProcessMetadata = Omit<ChromeProcessIdentity, 'executable' | 'argv'> & { command: string }
type NativePointer = Pointer | null

const MAX_PROCESS_TABLE_BYTES = 4 * 1024 * 1024
const MAX_NATIVE_ARGV_BYTES = 1024 * 1024
const INSPECTION_BUDGET_MS = 2_000
const PS_FIELDS = 'pid=,ppid=,pgid=,uid=,lstart=,comm='
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const CHROME_COMMANDS = new Set([
  'google chrome',
  'chromium',
  'chromium-browser',
  'chrome',
  'google-chrome',
  'google-chrome-stable'
])

function inspectionError(): Error {
  return new Error('Chrome process inspection failed')
}

function isGone(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ESRCH')
}

function processTableCommand(pid: number | null): string[] {
  return pid === null
    ? ['ps', '-A', '-o', PS_FIELDS]
    : ['ps', '-p', String(pid), '-o', PS_FIELDS]
}

function parseNumber(value: string): number {
  if (!/^\d+$/.test(value)) throw inspectionError()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw inspectionError()
  return parsed
}

function parseProcessTable(text: string): ProcessMetadata[] {
  const rows: ProcessMetadata[] = []
  const seen = new Set<number>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) throw inspectionError()
    const pid = parseNumber(fields[0]!)
    const ppid = parseNumber(fields[1]!)
    const pgid = parseNumber(fields[2]!)
    const uid = parseNumber(fields[3]!)
    const started = fields.slice(4, 9).join(' ')
    const command = fields.slice(9).join(' ').trim()
    if (pid <= 0 || pgid <= 0 || !started || !command || seen.has(pid)) throw inspectionError()
    seen.add(pid)
    rows.push({ pid, ppid, pgid, uid, started, command })
  }
  return rows
}

function isChromeCandidate(metadata: ProcessMetadata): boolean {
  return CHROME_COMMANDS.has(basename(metadata.command).toLowerCase())
}

function isChromeRoot(identity: ChromeProcessIdentity): boolean {
  return !identity.argv.some((argument) => argument === '--type' || argument.startsWith('--type='))
}

function decodeArgument(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes)
  } catch {
    throw inspectionError()
  }
}

function parseMacProcessArgs(bytes: Uint8Array): { executable: string; argv: string[] } {
  if (bytes.byteLength < 4) throw inspectionError()
  const argc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true)
  if (argc <= 0 || argc > bytes.byteLength) throw inspectionError()

  let executableEnd = 4
  while (executableEnd < bytes.byteLength && bytes[executableEnd] !== 0) executableEnd += 1
  if (executableEnd >= bytes.byteLength) throw inspectionError()
  const executable = decodeArgument(bytes.subarray(4, executableEnd))
  if (!executable) throw inspectionError()

  let offset = executableEnd + 1
  while (offset < bytes.byteLength && bytes[offset] === 0) offset += 1
  if (offset >= bytes.byteLength) throw inspectionError()
  const argv: string[] = []
  for (let index = 0; index < argc; index += 1) {
    let end = offset
    while (end < bytes.byteLength && bytes[end] !== 0) end += 1
    if (end >= bytes.byteLength) throw inspectionError()
    argv.push(decodeArgument(bytes.subarray(offset, end)))
    offset = end + 1
  }
  return { executable, argv }
}

function parseLinuxProcessArgs(bytes: Uint8Array): string[] {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0) throw inspectionError()
  const argv: string[] = []
  let offset = 0
  while (offset < bytes.byteLength) {
    let end = offset
    while (end < bytes.byteLength && bytes[end] !== 0) end += 1
    if (end >= bytes.byteLength) throw inspectionError()
    argv.push(decodeArgument(bytes.subarray(offset, end)))
    offset = end + 1
  }
  if (argv.length === 0) throw inspectionError()
  return argv
}

function readMacProcessArgs(pid: number): Uint8Array | null {
  const library = dlopen('/usr/lib/libSystem.B.dylib', {
    sysctl: { args: ['ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u64'], returns: 'i32' },
    __error: { args: [], returns: 'ptr' }
  })
  try {
    const mib = Buffer.alloc(12)
    mib.writeInt32LE(1, 0)
    mib.writeInt32LE(49, 4)
    mib.writeInt32LE(pid, 8)
    const buffer = Buffer.allocUnsafe(MAX_NATIVE_ARGV_BYTES + 1)
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(buffer.byteLength))
    const result = library.symbols.sysctl(ptr(mib), 3, ptr(buffer), ptr(length), null, 0n)
    const actualLength = length.readBigUInt64LE(0)
    if (result !== 0) {
      const errorPointer = library.symbols.__error() as NativePointer
      if (errorPointer !== null && new DataView(toArrayBuffer(errorPointer, 0, 4)).getInt32(0, true) === 3) return null
      throw inspectionError()
    }
    if (actualLength > BigInt(MAX_NATIVE_ARGV_BYTES) || actualLength > BigInt(buffer.byteLength)) {
      throw inspectionError()
    }
    return buffer.subarray(0, Number(actualLength))
  } finally {
    library.close()
  }
}

function readLinuxProcessArgs(pid: number): Uint8Array {
  const descriptor = openSync(`/proc/${pid}/cmdline`, 'r')
  try {
    const buffer = Buffer.allocUnsafe(MAX_NATIVE_ARGV_BYTES + 1)
    let length = 0
    while (length < buffer.byteLength) {
      const count = readSync(descriptor, buffer, length, buffer.byteLength - length, null)
      if (count === 0) break
      length += count
    }
    if (length > MAX_NATIVE_ARGV_BYTES) throw inspectionError()
    return buffer.subarray(0, length)
  } finally {
    closeSync(descriptor)
  }
}

function readLinuxExecutable(pid: number): string {
  return readlinkSync(`/proc/${pid}/exe`)
}


export function createChromeProcessAccess(
  processRunner: Pick<ProcessRunner, 'run'>,
  overrides: ChromeProcessAccessOptions = {}
): ChromeProcessAccess {
  const platform = overrides.platform ?? process.platform
  const now = overrides.now ?? (() => performance.now())

  function ensureSupported(): void {
    if (platform !== 'darwin' && platform !== 'linux') throw inspectionError()
  }

  function ensureTime(deadline: number): void {
    if (now() >= deadline) throw inspectionError()
  }

  async function readTable(pid: number | null, deadline: number): Promise<ProcessMetadata[]> {
    ensureTime(deadline)
    const remaining = Math.max(1, Math.floor(deadline - now()))
    let result: RunResult
    try {
      result = await processRunner.run(processTableCommand(pid), {
        timeoutMs: remaining,
        killGraceMs: 0,
        maxOutputBytes: MAX_PROCESS_TABLE_BYTES,
        outputMode: 'separate',
        overflow: 'truncate'
      })
    } catch {
      throw inspectionError()
    }
    ensureTime(deadline)
    if (pid !== null && result.exitCode === 1 && result.stdout.byteLength === 0 && result.signal === null &&
      !result.stopped && !result.spawnError && !result.truncated?.stdout && !result.truncated?.stderr && !result.stderr.trim()) {
      return []
    }
    if (result.exitCode !== 0 || result.signal !== null || result.stopped || result.spawnError ||
      result.truncated?.stdout || result.truncated?.stderr || result.stdout.byteLength > MAX_PROCESS_TABLE_BYTES) {
      throw inspectionError()
    }
    let text: string
    try {
      text = UTF8.decode(result.stdout)
    } catch {
      throw inspectionError()
    }
    return parseProcessTable(text)
  }

  function readNativeArgs(pid: number): { executable: string; argv: string[] } | null {
    if (platform === 'darwin') {
      const bytes = overrides.readMacProcessArgs
        ? overrides.readMacProcessArgs(pid, MAX_NATIVE_ARGV_BYTES)
        : readMacProcessArgs(pid)
      if (bytes === null) return null
      if (bytes.byteLength > MAX_NATIVE_ARGV_BYTES) throw inspectionError()
      return parseMacProcessArgs(bytes)
    }
    const bytes = overrides.readLinuxProcessArgs
      ? overrides.readLinuxProcessArgs(pid, MAX_NATIVE_ARGV_BYTES)
      : readLinuxProcessArgs(pid)
    if (bytes === null) return null
    if (bytes.byteLength > MAX_NATIVE_ARGV_BYTES) throw inspectionError()
    const argv = parseLinuxProcessArgs(bytes)
    const executable = overrides.readLinuxExecutable
      ? overrides.readLinuxExecutable(pid)
      : readLinuxExecutable(pid)
    if (!executable) throw inspectionError()
    return { executable, argv }
  }

  async function readIdentity(metadata: ProcessMetadata, deadline: number): Promise<ChromeProcessIdentity | null> {
    ensureTime(deadline)
    try {
      const native = readNativeArgs(metadata.pid)
      if (native === null) {
        ensureTime(deadline)
        return null
      }
      ensureTime(deadline)
      return {
        pid: metadata.pid,
        ppid: metadata.ppid,
        pgid: metadata.pgid,
        uid: metadata.uid,
        started: metadata.started,
        executable: native.executable,
        argv: native.argv
      }
    } catch (error) {
      if (isGone(error)) {
        ensureTime(deadline)
        return null
      }
      throw inspectionError()
    }
  }

  return {
    async snapshot(): Promise<readonly ChromeProcessIdentity[]> {
      ensureSupported()
      const deadline = now() + INSPECTION_BUDGET_MS
      const metadata = await readTable(null, deadline)
      if (metadata.length === 0) throw inspectionError()
      const identities: ChromeProcessIdentity[] = []
      for (const candidate of metadata) {
        ensureTime(deadline)
        if (!isChromeCandidate(candidate)) continue
        const identity = await readIdentity(candidate, deadline)
        if (identity !== null && isChromeRoot(identity)) identities.push(identity)
      }
      ensureTime(deadline)
      return identities
    },
    async inspect(pid: number): Promise<ChromeProcessIdentity | null> {
      ensureSupported()
      if (!Number.isSafeInteger(pid) || pid <= 0) throw inspectionError()
      const deadline = now() + INSPECTION_BUDGET_MS
      const rows = await readTable(pid, deadline)
      if (rows.length === 0) {
        ensureTime(deadline)
        try {
          const native = readNativeArgs(pid)
          ensureTime(deadline)
          if (native === null) return null
        } catch (error) {
          if (isGone(error)) {
            ensureTime(deadline)
            return null
          }
          throw inspectionError()
        }
        throw inspectionError()
      }
      if (rows.length !== 1 || rows[0]?.pid !== pid) throw inspectionError()
      return readIdentity(rows[0]!, deadline)
    },
    signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
      if (!Number.isSafeInteger(pid) || pid <= 1) throw inspectionError()
      process.kill(pid, signal)
    }
  }
}
