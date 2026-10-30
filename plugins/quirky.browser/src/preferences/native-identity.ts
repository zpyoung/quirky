import type { UiPluginContext } from '@quirky/protocol'
import { identityModeFromSetting, userAgentForIdentity } from './identity'

/**
 * The user agent a Native pane is mounted with: the daemon's active identity applied to the
 * system webview's own user agent. Undefined keeps that user agent untouched, which is what
 * Native means and all a host without an override can do. The active mode only changes when the
 * daemon restarts, so remounting a pane never applies a pending selection early.
 */
export async function nativePaneUserAgent(context: UiPluginContext): Promise<string | undefined> {
  const identity = await context.call('quirky.browser/identityGet') as { active?: unknown }
  if (identityModeFromSetting(identity.active) !== 'clean') return undefined
  const engineUserAgent = await context.nativeBrowser.defaultUserAgent()
  return engineUserAgent === null ? undefined : userAgentForIdentity('clean', engineUserAgent)
}
