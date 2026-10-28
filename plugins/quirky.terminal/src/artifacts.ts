import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
  type BigIntStats
} from 'node:fs'
import { basename, extname, isAbsolute } from 'node:path'
import type {
  PluginCaller,
  PluginContext,
  Session,
  TerminalArtifact,
  TerminalArtifactRefusal,
  TerminalArtifactRequest,
  TerminalArtifactResult
} from '@quirky/protocol'
import { TERMINAL_ARTIFACT_TEXT_BYTES } from '@quirky/protocol'
import { findPathCandidates, MAX_PATHS_PER_LINE, resolveAgainst } from './window/pane/links'

const GRANT_LIFETIME_MS = 5 * 60 * 1000
const PROVENANCE_LIFETIME_MS = 30 * 60 * 1000
const MAX_LISTED = 50
const MAX_PER_PRINCIPAL = 100
const MAX_RETAINED = 500
const MAX_SCAN_LINES = 2000
const MAX_SCAN_CHARS = 256 * 1024
const MAX_SCANNED_PATHS = 200
const MAX_IMAGE_BYTES = 192 * 1024 // Base64 is capped at 256 KiB to match the phone preview validator.
const TEXT_READ_BYTES = TERMINAL_ARTIFACT_TEXT_BYTES + 4
const O_NOFOLLOW = constants.O_NOFOLLOW
const O_NONBLOCK = constants.O_NONBLOCK
const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export type TerminalArtifactsOptions = { now?: () => number }

type SourceIdentity = {
  worktree: string
  session: string
  cwd: string
  runtimeEpoch: string
  processIncarnation: string
}

type FileIdentity = { path: string; realPath: string; dev: string; ino: string }
type ApprovedRevision = { revision: string; fingerprint: string; size: number }
type ArtifactEntry = FileIdentity & {
  artifactId: string
  grant: string
  expiresAt: number
  retainUntil: number
  principal: string
  worktree: string
  session: string
  name: string
  source: SourceIdentity
  approved?: ApprovedRevision
}
type ScanResult = { paths: string[]; limited: boolean }
type OpenFile = { fd: number; stat: BigIntStats }
type PreviewBytes = {
  bytes: number
  truncated: boolean
  format: 'text' | 'markdown' | 'image' | 'binary'
  content: string
  image?: { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
  writable: boolean
  fingerprint?: string
}

class ArtifactFailure extends Error {
  constructor(readonly refusal: TerminalArtifactRefusal) {
    super(refusal.guidance)
  }
}

const refusal = (reason: TerminalArtifactRefusal['reason'], guidance: string): TerminalArtifactRefusal => ({ kind: 'refused', reason, guidance })
const unsupported = () => refusal('unsupported', 'Terminal artifacts require a supported local terminal host and an exact artifact request.')
const unavailable = () => refusal('source-unavailable', 'The source terminal is no longer active or its local output is unavailable.')
const changed = () => refusal('file-changed', 'The artifact path or file changed. Preview the current file before saving again.')
const invalidGrant = () => refusal('grant-invalid', 'This artifact grant is invalid for this caller, worktree, or session.')
const expiredGrant = () => refusal('grant-expired', 'This artifact grant expired. Refresh its authorization before continuing.')
const readOnly = () => refusal('read-only', 'Only complete writable UTF-8 text artifacts can be saved.')
const tooLarge = () => refusal('too-large', 'The artifact content exceeds the supported byte limit.')

function safePlatform(): boolean {
  return process.platform === 'darwin' && Number.isInteger(O_NOFOLLOW) && O_NOFOLLOW > 0 &&
    Number.isInteger(O_NONBLOCK) && O_NONBLOCK > 0
}

function token(): string {
  return randomBytes(32).toString('hex')
}

function sameToken(expected: string, supplied: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(supplied)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))
}

function identityOf(stat: BigIntStats): { dev: string; ino: string } {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function sameIdentity(stat: BigIntStats, entry: Pick<FileIdentity, 'dev' | 'ino'>): boolean {
  return stat.isFile() && stat.dev.toString() === entry.dev && stat.ino.toString() === entry.ino
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function diskFingerprint(path: string, stat: BigIntStats, bytes: Uint8Array): string {
  return createHash('sha256')
    .update(path).update('\0')
    .update(stat.dev.toString()).update('\0')
    .update(stat.ino.toString()).update('\0')
    .update(stat.size.toString()).update('\0')
    .update(stat.mode.toString()).update('\0')
    .update(stat.mtimeNs.toString()).update('\0')
    .update(stat.ctimeNs.toString()).update('\0')
    .update(bytes)
    .digest('hex')
}

function readAtMost(fd: number, size: bigint, maximum: number): Buffer {
  const requested = Number(size > BigInt(maximum) ? BigInt(maximum) : size)
  const buffer = Buffer.allocUnsafe(requested)
  let offset = 0
  while (offset < requested) {
    const count = readSync(fd, buffer, offset, requested - offset, offset)
    if (count === 0) break
    offset += count
  }
  return buffer.subarray(0, offset)
}

function utf8SequenceLength(first: number): number {
  if (first <= 0x7f) return 1
  if (first >= 0xc2 && first <= 0xdf) return 2
  if (first >= 0xe0 && first <= 0xef) return 3
  if (first >= 0xf0 && first <= 0xf4) return 4
  return 0
}

function validUtf8Sequence(bytes: Uint8Array, offset: number, length: number): boolean {
  if (length === 1) return true
  if (offset + length > bytes.length) return false
  const first = bytes[offset]!
  const second = bytes[offset + 1]!
  if ((second & 0xc0) !== 0x80) return false
  if (first === 0xe0 && second < 0xa0) return false
  if (first === 0xed && second >= 0xa0) return false
  if (first === 0xf0 && second < 0x90) return false
  if (first === 0xf4 && second >= 0x90) return false
  for (let index = 2; index < length; index++) {
    if ((bytes[offset + index]! & 0xc0) !== 0x80) return false
  }
  return true
}
function containsBinaryControls(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) return true
  }
  return false
}

function textPrefix(bytes: Buffer, size: bigint): { text: string; truncated: boolean } | undefined {
  const truncated = size > BigInt(TERMINAL_ARTIFACT_TEXT_BYTES)
  let end = bytes.length
  if (truncated) {
    end = 0
    while (end < TERMINAL_ARTIFACT_TEXT_BYTES) {
      const length = utf8SequenceLength(bytes[end]!)
      if (length === 0 || !validUtf8Sequence(bytes, end, length)) return undefined
      if (bytes[end] === 0) return undefined
      if (end + length > TERMINAL_ARTIFACT_TEXT_BYTES) break
      end += length
    }
  }
  const content = bytes.subarray(0, end)
  if (containsBinaryControls(content)) return undefined
  try {
    return { text: fatalDecoder.decode(content), truncated }
  } catch {
    return undefined
  }
}

function imageMime(path: string, header: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  const extension = extname(path).toLowerCase()
  if (extension === '.png' && header.length >= 8 &&
    header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47 &&
    header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a) return 'image/png'
  if ((extension === '.jpg' || extension === '.jpeg') && header.length >= 3 &&
    header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg'
  if (extension === '.gif' && header.length >= 6 &&
    header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x38 &&
    (header[4] === 0x37 || header[4] === 0x39) && header[5] === 0x61) return 'image/gif'
  if (extension === '.webp' && header.length >= 12 &&
    header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
    header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) return 'image/webp'
  return undefined
}

function sourceKey(source: SourceIdentity): string {
  return `${source.worktree}\0${source.session}\0${source.runtimeEpoch}\0${source.processIncarnation}`
}

function isRefusal(value: unknown): value is TerminalArtifactRefusal {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'refused'
}

function exactKeys(params: Record<string, unknown>, action: TerminalArtifactRequest['action']): boolean {
  const allowed = action === 'list'
    ? ['action', 'worktree', 'session']
    : action === 'save'
      ? ['action', 'worktree', 'session', 'artifactId', 'grant', 'expectedRevision', 'content']
      : ['action', 'worktree', 'session', 'artifactId', 'grant']
  const keys = Object.keys(params)
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key))
}

function failureOf(error: unknown, writing: boolean): ArtifactFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'ELOOP' || code === 'ENOENT' || code === 'ENOTDIR' || code === 'ESTALE') return new ArtifactFailure(changed())
  if (writing && (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')) return new ArtifactFailure(readOnly())
  if (code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EINVAL') return new ArtifactFailure(unsupported())
  return new ArtifactFailure(unavailable())
}

function captureFile(path: string): FileIdentity | undefined {
  if (!path.startsWith('/') || /[\u0000-\u001f\u007f]/.test(path)) return undefined
  let fd: number | undefined
  try {
    const realPath = realpathSync.native(path)
    const before = statSync(realPath, { bigint: true })
    if (!before.isFile()) return undefined
    fd = openSync(realPath, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    const opened = fstatSync(fd, { bigint: true })
    const current = statSync(realPath, { bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
      !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino || realpathSync.native(path) !== realPath) return undefined
    const { dev, ino } = identityOf(opened)
    return { path, realPath, dev, ino }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export class TerminalArtifactsService {
  private readonly now: () => number
  private readonly entries = new Map<string, ArtifactEntry>()
  private readonly fileQueues = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly context: PluginContext, options: TerminalArtifactsOptions = {}) {
    this.now = options.now ?? Date.now
  }

  handle = async (params: Record<string, unknown>, caller: PluginCaller): Promise<TerminalArtifactResult> => {
    if (this.closed) return unavailable()
    const shape = this.validateRequest(params)
    if (shape) return shape
    const principal = this.principal(caller)
    if (principal === null) return invalidGrant()
    if (!safePlatform()) return unsupported()
    const now = this.now()
    this.collectExpired(now)
    if (params.action === 'list') return this.list(params.worktree as string, params.session as string, principal)

    const entry = this.findEntry(params, principal, params.action === 'refresh', now)
    if (isRefusal(entry)) return entry
    if (params.action === 'preview') return this.preview(entry, params.grant as string, principal)
    if (params.action === 'refresh') return this.refresh(entry, params.grant as string, principal)
    return this.save(entry, params, params.grant as string, principal)
  }

  shutdown(): void {
    this.closed = true
    this.entries.clear()
    this.fileQueues.clear()
  }

  private validateRequest(params: Record<string, unknown>): TerminalArtifactRefusal | null {
    const action = params?.action
    if (action !== 'list' && action !== 'preview' && action !== 'refresh' && action !== 'save') return unsupported()
    if (!exactKeys(params, action)) return unsupported()
    if (typeof params.worktree !== 'string' || params.worktree.length === 0 || params.worktree.length > 1024 ||
      typeof params.session !== 'string' || params.session.length === 0 || params.session.length > 1024) return unsupported()
    if (action !== 'list' && (typeof params.artifactId !== 'string' || params.artifactId.length === 0 || params.artifactId.length > 128 ||
      typeof params.grant !== 'string' || params.grant.length === 0 || params.grant.length > 128)) return unsupported()
    if (action === 'save' && (typeof params.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(params.expectedRevision) || typeof params.content !== 'string')) return unsupported()
    return null
  }

  private principal(caller: PluginCaller): string | null {
    if (caller.role === 'mobile') {
      if (typeof caller.deviceId === 'string' && caller.deviceId.length > 0) return `mobile:${caller.deviceId}`
      return null
    }
    if (caller.role === 'cli') return 'local-cli'
    return null
  }

  private collectExpired(now: number): void {
    for (const [id, entry] of this.entries) if (entry.retainUntil <= now) this.entries.delete(id)
  }

  private findEntry(
    params: Record<string, unknown>,
    principal: string,
    allowExpired: boolean,
    now: number
  ): ArtifactEntry | TerminalArtifactRefusal {
    const entry = this.entries.get(params.artifactId as string)
    if (!entry || entry.principal !== principal || entry.worktree !== params.worktree || entry.session !== params.session) return invalidGrant()
    if (entry.retainUntil <= now) {
      this.entries.delete(entry.artifactId)
      return invalidGrant()
    }
    if (!sameToken(entry.grant, params.grant as string)) return invalidGrant()
    if (!allowExpired && entry.expiresAt <= now) return expiredGrant()
    return entry
  }

  private artifact(entry: ArtifactEntry): TerminalArtifact {
    return {
      source: 'terminalArtifact',
      artifactId: entry.artifactId,
      grant: entry.grant,
      expiresAt: entry.expiresAt,
      worktree: entry.worktree,
      session: entry.session,
      name: entry.name,
      path: entry.path
    }
  }

  private async sourceOf(worktree: string, sessionId: string): Promise<SourceIdentity | TerminalArtifactRefusal> {
    if (!this.context.pty.connected) return unavailable()
    try {
      const record = await this.context.call('quirky.session/get', { session: sessionId }) as Session & { hostId?: unknown }
      if (!record || record.id !== sessionId || record.worktreeId !== worktree) return unavailable()
      // A remote host marker overrides any matching local PTY ID or launch authority.
      if (record.hostId !== undefined && record.hostId !== 'local') {
        return refusal('unsupported', 'Remote terminal sessions cannot provide local file artifacts.')
      }
      if (record.kind !== 'terminal') return refusal('unsupported', 'Only a local terminal session can provide file artifacts.')
      if (record.status === 'exited') return unavailable()
      const identity = this.context.launch.sessionIdentity(sessionId)
      if (identity?.source === 'structured_lease') {
        return refusal('unsupported', 'Only a local terminal session can provide file artifacts.')
      }
      if (!identity || identity.sessionId !== sessionId || !identity.live ||
        !identity.runtimeEpoch || !identity.processIncarnation) return unavailable()
      const sessions = await this.context.pty.list()
      const host = sessions.find((item) => item.sessionId === sessionId)
      if (!host || host.state !== 'running' || !host.alive || !isAbsolute(host.cwd)) return unavailable()
      return {
        worktree,
        session: sessionId,
        cwd: host.cwd,
        runtimeEpoch: identity.runtimeEpoch,
        processIncarnation: identity.processIncarnation
      }
    } catch {
      return unavailable()
    }
  }

  private sameSource(left: SourceIdentity, right: SourceIdentity): boolean {
    return sourceKey(left) === sourceKey(right)
  }

  private async scanOutput(source: SourceIdentity): Promise<ScanResult | TerminalArtifactRefusal> {
    let output: { lines: string[] }
    try {
      output = await this.context.pty.read(source.session, MAX_SCAN_LINES, { unwrap: true })
    } catch {
      return unavailable()
    }
    if (!Array.isArray(output.lines) || output.lines.some((line) => typeof line !== 'string')) return unavailable()
    const paths: string[] = []
    const seen = new Set<string>()
    let limited = output.lines.length >= MAX_SCAN_LINES
    let remaining = MAX_SCAN_CHARS
    for (let index = output.lines.length - 1; index >= 0 && remaining > 0; index--) {
      const line = output.lines[index]!
      const segment = line.length > remaining ? line.slice(line.length - remaining) : line
      if (line.length > remaining) limited = true
      remaining -= segment.length
      const matches = findPathCandidates(segment)
      if (matches.length >= MAX_PATHS_PER_LINE) limited = true
      for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex--) {
        const absolute = resolveAgainst(matches[matchIndex]!.path, source.cwd)
        if (!absolute || seen.has(absolute)) continue
        seen.add(absolute)
        paths.push(absolute)
        if (paths.length >= MAX_SCANNED_PATHS) {
          limited = true
          return { paths, limited }
        }
      }
    }
    if (remaining === 0) limited = true
    return { paths, limited }
  }

  private findReusable(principal: string, source: SourceIdentity, file: FileIdentity): ArtifactEntry | undefined {
    const key = sourceKey(source)
    for (const entry of this.entries.values()) {
      if (entry.principal === principal && entry.path === file.path && entry.realPath === file.realPath &&
        entry.dev === file.dev && entry.ino === file.ino && sourceKey(entry.source) === key) return entry
    }
    return undefined
  }

  private async list(worktree: string, sessionId: string, principal: string): Promise<TerminalArtifactResult> {
    const source = await this.sourceOf(worktree, sessionId)
    if (this.closed) return unavailable()
    if (isRefusal(source)) return source
    const scan = await this.scanOutput(source)
    if (this.closed) return unavailable()
    if (isRefusal(scan)) return scan
    const currentSource = await this.sourceOf(worktree, sessionId)
    if (this.closed) return unavailable()
    if (isRefusal(currentSource)) return currentSource
    if (!this.sameSource(source, currentSource) || source.cwd !== currentSource.cwd) return unavailable()
    const issuedAt = this.now()
    this.collectExpired(issuedAt)
    let limited = scan.limited
    const artifacts: TerminalArtifact[] = []
    for (let index = 0; index < scan.paths.length; index++) {
      const file = captureFile(scan.paths[index]!)
      if (!file) continue
      let entry = this.findReusable(principal, source, file)
      if (!entry) {
        let retainedForCaller = 0
        for (const current of this.entries.values()) if (current.principal === principal) retainedForCaller++
        if (this.entries.size >= MAX_RETAINED || retainedForCaller >= MAX_PER_PRINCIPAL) {
          limited = true
          continue
        }
        entry = {
          ...file,
          artifactId: randomUUID(),
          grant: token(),
          expiresAt: issuedAt + GRANT_LIFETIME_MS,
          retainUntil: issuedAt + PROVENANCE_LIFETIME_MS,
          principal,
          worktree,
          session: sessionId,
          name: basename(file.path),
          source
        }
        this.entries.set(entry.artifactId, entry)
      }
      artifacts.push(this.artifact(entry))
      if (artifacts.length === MAX_LISTED) {
        if (index + 1 < scan.paths.length) limited = true
        break
      }
    }
    return { kind: 'listed', artifacts, limited }
  }

  private assertCurrentSource(entry: ArtifactEntry, source: SourceIdentity): TerminalArtifactRefusal | undefined {
    if (!this.sameSource(entry.source, source)) return unavailable()
    return undefined
  }

  private openVerified(entry: ArtifactEntry, writing: boolean): OpenFile {
    let fd: number | undefined
    try {
      if (realpathSync.native(entry.path) !== entry.realPath) throw new ArtifactFailure(changed())
      const flags = (writing ? constants.O_RDWR : constants.O_RDONLY) | O_NOFOLLOW | O_NONBLOCK
      fd = openSync(entry.realPath, flags)
      const stat = this.verifyOpenPath(entry, fd)
      return { fd, stat }
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      if (error instanceof ArtifactFailure) throw error
      throw failureOf(error, writing)
    }
  }

  private verifyOpenPath(entry: ArtifactEntry, fd: number): BigIntStats {
    const stat = fstatSync(fd, { bigint: true })
    let pathStat: BigIntStats
    let resolvedPath: string
    try {
      pathStat = statSync(entry.realPath, { bigint: true })
      resolvedPath = realpathSync.native(entry.path)
    } catch {
      throw new ArtifactFailure(changed())
    }
    if (!sameIdentity(stat, entry) || !sameIdentity(pathStat, entry) || resolvedPath !== entry.realPath) {
      throw new ArtifactFailure(changed())
    }
    return stat
  }

  private async preview(entry: ArtifactEntry, grant: string, principal: string): Promise<TerminalArtifactResult> {
    const source = await this.sourceOf(entry.worktree, entry.session)
    if (this.closed) return unavailable()
    if (isRefusal(source)) return source
    const sourceFailure = this.assertCurrentSource(entry, source)
    if (sourceFailure) return sourceFailure
    let opened: OpenFile
    try {
      opened = this.openVerified(entry, false)
    } catch (error) {
      return error instanceof ArtifactFailure ? error.refusal : unavailable()
    }
    try {
      const initial = opened.stat
      if (initial.size > BigInt(Number.MAX_SAFE_INTEGER)) return tooLarge()
      const size = Number(initial.size)
      const filePreview = this.readPreview(entry, opened.fd, initial, size)
      const finalStat = this.verifyOpenPath(entry, opened.fd)
      if (!sameStat(initial, finalStat)) return changed()
      const grantState = this.findEntry({ artifactId: entry.artifactId, grant, worktree: entry.worktree, session: entry.session }, principal, false, this.now())
      if (isRefusal(grantState)) return grantState
      const stillActive = await this.sourceOf(entry.worktree, entry.session)
      if (this.closed) return unavailable()
      if (isRefusal(stillActive)) return stillActive
      const sourceChanged = this.assertCurrentSource(entry, stillActive)
      if (sourceChanged) return sourceChanged
      const currentGrant = this.findEntry({ artifactId: entry.artifactId, grant, worktree: entry.worktree, session: entry.session }, principal, false, this.now())
      if (isRefusal(currentGrant)) return currentGrant
      const currentStat = this.verifyOpenPath(entry, opened.fd)
      if (!sameStat(finalStat, currentStat)) return changed()
      const revision = token()
      if (filePreview.writable && filePreview.fingerprint) entry.approved = { revision, fingerprint: filePreview.fingerprint, size }
      else entry.approved = undefined
      return {
        kind: 'preview',
        artifact: this.artifact(entry),
        format: filePreview.format,
        content: filePreview.content,
        ...(filePreview.image ? { image: filePreview.image } : {}),
        bytes: filePreview.bytes,
        truncated: filePreview.truncated,
        writable: filePreview.writable,
        revision
      }
    } catch (error) {
      return error instanceof ArtifactFailure ? error.refusal : unavailable()
    } finally {
      closeSync(opened.fd)
    }
  }

  private readPreview(entry: ArtifactEntry, fd: number, initial: BigIntStats, size: number): PreviewBytes {
    const extension = extname(entry.path).toLowerCase()
    if (extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.gif' || extension === '.webp') {
      const header = readAtMost(fd, initial.size, 12)
      const mime = imageMime(entry.path, header)
      if (mime) {
        if (size > MAX_IMAGE_BYTES) return { bytes: size, truncated: false, format: 'binary', content: '', writable: false }
        const data = readAtMost(fd, initial.size, MAX_IMAGE_BYTES)
        if (data.length !== size) throw new ArtifactFailure(changed())
        return { bytes: size, truncated: false, format: 'image', content: '', image: { mime, data: data.toString('base64') }, writable: false }
      }
    }
    const bytes = readAtMost(fd, initial.size, TEXT_READ_BYTES)
    if (bytes.length !== Math.min(size, TEXT_READ_BYTES)) throw new ArtifactFailure(changed())
    const decoded = textPrefix(bytes, initial.size)
    if (!decoded) return { bytes: size, truncated: false, format: 'binary', content: '', writable: false }
    const complete = !decoded.truncated
    if (!complete) return { bytes: size, truncated: true, format: this.textFormat(entry.path), content: decoded.text, writable: false }
    const fingerprint = diskFingerprint(entry.realPath, initial, bytes)
    const writable = this.canWrite(entry)
    return {
      bytes: size,
      truncated: false,
      format: this.textFormat(entry.path),
      content: decoded.text,
      writable,
      ...(writable ? { fingerprint } : {})
    }
  }

  private textFormat(path: string): 'text' | 'markdown' {
    const extension = extname(path).toLowerCase()
    return extension === '.md' || extension === '.markdown' ? 'markdown' : 'text'
  }

  private canWrite(entry: ArtifactEntry): boolean {
    try {
      const opened = this.openVerified(entry, true)
      closeSync(opened.fd)
      return true
    } catch {
      return false
    }
  }

  private async refresh(entry: ArtifactEntry, grant: string, principal: string): Promise<TerminalArtifactResult> {
    const grantState = this.findEntry({ artifactId: entry.artifactId, grant, worktree: entry.worktree, session: entry.session }, principal, true, this.now())
    if (isRefusal(grantState)) return grantState
    const source = await this.sourceOf(entry.worktree, entry.session)
    if (this.closed) return unavailable()
    if (isRefusal(source)) return source
    const sourceFailure = this.assertCurrentSource(entry, source)
    if (sourceFailure) return sourceFailure
    const scan = await this.scanOutput(source)
    if (this.closed) return unavailable()
    if (isRefusal(scan)) return scan
    if (!scan.paths.includes(entry.path)) return unavailable()
    let opened: OpenFile
    try {
      opened = this.openVerified(entry, false)
    } catch (error) {
      return error instanceof ArtifactFailure ? error.refusal : unavailable()
    }
    try {
      const stat = this.verifyOpenPath(entry, opened.fd)
      if (!sameIdentity(stat, entry)) return changed()
    } catch (error) {
      return error instanceof ArtifactFailure ? error.refusal : unavailable()
    } finally {
      closeSync(opened.fd)
    }
    const stillOwned = this.findEntry({ artifactId: entry.artifactId, grant, worktree: entry.worktree, session: entry.session }, principal, true, this.now())
    if (isRefusal(stillOwned)) return stillOwned
    const stillActive = await this.sourceOf(entry.worktree, entry.session)
    if (this.closed) return unavailable()
    if (isRefusal(stillActive)) return stillActive
    const sourceChanged = this.assertCurrentSource(entry, stillActive)
    if (sourceChanged) return sourceChanged
    if (source.cwd !== stillActive.cwd) return unavailable()
    const currentFile = captureFile(entry.path)
    if (!currentFile || currentFile.realPath !== entry.realPath || currentFile.dev !== entry.dev || currentFile.ino !== entry.ino) return changed()
    const currentGrant = this.findEntry({ artifactId: entry.artifactId, grant, worktree: entry.worktree, session: entry.session }, principal, true, this.now())
    if (isRefusal(currentGrant)) return currentGrant
    entry.grant = token()
    entry.expiresAt = this.now() + GRANT_LIFETIME_MS
    return { kind: 'refreshed', artifact: this.artifact(entry) }
  }

  private async save(
    entry: ArtifactEntry,
    params: Record<string, unknown>,
    grant: string,
    principal: string
  ): Promise<TerminalArtifactResult> {
    const content = params.content as string
    if (Buffer.byteLength(content, 'utf8') > TERMINAL_ARTIFACT_TEXT_BYTES) return tooLarge()
    const bytes = Buffer.from(content, 'utf8')
    try {
      if (fatalDecoder.decode(bytes) !== content || containsBinaryControls(bytes)) return readOnly()
    } catch {
      return readOnly()
    }
    const initialGrant = this.findEntry({ artifactId: entry.artifactId, grant, worktree: entry.worktree, session: entry.session }, principal, false, this.now())
    if (isRefusal(initialGrant)) return initialGrant
    const key = `${entry.dev}:${entry.ino}`
    return this.serialize(key, () => this.saveSerialized(entry, params.expectedRevision as string, bytes, grant, principal))
  }

  private async saveSerialized(
    entry: ArtifactEntry,
    expectedRevision: string,
    content: Buffer,
    grant: string,
    principal: string
  ): Promise<TerminalArtifactResult> {
    const grantState = this.findEntry({ artifactId: entry.artifactId, grant, worktree: entry.worktree, session: entry.session }, principal, false, this.now())
    if (isRefusal(grantState)) return grantState
    const approved = entry.approved
    if (!approved) return readOnly()
    if (!sameToken(approved.revision, expectedRevision)) return changed()
    const source = await this.sourceOf(entry.worktree, entry.session)
    if (this.closed) return unavailable()
    if (isRefusal(source)) return source
    const sourceFailure = this.assertCurrentSource(entry, source)
    if (sourceFailure) return sourceFailure

    let opened: OpenFile
    try {
      opened = this.openVerified(entry, true)
    } catch (error) {
      return error instanceof ArtifactFailure ? error.refusal : unavailable()
    }
    try {
      const before = opened.stat
      if (before.size > BigInt(TERMINAL_ARTIFACT_TEXT_BYTES) || Number(before.size) !== approved.size) return changed()
      const original = readAtMost(opened.fd, before.size, TERMINAL_ARTIFACT_TEXT_BYTES + 1)
      if (original.length !== Number(before.size)) return changed()
      const afterRead = this.verifyOpenPath(entry, opened.fd)
      if (!sameStat(before, afterRead) || diskFingerprint(entry.realPath, afterRead, original) !== approved.fingerprint) return changed()

      const currentGrant = this.findEntry({ artifactId: entry.artifactId, grant, worktree: entry.worktree, session: entry.session }, principal, false, this.now())
      if (isRefusal(currentGrant)) return currentGrant
      const currentSource = await this.sourceOf(entry.worktree, entry.session)
      if (isRefusal(currentSource)) return currentSource
      const sourceNowChanged = this.assertCurrentSource(entry, currentSource)
      if (sourceNowChanged) return sourceNowChanged
      const currentGrantAfterSource = this.findEntry({ artifactId: entry.artifactId, grant, worktree: entry.worktree, session: entry.session }, principal, false, this.now())
      if (isRefusal(currentGrantAfterSource)) return currentGrantAfterSource
      if (!entry.approved || !sameToken(entry.approved.revision, expectedRevision)) return changed()
      if (this.closed) return unavailable()
      const boundary = this.verifyOpenPath(entry, opened.fd)
      if (!sameStat(afterRead, boundary)) return changed()

      try {
        let offset = 0
        while (offset < content.length) {
          const count = writeSync(opened.fd, content, offset, content.length - offset, offset)
          if (count <= 0) throw new Error('short artifact write')
          offset += count
        }
        ftruncateSync(opened.fd, content.length)
        fsyncSync(opened.fd)
      } catch {
        return refusal('source-unavailable', 'The save did not complete. Inspect the file before retrying; no successful save was reported.')
      }

      const afterWrite = this.verifyOpenPath(entry, opened.fd)
      const written = readAtMost(opened.fd, afterWrite.size, TERMINAL_ARTIFACT_TEXT_BYTES + 1)
      const finalStat = this.verifyOpenPath(entry, opened.fd)
      if (!sameStat(afterWrite, finalStat) || !written.equals(content) || finalStat.size !== BigInt(content.length)) return changed()
      const finalPathStat = this.verifyOpenPath(entry, opened.fd)
      if (!sameStat(finalStat, finalPathStat)) return changed()
      const revision = token()
      entry.approved = { revision, fingerprint: diskFingerprint(entry.realPath, finalStat, written), size: written.length }
      return { kind: 'saved', artifact: this.artifact(entry), revision }
    } catch (error) {
      return error instanceof ArtifactFailure ? error.refusal : unavailable()
    } finally {
      closeSync(opened.fd)
    }
  }

  private serialize<T extends TerminalArtifactResult>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.fileQueues.get(key) ?? Promise.resolve()
    const operation = previous.then(work, work)
    const settled = operation.then(() => undefined, () => undefined)
    this.fileQueues.set(key, settled)
    return operation.finally(() => {
      if (this.fileQueues.get(key) === settled) this.fileQueues.delete(key)
    })
  }
}
