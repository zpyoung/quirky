import { homedir } from 'node:os'
import { isReservedLaunchEnv, type ContributionInfo, type PluginCaller, type PluginContext, type QuirkyEvent } from '@quirky/protocol'
import { buildCatalog } from './core/catalog'
import { extrasSummary, parseExtraArgs } from './core/extras'
import { agentPermissionMode, applyPermissionMode, effectiveArgs, effectiveEnv, PermissionError, permissionSummary } from './core/permissions'
import { resolveLaunch } from './core/resolve'
import { pickAgent } from './core/select'
import { SelectionError, validateSelection } from './core/selection'
import { buildLaunchPlan, buildResumePlan, PlanError, userSettingsForLaunch, userSettingsForResume } from './core/plan'
import { SettingsError } from './core/settings'
import { joinCommand, tokenize } from './core/shell'
import {
  EMPTY_CONFIG,
  type AgentConfig,
  type AgentEntry,
  type AgentInfo,
  type AgentListing,
  type Catalog,
  type DeliveryOutcome,
  type LaunchPlan,
  type LaunchRecord,
  type OptionDecl,
  type OptionUse,
  type ParsedExtras,
  type PermissionSummary,
  type ProviderSession,
  type Resolution,
  type ValidSelection
} from './core/types'
import { DeliveryRunner } from './delivery'
import { detect, readLoginPath, searchDirs, type Detection, type SearchDirs } from './detect'
import { Generator } from './generate'
import { sameConfig, type AgentConfigStore } from './store'
import { writeTrust } from './trust'

type Params = Record<string, unknown>
type Env = Record<string, string | null>
type Resettable = 'command' | 'args' | 'env'

type OptionInfo = { id: string; label: string; type: 'select' | 'boolean'; choices: { value: string; label: string }[] | null }

/** What `quirky.agents/options` reports for one agent. */
type OptionsInfo = {
  agent: string
  label: string
  supported: boolean
  models: { id: string; label: string; description: string | null; options: OptionInfo[] }[]
  unlisted: 'accept' | 'refuse'
  unlistedOptions: OptionInfo[]
  structured: boolean
  extraArgs: ReturnType<typeof extrasSummary>
}

/** What `quirky.agents/resolveLaunch` reports: the pick's effect on the launch, `args` shell-quoted. */
type ResolvedLaunch = Omit<Resolution, 'args'> & { args: string }

const SETTING_PREFIX = 'setting:quirky.agents/'
const DEFAULT_SETTING = 'default-agent'
const TRUST_SETTING = 'workspace-trust'

/** The user's home, read at call time; `$HOME` first because Bun's `os.homedir()` ignores a changed `$HOME`. */
const userHome = () => process.env.HOME || homedir()

/** Reads `QUIRKY_TEST_AGENT_TIME_SCALE`; anything but a positive number means real time. */
function timeScaleFromEnv(): number {
  const scale = Number(process.env.QUIRKY_TEST_AGENT_TIME_SCALE)
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

/** An option as a model offers it: the declared choices narrowed to the model's subset. */
function optionInfo(decls: OptionDecl[], use: OptionUse): OptionInfo {
  const decl = decls.find((candidate) => candidate.id === use.id)!
  const choices = decl.choices && (use.choices ? decl.choices.filter((choice) => use.choices!.includes(choice.value)) : decl.choices)
  return { id: decl.id, label: decl.label, type: decl.type, choices: choices ? choices.map(({ value, label }) => ({ value, label })) : null }
}

function optionsInfo(entry: AgentEntry): OptionsInfo {
  const catalog = entry.launchOptions
  const info = (uses: OptionUse[]) => uses.map((use) => optionInfo(catalog!.options, use))
  return {
    agent: entry.id,
    label: entry.label,
    supported: catalog !== null,
    models: catalog ? catalog.models.map((model) => ({ id: model.id, label: model.label, description: model.description, options: info(model.options) })) : [],
    unlisted: catalog?.unlisted ?? 'refuse',
    unlistedOptions: catalog ? info(catalog.unlistedOptions) : [],
    structured: catalog?.model.structured != null,
    extraArgs: extrasSummary(entry)
  }
}

/**
 * The `quirky.agents` methods: the catalog and its detection, the user's saved configuration, and
 * the launch and resume plans `quirky.session` spawns from. Plan and permission rules live in
 * `core/`; this class holds the state and maps their failures to RPC errors.
 */
export class AgentsService {
  private catalog: Catalog = { agents: [], problems: [] }
  private detection: Detection = detect([], { dirs: [], loginDirs: new Set() })
  private search: SearchDirs = { dirs: [], loginDirs: new Set() }
  private readonly runner: DeliveryRunner
  private readonly generator: Generator
  private readonly goneListeners = new Set<(sessionId: string) => void>()
  private readonly reportedProblems = new Set<string>()
  private known: { default: unknown; trust: unknown }
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly context: PluginContext,
    private readonly configs: AgentConfigStore
  ) {
    this.runner = new DeliveryRunner({
      pty: context.pty,
      onSessionGone: (listener) => {
        this.goneListeners.add(listener)
        return () => this.goneListeners.delete(listener)
      },
      timeScale: timeScaleFromEnv(),
      log: (message) => context.log(message)
    })
    this.generator = new Generator({
      context,
      entryOf: (id) => this.catalog.agents.find((entry) => entry.id === id),
      configOf: (id) => this.configs.get(id),
      installed: (id) => this.detection.installed(id),
      resolveExecutable: (name) => this.detection.resolveExecutable(name)
    })
    this.known = { default: context.getSetting(DEFAULT_SETTING), trust: context.getSetting(TRUST_SETTING) }
  }

  /** Builds the catalog, detects installed agents and starts following kernel events. */
  async start(): Promise<void> {
    this.context.subscribe((event) => this.onEvent(event))
    await this.enqueue(async () => {
      await this.rebuildCatalog()
      await this.detectInstalled()
    })
  }

  list = (params: Params): AgentListing => this.listing(params.all === true)

  get = (params: Params): AgentInfo => this.info(this.entryOf(params.agent as string))

  refresh = (): Promise<AgentListing> =>
    this.enqueue(async () => {
      await this.detectInstalled()
      this.changed()
      return this.listing(false)
    })

  setEnabled = async (params: Params): Promise<AgentInfo> => {
    const entry = this.entryOf(params.agent as string)
    const enabled = params.enabled as boolean
    const config = this.configs.get(entry.id)
    const flips = config.disabled === enabled
    if (flips) this.configs.put(entry.id, { ...config, disabled: !enabled })
    const resetsDefault = !enabled && this.defaultAgent() === entry.id
    if (resetsDefault) await this.writeSetting(DEFAULT_SETTING, 'auto')
    if (flips || resetsDefault) this.changed()
    return this.info(entry)
  }

  setDefault = async (params: Params): Promise<AgentListing> => {
    const value = params.agent as string
    if (value !== 'auto' && value !== 'shell') {
      const entry = this.entryOf(value, 'invalid-params')
      if (this.configs.get(entry.id).disabled) throw this.context.error('invalid-params', `agent ${entry.id} is disabled`)
    }
    const before = this.defaultAgent()
    if (this.context.getSetting(DEFAULT_SETTING) !== value) await this.writeSetting(DEFAULT_SETTING, value)
    if (this.defaultAgent() !== before) this.changed()
    return this.listing(false)
  }

  configure = (params: Params): AgentInfo => {
    const entry = this.entryOf(params.agent as string)
    const before = this.configs.get(entry.id)
    const next: AgentConfig = { ...before }
    for (const field of (params.reset as Resettable[] | undefined) ?? []) {
      if (field === 'command') next.command = null
      else if (field === 'args') next.args = null
      else next.env = null
    }
    if (params.command !== undefined) next.command = this.commandOverride(entry, params.command as string)
    if (params.args !== undefined) next.args = this.argsOverride(params.args as string)
    if (params.env !== undefined) next.env = this.envOverride(params.env as Record<string, unknown>)
    if (!sameConfig(before, next)) {
      this.configs.put(entry.id, next)
      this.changed()
    }
    return this.info(entry)
  }

  setPermissions = (params: Params): { summary: PermissionSummary; changed: string[] } => {
    const entries = this.catalog.agents
    const configs = this.configs.all()
    let applied: ReturnType<typeof applyPermissionMode>
    try {
      applied = applyPermissionMode(entries, configs, {
        mode: params.mode as 'manual' | 'auto' | 'yolo',
        ...(params.agent === undefined ? {} : { agent: params.agent as string }),
        ...(params.replaceCustom === undefined ? {} : { replaceCustom: params.replaceCustom as boolean })
      })
    } catch (error) {
      if (error instanceof PermissionError) {
        throw this.context.error(error.message.startsWith('unknown agent:') ? 'not-found' : 'invalid-params', error.message)
      }
      throw error
    }
    for (const id of applied.changed) this.configs.put(id, applied.configs.get(id) as AgentConfig)
    if (applied.changed.length > 0) this.changed()
    return { summary: permissionSummary(entries, applied.configs).summary, changed: applied.changed }
  }

  /** The models and options an agent offers at launch, and the extra arguments it accepts. */
  options = (params: Params): OptionsInfo => optionsInfo(this.entryOf(params.agent as string))

  /**
   * Previews what a pick and extra arguments add to the agent's launch under its saved
   * configuration. Starts nothing, writes no trust record and emits no event, so it also
   * resolves for a disabled agent.
   */
  resolveLaunch = (params: Params): ResolvedLaunch => {
    const entry = this.entryOf(params.agent as string)
    const config = this.configs.get(entry.id)
    const structured = params.structured === true
    return this.guard(() => {
      const { selection, extras } = this.picks(entry, params)
      const resolution = resolveLaunch({
        entry,
        commandTokens: config.command === null || config.command.trim() === '' ? [] : this.commandTokens(config.command),
        configuredArgs: this.configuredArgs(entry, config),
        selection,
        extras,
        structured
      })
      return { ...resolution, args: structured ? '' : joinCommand(resolution.args) }
    })
  }

  plan = (params: Params): LaunchPlan => {
    const entry = this.entryOf(params.agent as string)
    return this.guard(() =>
      buildLaunchPlan({
        entry,
        config: this.configs.get(entry.id),
        ...this.picks(entry, params),
        ...(params.prompt === undefined ? {} : { prompt: params.prompt as string }),
        ...(params.submitPrompt === undefined ? {} : { submitPrompt: params.submitPrompt as boolean })
      })
    )
  }

  pick = (params: Params): { agent: string } => {
    const forAgentTab = params.forAgentTab === true
    const configs = this.configs.all()
    const installed = (id: string) => this.detection.installed(id)
    const disabled = (id: string) => configs.get(id)?.disabled === true
    const requested = params.preferred as string | undefined
    const requestedUsable =
      requested === 'auto' ||
      requested === 'shell' ||
      (requested !== undefined && this.catalog.agents.some((entry) => entry.id === requested) && installed(requested) && !disabled(requested))
    const agent = pickAgent({
      entries: this.catalog.agents,
      installed,
      disabled,
      preferred: requested !== undefined && requestedUsable ? requested : this.defaultAgent(),
      forAgentTab
    })
    if (agent === null) throw this.context.error('conflict', 'No installed agent is enabled.')
    return { agent }
  }

  /** Projects user CLI settings from the current create arguments or a supplied replay record. */
  settingsOverlay = (params: Params): { settings: Record<string, unknown> } => {
    const entry = this.entryOf(params.agent as string)
    const cwd = params.cwd
    if (typeof cwd !== 'string') throw this.context.error('invalid-params', 'cwd must be a string')

    return this.guard(() => {
      if (params.record !== undefined) {
        return {
          settings: userSettingsForResume({
            entry,
            record: params.record as LaunchRecord | null,
            cwd,
            resolveExecutable: (name) => this.detection.resolveExecutable(name)
          })
        }
      }
      return {
        settings: userSettingsForLaunch({
          entry,
          config: this.configs.get(entry.id),
          ...this.picks(entry, params),
          cwd,
          resolveExecutable: (name) => this.detection.resolveExecutable(name)
        })
      }
    })
  }

  prepareLaunch = (params: Params): LaunchPlan => {
    const entry = this.entryOf(params.agent as string)
    const config = this.configs.get(entry.id)
    if (config.disabled) throw this.context.error('invalid-params', `agent ${entry.id} is disabled`)
    const plan = this.guard(() =>
      buildLaunchPlan({
        entry,
        config,
        cwd: params.cwd as string,
        ...(params.prompt === undefined ? {} : { prompt: params.prompt as string }),
        ...(params.submitPrompt === undefined ? {} : { submitPrompt: params.submitPrompt as boolean }),
        ...this.picks(entry, params),
        hookArgs: (params.hookArgs as string[] | undefined) ?? [],
        hookEnv: (params.hookEnv as Env | undefined) ?? {},
        resolveExecutable: (name) => this.detection.resolveExecutable(name)
      })
    )
    this.trustFolder(entry, params.cwd as string)
    return plan
  }

  prepareResume = (params: Params): { command: string; env: Env; record: LaunchRecord } => {
    const entry = this.entryOf(params.agent as string)
    return this.guard(() =>
      buildResumePlan({
        entry,
        cwd: params.cwd as string,
        record: (params.record as LaunchRecord | null | undefined) ?? null,
        providerSession: params.providerSession as ProviderSession,
        fork: params.fork === true,
        hookArgs: (params.hookArgs as string[] | undefined) ?? [],
        hookEnv: (params.hookEnv as Env | undefined) ?? {},
        resolveExecutable: (name) => this.detection.resolveExecutable(name)
      })
    )
  }

  deliver = async (params: Params): Promise<{ delivery: DeliveryOutcome }> => {
    const entry = this.entryOf(params.agent as string)
    const delivery = await this.runner.deliver(params.sessionId as string, entry, params.text as string, params.submit as boolean)
    return { delivery }
  }

  /** Runs one agent (or a custom command) once and returns its decoded output; see `generate.ts`. */
  generate = (params: Params, caller: PluginCaller) => this.generator.generate(params, caller)

  cancelGenerate = (params: Params) => this.generator.cancelGenerate(params)

  /** Stops every running generation; the daemon is shutting the plugin down. */
  stopGenerating(): void {
    this.generator.stopAll()
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async detectInstalled(): Promise<void> {
    const loginPath = await readLoginPath(this.context.launch.shell)
    this.search = searchDirs({
      loginPath,
      fallbackPath: process.env.PATH ?? '',
      quirkyBin: this.context.launch.binDir,
      home: userHome(),
      ...(process.env.QUIRKY_AGENT_SEARCH_DIRS === undefined ? {} : { override: process.env.QUIRKY_AGENT_SEARCH_DIRS })
    })
    this.detection = this.snapshot(this.catalog.agents)
  }

  /** Detects now rather than on first lookup, so a list stays as it was until the next refresh. */
  private snapshot(entries: AgentEntry[]): Detection {
    const detection = detect(entries, this.search)
    for (const entry of entries) detection.installed(entry.id)
    return detection
  }

  /** Rebuilds the catalog from the kernel's contributions and re-detects when it differs; true then. */
  private async rebuildCatalog(): Promise<boolean> {
    const contributions = (await this.context.call('plugin.contributions', { kind: 'agent' })) as ContributionInfo[]
    const next = buildCatalog(contributions)
    for (const problem of next.problems) {
      const line = `skipped agent ${problem.plugin}/${problem.id}: ${problem.error}`
      if (!this.reportedProblems.has(line)) {
        this.reportedProblems.add(line)
        this.context.log(line)
      }
    }
    const differs = JSON.stringify(next) !== JSON.stringify(this.catalog)
    this.catalog = next
    if (differs) this.detection = this.snapshot(next.agents)
    return differs
  }

  private onEvent(event: QuirkyEvent): void | Promise<void> {
    if (event.type === 'plugin.changed') {
      return this.enqueue(async () => {
        if (await this.rebuildCatalog()) this.changed()
      }).catch((error) => {
        this.context.log(`could not rebuild the agent catalog: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    if (event.type === 'setting.changed') {
      const key = event.id === `${SETTING_PREFIX}${DEFAULT_SETTING}` ? 'default' : event.id === `${SETTING_PREFIX}${TRUST_SETTING}` ? 'trust' : null
      if (key !== null && this.known[key] !== event.value) {
        this.known[key] = event.value
        this.changed()
      }
      return
    }
    if (event.type === 'quirky.session/removed') {
      const sessionId = (event as { data?: { sessionId?: unknown } }).data?.sessionId
      if (typeof sessionId === 'string') for (const listener of [...this.goneListeners]) listener(sessionId)
    }
  }

  private changed(): void {
    this.context.emit('changed', {})
  }

  /** Writes a setting and records the value first, so its own `setting.changed` event is not announced twice. */
  private async writeSetting(name: string, value: string): Promise<void> {
    const key = name === DEFAULT_SETTING ? 'default' : 'trust'
    const previous = this.known[key]
    this.known[key] = value
    try {
      await this.context.call('setting.set', { id: `${SETTING_PREFIX}${name}`, value })
    } catch (error) {
      this.known[key] = previous
      throw error
    }
  }

  private defaultAgent(): string {
    const value = this.context.getSetting(DEFAULT_SETTING)
    if (value === 'shell') return 'shell'
    return typeof value === 'string' && this.catalog.agents.some((entry) => entry.id === value) ? value : 'auto'
  }

  private entryOf(id: string, kind: 'not-found' | 'invalid-params' = 'not-found'): AgentEntry {
    const entry = this.catalog.agents.find((candidate) => candidate.id === id)
    if (!entry) throw this.context.error(kind, `unknown agent: ${id}`)
    return entry
  }

  private guard<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      if (error instanceof PlanError || error instanceof SelectionError || error instanceof SettingsError) {
        throw this.context.error('invalid-params', error.message)
      }
      throw error
    }
  }

  /** The caller's pick and extra arguments, checked against the agent's catalog and allowlist. */
  private picks(entry: AgentEntry, params: Params): { selection: ValidSelection | null; extras: ParsedExtras | null } {
    return {
      selection: validateSelection(entry, { model: params.model, options: params.options }),
      extras: parseExtraArgs(entry, (params.extraArgs as string | undefined) ?? '')
    }
  }

  private commandTokens(text: string): string[] {
    const result = tokenize(text)
    if (!result.ok) throw new PlanError(`Agent command override is invalid: ${result.error}`)
    if (result.tokens.length === 0) throw new PlanError('Agent command override is invalid: the command is empty')
    return result.tokens
  }

  private configuredArgs(entry: AgentEntry, config: AgentConfig): string[] {
    const result = tokenize(config.args ?? entry.yolo ?? '')
    if (!result.ok) throw new PlanError(`CLI arguments are invalid: ${result.error}`)
    return entry.stripArgs.length === 0 ? result.tokens : result.tokens.filter((token) => !entry.stripArgs.includes(token))
  }

  private commandOverride(entry: AgentEntry, text: string): string | null {
    if (text.trim() === '' || text === entry.launch) return null
    const result = tokenize(text)
    if (!result.ok) throw this.context.error('invalid-params', `Agent command override is invalid: ${result.error}`)
    if (result.tokens.length === 0) return null
    return text
  }

  private argsOverride(text: string): string {
    const result = tokenize(text)
    if (!result.ok) throw this.context.error('invalid-params', `CLI arguments are invalid: ${result.error}`)
    return text
  }

  private envOverride(env: Record<string, unknown>): Record<string, string> {
    for (const [name, value] of Object.entries(env)) {
      if (isReservedLaunchEnv(name)) throw this.context.error('invalid-params', `${name} is reserved and can't be set`)
      if (typeof value !== 'string') throw this.context.error('invalid-params', `environment value for ${name} must be a string`)
    }
    return { ...(env as Record<string, string>) }
  }

  private trustFolder(entry: AgentEntry, cwd: string): void {
    if (this.context.getSetting(TRUST_SETTING) !== true || entry.trust === null) return
    const home = userHome()
    // a test run must never write the developer's real agent configs; Bun's homedir() ignores $HOME, so it names the real one
    if (process.env.NODE_ENV === 'test' && home === homedir()) {
      this.context.log(`trust for ${entry.id} skipped: test run against the real home`)
      return
    }
    try {
      writeTrust(entry.trust, cwd, home)
    } catch (error) {
      this.context.log(`trust for ${entry.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private info(entry: AgentEntry, config = this.configs.get(entry.id)): AgentInfo {
    const defaultAgent = this.defaultAgent()
    return {
      id: entry.id,
      label: entry.label,
      plugin: entry.plugin,
      installed: this.detection.installed(entry.id),
      enabled: !config.disabled,
      isDefault: defaultAgent === entry.id,
      promptMode: entry.prompt,
      resumable: entry.resume !== null,
      canFork: entry.fork !== null,
      homepage: entry.homepage,
      install: entry.install,
      command: config.command ?? entry.launch,
      commandOverridden: config.command !== null,
      args: effectiveArgs(entry, config),
      argsOverridden: config.args !== null,
      env: effectiveEnv(entry, config),
      envOverridden: config.env !== null,
      showEnv: entry.yoloEnv !== null || config.env !== null,
      permissions: { mode: agentPermissionMode(entry, config), hasAuto: entry.auto !== null },
      canGenerate: entry.oneShot !== null
    }
  }

  private listing(all: boolean): AgentListing {
    const configs = this.configs.all()
    const { summary, nonAuto } = permissionSummary(this.catalog.agents, configs)
    return {
      defaultAgent: this.defaultAgent(),
      workspaceTrust: this.context.getSetting(TRUST_SETTING) === true,
      permissions: { summary, nonAuto },
      agents: this.catalog.agents.map((entry) => this.info(entry, configs.get(entry.id) ?? { ...EMPTY_CONFIG })),
      ...(all ? { problems: this.catalog.problems } : {})
    }
  }
}
