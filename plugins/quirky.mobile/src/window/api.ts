import type { MobileDevice, MobileNetworkInterface, MobilePairingResult, MobileState, UiPluginContext } from '@quirky/protocol'

export type MobileConfigure = Partial<Pick<MobileState, 'machineName' | 'showMobileButton' | 'onboardingSeen' | 'autoRestoreFitMs' | 'customAddresses'>>

export function getMobileState(context: UiPluginContext): Promise<MobileState> {
  return context.call('quirky.mobile/state', {}) as Promise<MobileState>
}

export function getMobileInterfaces(context: UiPluginContext): Promise<MobileNetworkInterface[]> {
  return context.call('quirky.mobile/interfaces', {}) as Promise<MobileNetworkInterface[]>
}

export function getMobileDevices(context: UiPluginContext): Promise<MobileDevice[]> {
  return context.call('quirky.mobile/devices', {}) as Promise<MobileDevice[]>
}

export function configureMobile(context: UiPluginContext, changes: MobileConfigure): Promise<MobileState> {
  return context.call('quirky.mobile/configure', changes) as Promise<MobileState>
}

export function createPairing(context: UiPluginContext, address?: string, rotate = false): Promise<MobilePairingResult> {
  return context.call('quirky.mobile/pair', {
    ...(address === undefined ? {} : { address }),
    ...(rotate ? { rotate: true } : {})
  }) as Promise<MobilePairingResult>
}

export async function revokeMobileDevice(context: UiPluginContext, deviceId: string): Promise<void> {
  const result = (await context.call('quirky.mobile/revoke', { deviceId })) as { revoked: boolean }
  if (!result.revoked) throw new Error('Device is no longer paired.')
}
