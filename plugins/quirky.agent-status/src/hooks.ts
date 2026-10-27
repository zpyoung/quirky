import type { PluginContext, QuirkyEvent } from '@quirky/protocol'
import { resolveHome } from './install/common.ts'
import { INSTALLERS, installerFor } from './install/registry.ts'
import { type InstallEnv, type InstallStatus, type Installer } from './types.ts'

export const HOOKS_SETTING = 'setting:quirky.agent-status/hooks'

export type HooksStatusEntry = { agent: string; status: InstallStatus; files: string[]; message?: string }
export type HooksSetupEntry = { agent: string; status: InstallStatus; changed: string[]; note?: string; message?: string }
export type HooksRemoveEntry = { agent: string; changed: string[]; message?: string }

type Detection = { installed: boolean; enabled: boolean }

type AgentListing = { agents?: { id?: unknown; installed?: unknown; enabled?: unknown }[] }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Installs, reports and removes the hook files of the agents that take them from a config file.
 * Setup only touches agents Quirky detected and the user left enabled; removal covers every agent.
 * Operations run one at a time, so a quick off-then-on of the setting ends installed.
 */
export class HooksService {
  /** Settles when the install started at activation has finished; it never rejects. */
  startup: Promise<void> = Promise.resolve()

  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly context: PluginContext) {}

  /** Refreshes Quirky's entries for detected, enabled agents when the setting is on; never removes. */
  begin(): void {
    if (!this.enabled()) return
    this.startup = this.queued(() => this.installDetected()).then(
      () => undefined,
      (error) => this.context.log(`agent hooks were not installed at startup: ${messageOf(error)}`)
    )
  }

  /** Follows the `hooks` setting: off removes every Quirky entry, on installs for detected, enabled agents. */
  onEvent(event: QuirkyEvent): Promise<void> | void {
    if (event.type !== 'setting.changed' || event.id !== HOOKS_SETTING) return
    const on = event.value !== false
    return this.queued(() => (on ? this.installDetected() : this.removeAll())).then(
      () => undefined,
      (error) => this.context.log(`could not apply the hooks setting: ${messageOf(error)}`)
    )
  }

  /** The state of every installer's hooks; every agent reads `hooks_disabled` while the setting is off. */
  async status(): Promise<HooksStatusEntry[]> {
    const target = this.target()
    const off = !this.enabled()
    const detection = off ? new Map<string, Detection>() : await this.detect()
    return INSTALLERS.map((installer) => {
      const files = this.filesOf(installer, target)
      if (off) return { agent: installer.agent, status: 'hooks_disabled', files }
      const state = this.statusOf(installer, target)
      if (typeof state === 'object') return { agent: installer.agent, status: 'error', files, message: state.error }
      if (state === 'installed') return { agent: installer.agent, status: 'installed', files }
      return { agent: installer.agent, status: skipReason(detection.get(installer.agent)) ?? 'not-installed', files }
    })
  }

  /**
   * Installs hooks for `agent`, or for every detected, enabled agent. An agent that is not
   * detected or is disabled is reported, not an error; so is an installer that cannot read its file.
   * Rejects `invalid-params` for an unknown agent and `conflict` (the platform has no failed-precondition code) while the setting is off.
   */
  async setup(agent?: string): Promise<HooksSetupEntry[]> {
    const targets = this.targets(agent)
    if (!this.enabled()) throw this.context.error('conflict', 'Agent status hooks are turned off')
    return this.queued(() => this.install(targets))
  }

  /** Removes Quirky's entries for `agent`, or for every agent, whether or not the agent is detected. */
  async remove(agent?: string): Promise<HooksRemoveEntry[]> {
    const targets = this.targets(agent)
    return this.queued(async () => this.removeFrom(targets))
  }

  private targets(agent: string | undefined): readonly Installer[] {
    if (agent === undefined) return INSTALLERS
    const installer = installerFor(agent)
    if (!installer) throw this.context.error('invalid-params', `no agent status hooks for ${agent}`)
    return [installer]
  }

  private enabled(): boolean {
    try {
      return this.context.getSetting('hooks') !== false
    } catch {
      return true
    }
  }

  private target(): InstallEnv {
    return { home: resolveHome(process.env), env: process.env, quirkyHome: this.context.home }
  }

  private queued<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run)
    this.tail = next.catch(() => undefined)
    return next
  }

  private async installDetected(): Promise<void> {
    const results = await this.install(INSTALLERS)
    const changed = results.flatMap((entry) => entry.changed)
    if (changed.length > 0) this.context.log(`agent hooks written: ${changed.join(', ')}`)
    for (const entry of results) if (entry.status === 'error') this.context.log(`agent hooks for ${entry.agent}: ${entry.message}`)
  }

  private async removeAll(): Promise<void> {
    const removed = this.removeFrom(INSTALLERS).flatMap((entry) => entry.changed)
    if (removed.length > 0) this.context.log(`agent hooks removed: ${removed.join(', ')}`)
  }

  private async install(installers: readonly Installer[]): Promise<HooksSetupEntry[]> {
    const target = this.target()
    const detection = await this.detect()
    return installers.map((installer): HooksSetupEntry => {
      const skipped = skipReason(detection.get(installer.agent))
      if (skipped) return { agent: installer.agent, status: skipped, changed: [] }
      try {
        const { changed, note, message } = installer.install(target)
        const state = this.statusOf(installer, target)
        const status = typeof state === 'object' ? 'error' : state
        return {
          agent: installer.agent,
          status,
          changed,
          ...(note ? { note } : {}),
          ...(typeof state === 'object' ? { message: state.error } : message ? { message } : {})
        }
      } catch (error) {
        return { agent: installer.agent, status: 'error', changed: [], message: messageOf(error) }
      }
    })
  }

  private removeFrom(installers: readonly Installer[]): HooksRemoveEntry[] {
    const target = this.target()
    return installers.map((installer): HooksRemoveEntry => {
      try {
        const { changed, message } = installer.remove(target)
        return { agent: installer.agent, changed, ...(message ? { message } : {}) }
      } catch (error) {
        return { agent: installer.agent, changed: [], message: messageOf(error) }
      }
    })
  }

  private statusOf(installer: Installer, target: InstallEnv): ReturnType<Installer['status']> {
    try {
      return installer.status(target)
    } catch (error) {
      return { error: messageOf(error) }
    }
  }

  private filesOf(installer: Installer, target: InstallEnv): string[] {
    try {
      return installer.files(target)
    } catch {
      return []
    }
  }

  /** Detection and enablement by agent ID; empty when quirky.agents can't answer, which reads as nothing detected. */
  private async detect(): Promise<Map<string, Detection>> {
    const found = new Map<string, Detection>()
    try {
      const listing = (await this.context.call('quirky.agents/list', {})) as AgentListing
      for (const agent of listing.agents ?? []) {
        if (typeof agent.id === 'string') found.set(agent.id, { installed: agent.installed === true, enabled: agent.enabled === true })
      }
    } catch (error) {
      this.context.log(`could not read the agent list: ${messageOf(error)}`)
    }
    return found
  }
}

/** Why an agent is skipped, or undefined when hooks may be installed for it. */
function skipReason(detection: Detection | undefined): 'cli_not_found' | 'agent_disabled' | undefined {
  if (!detection?.installed) return 'cli_not_found'
  return detection.enabled ? undefined : 'agent_disabled'
}
