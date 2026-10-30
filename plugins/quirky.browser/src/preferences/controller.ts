import type { PluginCaller, PluginContext } from '@quirky/protocol'
import { asPluginError, fault } from '../runtime/errors'
import { isValidProfileId, type BrowserProfile } from '../profiles/store'
import type { PreferencesAdapters, PreferencesState, RegisterPreferences } from './contract'
import { identityModeFromSetting } from './identity'
import { baseLabelForWorktree, parseLabelTarget, type LabelWorktree } from '../localhost-labels/labels'
import { LocalhostLabelProxy } from '../localhost-labels/proxy'

const IMPORT_DESTINATION = 'Cookies are imported into the selected managed Chrome profile for agents and Watch, not the Native system webview.'
const LOCALHOST_LABELS = 'Loopback links opened from a worktree get a <label>.quirky.localhost address that routes to that worktree\'s server. The Native pane routes it through a per-profile proxy, which needs macOS 14 or later.'

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || value.trim() === '') throw fault('invalid_argument', `${name} must be a non-empty string`)
  return value
}

function requiredProfile(adapters: PreferencesAdapters, id: string): BrowserProfile {
  if (!isValidProfileId(id)) throw fault('invalid_argument', 'profile identifier is not valid')
  const profile = adapters.listProfiles().find((item) => item.id === id)
  if (!profile) throw fault('browser_profile_not_found', `profile ${id} does not exist`)
  return profile
}

function activeProfiles(adapters: PreferencesAdapters): Set<string> {
  const active = new Set(adapters.listPageProfiles())
  for (const pane of adapters.listPanes()) {
    if ('profileId' in pane && typeof pane.profileId === 'string') active.add(pane.profileId)
  }
  return active
}

function assertInactive(adapters: PreferencesAdapters, profileId: string): void {
  if (activeProfiles(adapters).has(profileId)) {
    throw fault('browser_error', `profile ${profileId} is in use by an active pane or page`)
  }
}

async function labelWorktree(context: PluginContext, selector: string): Promise<LabelWorktree> {
  const worktree = await context.call('quirky.worktree/show', { worktree: selector })
  if (
    worktree === null || typeof worktree !== 'object' || Array.isArray(worktree) ||
    !('id' in worktree) || typeof worktree.id !== 'string' || worktree.id.length === 0 ||
    !('path' in worktree) || typeof worktree.path !== 'string' || worktree.path.length === 0 ||
    !('isMain' in worktree) || typeof worktree.isMain !== 'boolean' ||
    !('kind' in worktree) || (worktree.kind !== 'git' && worktree.kind !== 'folder')
  ) {
    throw fault('browser_error', 'quirky.worktree/show did not return a worktree id, path, isMain and kind')
  }
  return { id: worktree.id, path: worktree.path, isMain: worktree.isMain, kind: worktree.kind }
}

function emitPreferencesChanged(context: PluginContext): void {
  context.emit('preferencesChanged', {})
}

export const registerPreferences: RegisterPreferences = (context, adapters) => {
  let available = true
  const labels = new LocalhostLabelProxy()
  const labelsEnabled = () => context.getSetting('localhostWorktreeLabelsEnabled') === true
  const registerLabel = async (url: string, worktree: string) => {
    const target = parseLabelTarget(url)
    if (!target) throw fault('invalid_argument', 'url must be an http URL on localhost or a loopback address with an explicit port')
    const owner = await labelWorktree(context, worktree)
    const route = await labels.register(owner.id, baseLabelForWorktree(owner), target)
    emitPreferencesChanged(context)
    return route
  }
  const activeIdentity = identityModeFromSetting(context.getSetting('identityMode'))

  const state = (): PreferencesState => {
    const active = activeProfiles(adapters)
    const selectedIdentity = identityModeFromSetting(context.getSetting('identityMode'))
    return {
      profiles: adapters.listProfiles().map((profile) => ({ profile, active: active.has(profile.id) })),
      identity: {
        selected: selectedIdentity,
        active: activeIdentity,
        restartRequired: selectedIdentity !== activeIdentity,
        nativeSupported: adapters.nativeIdentitySupported
      },
      imports: { available: true, destination: 'managed-chrome', nativeSupported: false, reason: IMPORT_DESTINATION },
      localhostLabels: { available: true, enabled: labelsEnabled(), reason: LOCALHOST_LABELS, labels: labels.list() }
    }
  }

  const handlers: Record<string, Handler> = {
    preferencesState: () => state(),
    profileSet: async (params) => {
      const pane = requiredString(params, 'pane')
      const profileId = requiredString(params, 'profile')
      requiredProfile(adapters, profileId)
      const updatedPane = await adapters.setPaneProfile(pane, profileId)
      emitPreferencesChanged(context)
      return { pane: updatedPane }
    },
    profileClear: async (params) => {
      const profileId = requiredString(params, 'profile')
      requiredProfile(adapters, profileId)
      assertInactive(adapters, profileId)
      await adapters.clearProfile(profileId, false)
      emitPreferencesChanged(context)
      return { cleared: true }
    },
    profileDelete: async (params) => {
      const profileId = requiredString(params, 'profile')
      const profile = requiredProfile(adapters, profileId)
      if (profile.id === 'default' || profile.scope === 'default') {
        throw fault('invalid_argument', 'the Default browser profile cannot be deleted')
      }
      assertInactive(adapters, profileId)
      await adapters.clearProfile(profileId, true)
      emitPreferencesChanged(context)
      return { deleted: true }
    },
    localhostLabelRegister: async (params) => {
      const url = requiredString(params, 'url')
      const worktree = requiredString(params, 'worktree')
      if (!labelsEnabled()) throw fault('browser_error', 'Localhost Worktree Labels are off; turn them on in Browser settings')
      return await registerLabel(url, worktree)
    },
    localhostLabelList: () => ({ labels: labels.list() }),
    openLink: async (params) => {
      const url = requiredString(params, 'url')
      const worktree = requiredString(params, 'worktree')
      for (const key of ['modifier', 'shift'] as const) {
        if (params[key] !== undefined && typeof params[key] !== 'boolean') {
          throw fault('invalid_argument', `${key} must be a boolean`)
        }
      }
      let parsed: URL
      try { parsed = new URL(url) } catch { throw fault('invalid_argument', 'url must be an absolute HTTP or HTTPS URL') }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw fault('invalid_argument', 'url must be an absolute HTTP or HTTPS URL')
      }

      const modifier = params.modifier === true
      const shift = params.shift === true
      const invertOnShift = context.getSetting('openLinksInAppModifierInverts') === true
      let openInApp = context.getSetting('openLinksInApp') === true
      if (modifier && shift) openInApp = invertOnShift ? !openInApp : false

      if (!openInApp) {
        await context.call('quirky.terminal/openExternal', { target: url })
        return { route: 'external' }
      }

      const target = labelsEnabled() && parseLabelTarget(url) ? (await registerLabel(url, worktree)).url : url
      const pane = await context.call('quirky.browser/paneOpen', { worktree, url: target, mode: 'native' })
      if (pane === null || typeof pane !== 'object' || Array.isArray(pane) ||
        !('id' in pane) || typeof pane.id !== 'string' || pane.id.length === 0 ||
        !('worktreeId' in pane) || typeof pane.worktreeId !== 'string' || pane.worktreeId.length === 0) {
        throw fault('browser_error', 'paneOpen did not return a pane and worktree identity')
      }
      await context.call('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: `id:${pane.worktreeId}` } })
      return { route: 'app', pane: pane.id }
    }
  }

  for (const [name, handler] of Object.entries(handlers)) {
    context.provide(`method:quirky.browser/${name}`, async (params: Record<string, unknown>, _caller: PluginCaller) => {
      try {
        if (!available) throw fault('browser_error', 'preferences controller is deactivated')
        return await handler(params)
      } catch (error) {
        throw asPluginError(context, error)
      }
    })
  }

  return {
    deactivate() {
      available = false
      void labels.close()
    }
  }
}
