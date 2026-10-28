import type { PluginCaller, PluginContext } from '@quirky/protocol'
import { asPluginError, fault } from '../runtime/errors'
import { isValidProfileId, type BrowserProfile } from '../profiles/store'
import type { PreferencesAdapters, PreferencesState, RegisterPreferences } from './contract'
import { identityModeFromSetting } from './identity'

const IMPORTS_UNAVAILABLE = 'Detected-browser and file imports require the Browser extras integration, which is unavailable in this build.'
const LOCALHOST_LABELS_UNAVAILABLE = 'Localhost worktree labels are unavailable because no faithful reachable-host mapping is available.'

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

function emitPreferencesChanged(context: PluginContext): void {
  context.emit('preferencesChanged', {})
}

export const registerPreferences: RegisterPreferences = (context, adapters) => {
  let available = true
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
        nativeSupported: false
      },
      imports: { available: false, reason: IMPORTS_UNAVAILABLE },
      localhostLabels: { available: false, reason: LOCALHOST_LABELS_UNAVAILABLE }
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

      const pane = await context.call('quirky.browser/paneOpen', { worktree, url, mode: 'native' })
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

  return { deactivate() { available = false } }
}
