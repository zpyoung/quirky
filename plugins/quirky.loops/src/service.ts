import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, appendFileSync, statSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { PluginCaller, PluginContext, PluginStore, StoreMigration, StructuredMessage } from '@quirky/protocol'
import { EvidenceEngine } from './evidence'
import { mergeLoopConfig, normalizeLoopConfig, validateLoopAgent } from './config'
import { computePacing } from './pacing'
import { QueueConflictError, QueueItemNotFoundError } from './queue'
import { appendLoopLog, LoopDriver } from './driver'
import { loopMigrations, LoopStore, type LoopRequests } from './store'
import type {
  EvidenceEngineContract,
  IterationDetail,
  LoopConfig,
  LoopConfigPatch,
  LoopCreateInput,
  LoopPreset,
  LoopServiceContract,
  LoopSnapshot,
  LoopTiming,
  PauseReason,
  QueueItem,
  QueueOperation,
} from './types'

const MAX_HISTORY_LIMIT = 1000
const DEFAULT_HISTORY_LIMIT = 200
const SUPPORTED_CREATE_KEYS = ['worktree', 'worktreeId', 'name', 'agent', 'preset', 'queueItems', 'config', 'model', 'options'] as const
const SUPPORTED_PATCH_KEYS = [
  'name', 'promptSource', 'pacing', 'sessionPolicy', 'done', 'caps', 'noProgress', 'protectedPaths',
  'checkpointCommits', 'askBeforeNext', 'resumeAtLimitReset'
] as const

type OpenReadOnlyStore = (
  this: PluginContext,
  migrations: StoreMigration[],
  options: { newerVersion: 'read-only' }
) => PluginStore

type ResolvedWorktree = { id: string; path: string; kind: 'git' | 'folder'; name: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validatePresetConfig(preset: LoopPreset, config: LoopConfig): void {
  if (preset === 'queue') {
    if (config.promptSource.kind !== 'queue') throw new TypeError('queue preset requires a queue prompt source')
    return
  }
  if (config.promptSource.kind !== 'repeat') throw new TypeError(`${preset} preset requires a repeat prompt source`)
  if (preset === 'interval' && config.pacing.kind !== 'interval') {
    throw new TypeError('interval preset requires interval pacing')
  }
  if (preset === 'until-done' && config.pacing.kind !== 'on-idle') {
    throw new TypeError('until-done preset requires on-idle pacing')
  }
}

function queueSeed(preset: LoopPreset, value: unknown): QueueItem[] {
  if (preset !== 'queue') {
    if (value !== undefined) throw new TypeError('queueItems are only supported by the queue preset')
    return []
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('queue preset requires at least one queue item')
  }
  return value.map((entry, position) => {
    if (!isObject(entry) || Object.keys(entry).some((key) => key !== 'body')) {
      throw new TypeError(`queueItems[${position}] must contain only a body`)
    }
    if (typeof entry.body !== 'string' || entry.body.trim() === '') {
      throw new TypeError(`queueItems[${position}].body must be a non-empty string`)
    }
    return { id: randomUUID(), position, body: entry.body, state: 'pending' as const }
  })
}

function slugFor(name: string, id: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'loop'
  return `${base}-${id.slice(0, 8)}`
}

function createOnce(path: string, contents: string): void {
  let descriptor: number
  try {
    descriptor = openSync(path, 'wx', 0o600)
  } catch (error) {
    if (isObject(error) && error.code === 'EEXIST') return
    throw error
  }
  try {
    writeSync(descriptor, contents, undefined, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

function installPrivateExclude(cwd: string): void {
  const raw = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  if (raw === '') throw new Error('git did not return a private info/exclude path')
  const exclude = isAbsolute(raw) ? raw : resolve(cwd, raw)
  mkdirSync(dirname(exclude), { recursive: true, mode: 0o700 })
  const contents = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  const hasEntry = contents.split(/\r?\n/).some((line) => line.trim() === '/.quirky/loops/')
  if (!hasEntry) appendFileSync(exclude, `${contents !== '' && !contents.endsWith('\n') ? '\n' : ''}/.quirky/loops/\n`, { encoding: 'utf8', mode: 0o600 })
}

function createLoopFiles(cwd: string, slug: string, workspaceKind: 'git' | 'folder'): string {
  const directory = join(cwd, '.quirky', 'loops', slug)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const notesPath = join(directory, 'notes.md')
  createOnce(notesPath, 'Notes for this loop. Edit freely; the loop does not rewrite this file.\n')
  createOnce(join(directory, 'log.md'), '')
  if (workspaceKind === 'git') installPrivateExclude(cwd)
  return notesPath
}

function resolveWorktreeRecord(value: unknown): ResolvedWorktree {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.path !== 'string' ||
    (value.kind !== 'git' && value.kind !== 'folder') || typeof value.name !== 'string') {
    throw new Error('worktree/show returned an invalid worktree')
  }
  return { id: value.id, path: value.path, kind: value.kind, name: value.name }
}

function validateOptions(value: unknown): Record<string, string | boolean> | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new TypeError('options must be an object')
  const options: Record<string, string | boolean> = {}
  for (const [key, option] of Object.entries(value)) {
    if (key.trim() === '' || (typeof option !== 'string' && typeof option !== 'boolean')) {
      throw new TypeError('options must contain only named string or boolean values')
    }
    options[key] = option
  }
  return options
}

function validateModel(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('model must be a non-empty string')
  return value
}

function emptyRequests(): LoopRequests {
  return { pause: false, stop: false, stopNow: false, needsResume: false, resumeNative: false }
}

function ended(loop: LoopSnapshot): boolean {
  return loop.state === 'completed' || loop.state === 'stopped'
}

function cloneSnapshot(snapshot: LoopSnapshot): LoopSnapshot {
  return structuredClone(snapshot)
}

export class LoopService implements LoopServiceContract {
  private readonly store: LoopStore
  private readonly evidence: EvidenceEngineContract
  private readonly timing?: LoopTiming
  private readonly drivers = new Map<string, LoopDriver>()
  private unsubscribe: (() => void) | null = null
  private started = false
  private startPromise: Promise<void> | null = null
  private active = true

  constructor(private readonly context: PluginContext, timing?: LoopTiming) {
    this.timing = timing
    const openStore = context.openStore as OpenReadOnlyStore
    const pluginStore = openStore.call(context, loopMigrations(), { newerVersion: 'read-only' })
    this.store = new LoopStore(pluginStore)
    this.evidence = new EvidenceEngine(context)
  }

  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise
    this.startPromise = this.recover().catch((error) => {
      this.started = false
      this.unsubscribe?.()
      this.unsubscribe = null
      this.startPromise = null
      throw error
    })
    return this.startPromise
  }

  private async recover(): Promise<void> {
    if (this.started) return
    if (!this.active) throw this.context.error('conflict', 'The loops service is shutting down.')
    this.started = true
    this.unsubscribe = this.context.subscribe((event) => this.observe(event))
    if (this.store.readOnly) return

    this.store.pruneEndedAttempts()
    const loops = this.store.listLoops()
    for (const previous of loops) {
      if (previous.state !== 'running' && previous.state !== 'needs-you') continue
      const snapshot = cloneSnapshot(previous)
      snapshot.state = 'paused'
      snapshot.pauseReason = 'interrupted-by-restart'
      snapshot.pauseDetail = null
      snapshot.phase = null
      snapshot.updatedAt = this.now()
      const attempt = this.store.unfinishedAttempt(snapshot.id)
      const requests = emptyRequests()
      let current: LoopSnapshot
      if (attempt) {
        attempt.endedAt = this.now()
        attempt.endReason = 'interrupted'
        attempt.error = 'daemon restarted during this iteration'
        current = this.store.saveEndedAttempt(
          snapshot,
          attempt,
          attempt.queueItemId ?? null,
          computePacing({
            pacing: attempt.pacingConfig ?? snapshot.config.pacing,
            createdAt: snapshot.createdAt,
            iterationStartedAt: attempt.startedAt,
            iterationEndedAt: attempt.endedAt,
          }).skippedTicks,
          requests
        )
        appendLoopLog(this.context, attempt, current)
      } else {
        this.store.saveLoop(snapshot, requests)
        current = this.store.getLoop(snapshot.id) ?? snapshot
      }
      this.publish(previous, current)
    }
  }

  private now(): number {
    return this.timing?.now?.() ?? Date.now()
  }

  private requireActive(): void {
    if (!this.active) throw this.context.error('conflict', 'The loops service is shutting down.')
  }

  private requireWritable(): void {
    this.requireActive()
    if (this.store.readOnly) {
      const error = this.context.error('conflict', 'The loop store is read-only.')
      Object.assign(error, { data: { reason: 'loop_store_read_only' } })
      throw error
    }
  }

  private observe(event: { type: string; data?: unknown }): void {
    if (!this.active) return
    const data = isObject(event.data) ? event.data : {}
    if (event.type === 'quirky.structured/message') {
      const message = isObject(data.message) ? data.message : null
      if (message && typeof message.sessionId === 'string' && typeof message.seq === 'number' &&
        Number.isInteger(message.seq) && message.seq > 0 &&
        (message.role === 'user' || message.role === 'assistant' || message.role === 'tool' || message.role === 'system' || message.role === 'result') &&
        typeof message.text === 'string' && typeof message.at === 'number' && Number.isFinite(message.at)) {
        const structuredMessage = message as unknown as StructuredMessage
        for (const driver of this.drivers.values()) driver.observeMessage(structuredMessage)
      }
    }
    if (event.type === 'quirky.structured/settled' && typeof data.sessionId === 'string' && typeof data.at === 'number') {
      for (const driver of this.drivers.values()) driver.observeSettled(data.sessionId, data.at)
    }
    if (event.type === 'quirky.ask/created' || event.type === 'quirky.ask/resolved' || event.type === 'quirky.session/changed') {
      for (const driver of this.drivers.values()) driver.wake()
    }
  }

  private publish(previous: LoopSnapshot | null, current: LoopSnapshot): void {
    this.context.emit('changed', current)
    if (previous === null || (previous.state === current.state && previous.pauseReason === current.pauseReason)) return
    let event: 'completed' | 'paused' | 'cap' | 'needs-you' | null = null
    if (current.state === 'completed') event = 'completed'
    else if (current.state === 'needs-you') event = 'needs-you'
    else if (current.state === 'paused' && current.pauseReason !== 'user' && current.pauseReason !== 'interrupted-by-restart') {
      event = current.pauseReason?.startsWith('cap-') ? 'cap' : 'paused'
    }
    if (event === null) return
    const notification: {
      loopId: string; name: string; event: 'completed' | 'paused' | 'cap' | 'needs-you';
      reason?: PauseReason; detail?: string; sessionId?: string; worktreeId: string
    } = { loopId: current.id, name: current.name, event, worktreeId: current.worktreeId }
    if (current.pauseReason !== null) notification.reason = current.pauseReason
    if (current.pauseDetail !== null) notification.detail = current.pauseDetail
    if (current.sessionId !== null) notification.sessionId = current.sessionId
    this.context.emit('notification', notification)
  }

  private async resolveWorktree(selector: string): Promise<ResolvedWorktree> {
    const result = await this.context.call('quirky.worktree/show', { worktree: selector })
    return resolveWorktreeRecord(result)
  }

  private async selectorFor(input: LoopCreateInput, caller?: PluginCaller): Promise<string> {
    if (input.worktree !== undefined && input.worktreeId !== undefined) {
      throw this.context.error('invalid-params', 'worktree and worktreeId cannot both be supplied')
    }
    if (input.worktree !== undefined) {
      if (typeof input.worktree !== 'string' || input.worktree.trim() === '') throw this.context.error('invalid-params', 'worktree must be a non-empty selector')
      if (input.worktree === 'current') {
        if (caller && caller.role !== 'plugin' && caller.worktreeId) return `id:${caller.worktreeId}`
        if (caller && caller.role !== 'plugin' && caller.cwd) return `path:${caller.cwd}`
        throw this.context.error('invalid-params', 'current worktree requires a client worktree or cwd')
      }
      return input.worktree
    }
    if (input.worktreeId !== undefined) {
      if (typeof input.worktreeId !== 'string' || input.worktreeId.trim() === '') throw this.context.error('invalid-params', 'worktreeId must be a non-empty ID')
      return `id:${input.worktreeId}`
    }
    if (caller && caller.role !== 'plugin' && caller.worktreeId) return `id:${caller.worktreeId}`
    if (caller && caller.role !== 'plugin' && caller.cwd) return `path:${caller.cwd}`
    throw this.context.error('invalid-params', 'worktree is required when the caller has no current workspace')
  }

  async create(input: LoopCreateInput, caller?: PluginCaller): Promise<LoopSnapshot> {
    await this.start()
    this.requireWritable()
    if (!isObject(input)) throw this.context.error('invalid-params', 'loop input must be an object')
    const unsupported = Object.keys(input).find((key) => !SUPPORTED_CREATE_KEYS.includes(key as (typeof SUPPORTED_CREATE_KEYS)[number]))
    if (unsupported !== undefined) throw this.context.error('invalid-params', `unsupported loop field ${unsupported}`)

    let preset: LoopPreset
    let config: LoopConfig
    let queueItems: QueueItem[]
    let model: string | undefined
    let options: Record<string, string | boolean> | undefined
    try {
      validateLoopAgent(input.agent)
      const requestedPreset = input.preset ?? 'until-done'
      if (requestedPreset !== 'until-done' && requestedPreset !== 'queue' && requestedPreset !== 'interval') {
        throw new TypeError('preset must be until-done, queue, or interval')
      }
      preset = requestedPreset
      config = normalizeLoopConfig(input.config, preset)
      validatePresetConfig(preset, config)
      queueItems = queueSeed(preset, input.queueItems)
      model = validateModel(input.model)
      options = validateOptions(input.options)
    } catch (error) {
      throw this.context.error('invalid-params', errorMessage(error))
    }

    const selector = await this.selectorFor(input, caller)
    const worktree = await this.resolveWorktree(selector)
    try {
      if (!statSync(worktree.path).isDirectory()) throw new Error('worktree path is not a directory')
    } catch (error) {
      throw this.context.error('conflict', `worktree ${worktree.id} is unavailable: ${errorMessage(error)}`)
    }

    const name = input.name === undefined ? `${input.agent} ${preset}` : input.name
    if (typeof name !== 'string' || name.trim() === '') throw this.context.error('invalid-params', 'name must be a non-empty string')
    const id = randomUUID()
    const slug = slugFor(name.trim(), id)
    await this.evidence.validate(input.agent, config, worktree.path)
    let notesPath: string
    try {
      notesPath = createLoopFiles(worktree.path, slug, worktree.kind)
    } catch (error) {
      throw this.context.error('conflict', `could not prepare loop notes and private git exclusion: ${errorMessage(error)}`)
    }

    const warning = this.store.listLoops(worktree.id).some((loop) => loop.state === 'running' || loop.state === 'needs-you')
    const now = this.now()
    const snapshot: LoopSnapshot = {
      id,
      name: name.trim(),
      slug,
      worktreeId: worktree.id,
      cwd: worktree.path,
      workspaceKind: worktree.kind,
      agent: input.agent,
      preset,
      config,
      state: 'running',
      pauseReason: null,
      pauseDetail: null,
      sessionId: null,
      iterationsCompleted: 0,
      activeMs: 0,
      costUsd: null,
      phase: null,
      nextIterationAt: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      notesPath,
      warnings: warning ? ['worktree-has-running-loop'] : [],
      recentIterations: [],
      queueItems,
      skippedTicks: 0,
      ...(model === undefined ? {} : { model }),
      ...(options === undefined ? {} : { options })
    }
    this.store.createLoop(snapshot, emptyRequests(), queueItems)
    const persisted = this.store.getLoop(id) ?? snapshot
    this.publish(null, persisted)
    this.startDriver(id)
    return persisted
  }

  async list(params: { worktreeId?: string; worktree?: string } = {}): Promise<LoopSnapshot[]> {
    await this.start()
    this.requireActive()
    if (!isObject(params)) throw this.context.error('invalid-params', 'list params must be an object')
    if (params.worktreeId !== undefined && params.worktree !== undefined) {
      throw this.context.error('invalid-params', 'worktreeId and worktree cannot both be supplied')
    }
    let worktreeId = params.worktreeId
    if (worktreeId !== undefined && (typeof worktreeId !== 'string' || worktreeId.trim() === '')) {
      throw this.context.error('invalid-params', 'worktreeId must be a non-empty string')
    }
    if (params.worktree !== undefined) {
      if (typeof params.worktree !== 'string' || params.worktree.trim() === '') throw this.context.error('invalid-params', 'worktree must be a non-empty selector')
      worktreeId = (await this.resolveWorktree(params.worktree)).id
    }
    return this.store.listLoops(worktreeId)
  }

  get(loopId: string): LoopSnapshot {
    this.requireActive()
    if (typeof loopId !== 'string' || loopId.trim() === '') throw this.context.error('invalid-params', 'loopId must be a non-empty string')
    const loop = this.store.getLoop(loopId)
    if (!loop) throw this.context.error('not-found', `Loop ${loopId} was not found`)
    return loop
  }

  iterations(loopId: string, limit?: number) {
    this.requireActive()
    const loop = this.store.getLoop(loopId)
    if (!loop) throw this.context.error('not-found', `Loop ${loopId} was not found`)
    if (limit !== undefined && (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1)) {
      throw this.context.error('invalid-params', 'limit must be a finite integer of at least 1')
    }
    return this.store.iterations(loopId, Math.min(limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT))
  }

  async pause(loopId: string): Promise<LoopSnapshot> {
    await this.start()
    this.requireWritable()
    const previous = this.get(loopId)
    if (previous.state === 'paused') return previous
    if (ended(previous)) throw this.context.error('conflict', `Loop ${loopId} has already ended`)
    if (this.store.unfinishedAttempt(loopId) === null) {
      const snapshot = cloneSnapshot(previous)
      snapshot.state = 'paused'
      snapshot.pauseReason = 'user'
      snapshot.pauseDetail = null
      snapshot.phase = null
      snapshot.updatedAt = this.now()
      this.store.saveLoop(snapshot, emptyRequests())
      const current = this.store.getLoop(loopId) ?? snapshot
      this.publish(previous, current)
      this.drivers.get(loopId)?.wake()
      return current
    }
    this.store.saveRequests(loopId, { pause: true, stop: false, stopNow: false, needsResume: false, resumeNative: false })
    this.drivers.get(loopId)?.wake()
    return this.get(loopId)
  }

  async resume(loopId: string, addIterations?: number): Promise<LoopSnapshot> {
    await this.start()
    this.requireWritable()
    let previous = this.get(loopId)
    if (previous.state !== 'paused') throw this.context.error('conflict', `Loop ${loopId} is ${previous.state}, not paused`)
    if (addIterations !== undefined && (!Number.isFinite(addIterations) || !Number.isInteger(addIterations) || addIterations < 1)) {
      throw this.context.error('invalid-params', 'addIterations must be a finite integer of at least 1')
    }
    const existingDriver = this.drivers.get(loopId)
    if (existingDriver) await existingDriver.waitForFinish()
    previous = this.get(loopId)
    if (previous.state !== 'paused') throw this.context.error('conflict', `Loop ${loopId} is ${previous.state}, not paused`)
    const storedRequests = this.store.requests(loopId)
    const snapshot = cloneSnapshot(previous)
    if (addIterations !== undefined) {
      const currentCap = snapshot.config.caps.maxIterations ?? 0
      snapshot.config = {
        ...snapshot.config,
        caps: { ...snapshot.config.caps, maxIterations: Math.max(currentCap, snapshot.iterationsCompleted) + addIterations }
      }
    }
    snapshot.state = 'running'
    snapshot.pauseReason = null
    snapshot.pauseDetail = null
    snapshot.phase = 'waiting'
    snapshot.endedAt = null
    snapshot.updatedAt = this.now()
    this.store.saveLoop(snapshot, {
      pause: false,
      stop: false,
      stopNow: false,
      needsResume: true,
      resumeNative: previous.pauseReason === 'interrupted-by-restart' || storedRequests.resumeNative
    })
    const current = this.store.getLoop(loopId) ?? snapshot
    this.publish(previous, current)
    this.startDriver(loopId)
    return current
  }

  async stop(loopId: string, now = false): Promise<LoopSnapshot> {
    await this.start()
    this.requireWritable()
    if (typeof now !== 'boolean') throw this.context.error('invalid-params', 'now must be a boolean')
    const previous = this.get(loopId)
    if (ended(previous)) throw this.context.error('conflict', `Loop ${loopId} has already ended`)
    const unfinished = this.store.unfinishedAttempt(loopId)
    const driver = this.drivers.get(loopId)
    if (!now && previous.state !== 'paused' && unfinished !== null && driver !== undefined) {
      this.store.saveRequests(loopId, { pause: false, stop: true, stopNow: false, needsResume: false, resumeNative: false })
      driver?.wake()
      return this.get(loopId)
    }
    if (now && driver) {
      this.store.saveRequests(loopId, { pause: false, stop: false, stopNow: true, needsResume: false, resumeNative: false })
      await driver.stopNow()
      return this.store.getLoop(loopId) ?? this.finishStopped(this.get(loopId), this.store.unfinishedAttempt(loopId))
    }
    if (unfinished !== null) await this.evidence.cancel(loopId).catch(() => undefined)
    const stopped = this.finishStopped(previous, unfinished)
    this.drivers.get(loopId)?.wake()
    await this.stopSession(previous.sessionId)
    await this.closeSession(loopId, previous.sessionId)
    return stopped
  }

  async steer(loopId: string, text: string): Promise<LoopSnapshot> {
    await this.start()
    this.requireWritable()
    const loop = this.get(loopId)
    if (ended(loop)) throw this.context.error('conflict', `Loop ${loopId} has already ended`)
    if (typeof text !== 'string' || text.trim() === '') throw this.context.error('invalid-params', 'steer text must be a non-empty string')
    this.store.addSteerNote(loopId, text.trim(), this.now())
    this.drivers.get(loopId)?.wake()
    return this.get(loopId)
  }

  async edit(loopId: string, patch: LoopConfigPatch & { name?: string }): Promise<LoopSnapshot> {
    await this.start()
    this.requireWritable()
    const previous = this.get(loopId)
    if (ended(previous)) throw this.context.error('conflict', `Loop ${loopId} has already ended`)
    if (!isObject(patch)) throw this.context.error('invalid-params', 'edit patch must be an object')
    const supplied = Object.keys(patch)
    if (supplied.length === 0) throw this.context.error('invalid-params', 'edit patch must change at least one setting')
    const unsupported = supplied.find((key) => !SUPPORTED_PATCH_KEYS.includes(key as (typeof SUPPORTED_PATCH_KEYS)[number]))
    if (unsupported !== undefined) throw this.context.error('invalid-params', `unsupported loop setting ${unsupported}`)
    if (Object.hasOwn(patch, 'name') && (typeof patch.name !== 'string' || patch.name.trim() === '')) {
      throw this.context.error('invalid-params', 'name must be a non-empty string')
    }
    const configPatch: Record<string, unknown> = { ...patch }
    delete configPatch.name
    let config = previous.config
    if (Object.keys(configPatch).length > 0) {
      try {
        config = mergeLoopConfig(previous.config, configPatch as LoopConfigPatch)
        validatePresetConfig(previous.preset, config)
      } catch (error) {
        throw this.context.error('invalid-params', errorMessage(error))
      }
    }
    if (Object.hasOwn(patch, 'done')) await this.evidence.validate(previous.agent, config, previous.cwd)
    const snapshot = cloneSnapshot(previous)
    snapshot.config = config
    if (typeof patch.name === 'string') {
      snapshot.name = patch.name.trim()
    }
    if (Object.hasOwn(configPatch, 'pacing')) {
      const latest = this.store.latestAttempt(loopId)
      if (latest?.endReason === 'settled' && latest.endedAt !== null) {
        snapshot.nextIterationAt = computePacing({
          pacing: config.pacing,
          createdAt: snapshot.createdAt,
          iterationStartedAt: latest.startedAt,
          iterationEndedAt: latest.endedAt,
        }).nextIterationAt
      }
    }
    snapshot.updatedAt = this.now()
    this.store.saveLoop(snapshot)
    const current = this.store.getLoop(loopId) ?? snapshot
    this.publish(previous, current)
    this.drivers.get(loopId)?.wake()
    return current
  }

  async queue(loopId: string, op: QueueOperation): Promise<LoopSnapshot> {
    await this.start()
    this.requireWritable()
    const previous = this.get(loopId)
    if (ended(previous)) throw this.context.error('conflict', `Loop ${loopId} has already ended`)
    if (previous.preset !== 'queue') throw this.context.error('invalid-params', 'queue operations require a queue preset')

    try {
      this.store.mutateQueue(loopId, op, this.now())
    } catch (error) {
      if (error instanceof QueueItemNotFoundError) throw this.context.error('not-found', error.message)
      if (error instanceof QueueConflictError) throw this.context.error('conflict', error.message)
      if (error instanceof TypeError) throw this.context.error('invalid-params', error.message)
      throw error
    }

    const current = this.get(loopId)
    this.publish(previous, current)
    this.drivers.get(loopId)?.wake()
    return current
  }

  private startDriver(loopId: string): void {
    if (this.store.readOnly || !this.active) return
    const existing = this.drivers.get(loopId)
    if (existing) {
      existing.wake()
      return
    }
    const driver = new LoopDriver({
      context: this.context,
      store: this.store,
      evidence: this.evidence,
      loopId,
      timing: this.timing,
      hooks: {
        publish: (previous, current) => this.publish(previous, current),
        finished: (finished) => {
          if (this.drivers.get(loopId) !== finished) return
          this.drivers.delete(loopId)
          if (this.active && this.store.getLoop(loopId)?.state === 'running') queueMicrotask(() => this.startDriver(loopId))
        }
      }
    })
    this.drivers.set(loopId, driver)
    driver.start()
  }

  private async stopSession(sessionId: string | null): Promise<void> {
    if (sessionId === null) return
    try {
      await this.context.call('quirky.structured/stop', { session: sessionId })
    } catch (error) {
      this.context.log(`could not stop loop session ${sessionId}: ${errorMessage(error)}`)
    }
  }
  private async closeSession(loopId: string, sessionId: string | null): Promise<void> {
    if (sessionId === null) return
    try {
      await this.context.call('quirky.session/close', { session: sessionId })
      this.store.forgetOwnedMessages(loopId, sessionId)
    } catch (error) {
      this.context.log(`could not close loop session ${sessionId}: ${errorMessage(error)}`)
    }
  }

  private finishStopped(previous: LoopSnapshot, attempt: IterationDetail | null): LoopSnapshot {
    const snapshot = cloneSnapshot(previous)
    snapshot.state = 'stopped'
    snapshot.pauseReason = null
    snapshot.pauseDetail = null
    snapshot.phase = null
    snapshot.nextIterationAt = null
    snapshot.endedAt = this.now()
    snapshot.updatedAt = snapshot.endedAt
    if (attempt) {
      attempt.endedAt = snapshot.endedAt
      attempt.endReason = 'stopped'
      if (attempt.promptSent === '') attempt.error = 'stopped before prompt delivery'
      else delete attempt.error
    }
    const requests = emptyRequests()
    let current: LoopSnapshot
    if (attempt) {
      current = this.store.saveEndedAttempt(
        snapshot,
        attempt,
        attempt.queueItemId ?? null,
        computePacing({
          pacing: attempt.pacingConfig ?? snapshot.config.pacing,
          createdAt: snapshot.createdAt,
          iterationStartedAt: attempt.startedAt,
          iterationEndedAt: attempt.endedAt,
        }).skippedTicks,
        requests
      )
    } else {
      this.store.saveLoop(snapshot, requests)
      current = this.store.getLoop(snapshot.id) ?? snapshot
    }
    this.store.pruneEndedAttempts()
    this.publish(previous, current)
    return current
  }
  async shutdown(): Promise<void> {
    if (!this.active) return
    this.active = false
    this.unsubscribe?.()
    this.unsubscribe = null
    if (!this.store.readOnly) {
      for (const loop of this.store.listLoops()) {
        if (loop.sessionId === null || loop.config.sessionPolicy !== 'continue' || ended(loop)) continue
        try {
          const requests = this.store.requests(loop.id)
          this.store.saveRequests(loop.id, { ...requests, resumeNative: true })
        } catch (error) {
          this.context.log(`could not preserve loop session ${loop.sessionId} for native resume: ${errorMessage(error)}`)
        }
      }
    }
    const drivers = [...this.drivers.values()]
    await Promise.allSettled(drivers.map((driver) => driver.shutdown()))
    this.drivers.clear()
    if (!this.store.readOnly) {
      const openLoops = this.store.listLoops().filter((loop) => loop.sessionId !== null && !ended(loop))
      await Promise.allSettled(openLoops.map(async (loop) => {
        const sessionId = loop.sessionId
        if (sessionId === null) return
        await this.stopSession(sessionId)
        if (loop.config.sessionPolicy === 'fresh') await this.closeSession(loop.id, sessionId)
      }))
    }
    await this.evidence.shutdown().catch((error: unknown) => this.context.log(`loop evidence shutdown failed: ${errorMessage(error)}`))
  }
}
