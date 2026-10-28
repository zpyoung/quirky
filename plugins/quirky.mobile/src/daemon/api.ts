import type { MobileSettings } from './storage'
import { normalizeAdvertisedEndpoint } from './network'

export type MobileConfigureInput = Partial<MobileSettings>
export type MobilePairInput = { address?: string; rotate?: boolean }
export type MobileOpenInput = { settings: boolean }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

export function validateAddressList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('customAddresses must contain at most 50 addresses')
  const result: string[] = []
  for (const address of value) {
    if (typeof address !== 'string' || address.length === 0 || address.length > 16_384 || address !== address.trim()) throw new Error('custom address must be a trimmed string of at most 16384 characters')
    const normalized = normalizeAdvertisedEndpoint(address, 6768)
    if (!normalized || normalized.includes('?') || normalized.includes('#')) throw new Error('custom address is not a usable direct endpoint')
    result.push(address)
  }
  return result
}

export function configureInput(value: unknown): MobileConfigureInput {
  if (!isObject(value)) throw new Error('configure params must be an object')
  const allowed = new Set(['machineName', 'showMobileButton', 'onboardingSeen', 'autoRestoreFitMs', 'customAddresses'])
  const keys = Object.keys(value)
  if (keys.some((key) => !allowed.has(key))) throw new Error('configure contains an unsupported field')
  const result: MobileConfigureInput = {}
  if (Object.hasOwn(value, 'machineName')) {
    const name = value.machineName
    if (typeof name !== 'string' || name.length === 0 || name.length > 128 || name.trim() !== name || !name.trim()) throw new Error('machineName must be a nonempty trimmed string of at most 128 characters')
    result.machineName = name
  }
  if (Object.hasOwn(value, 'showMobileButton')) {
    if (typeof value.showMobileButton !== 'boolean') throw new Error('showMobileButton must be boolean')
    result.showMobileButton = value.showMobileButton
  }
  if (Object.hasOwn(value, 'onboardingSeen')) {
    if (typeof value.onboardingSeen !== 'boolean') throw new Error('onboardingSeen must be boolean')
    result.onboardingSeen = value.onboardingSeen
  }
  if (Object.hasOwn(value, 'autoRestoreFitMs')) {
    const duration = value.autoRestoreFitMs
    if (duration === null) result.autoRestoreFitMs = null
    else {
      if (typeof duration !== 'number' || !Number.isFinite(duration)) throw new Error('autoRestoreFitMs must be a finite number or null')
      result.autoRestoreFitMs = Math.max(5000, Math.min(3_600_000, Math.floor(duration)))
    }
  }
  if (Object.hasOwn(value, 'customAddresses')) result.customAddresses = validateAddressList(value.customAddresses)
  return result
}

export function pairInput(value: unknown): MobilePairInput {
  if (!isObject(value)) throw new Error('pair params must be an object')
  if (Object.keys(value).some((key) => key !== 'address' && key !== 'rotate')) throw new Error('pair contains an unsupported field')
  const result: MobilePairInput = {}
  if (Object.hasOwn(value, 'address')) {
    if (typeof value.address !== 'string' || value.address.length === 0 || value.address.length > 16_384 || value.address.trim() !== value.address) throw new Error('address must be a nonempty trimmed string')
    result.address = value.address
  }
  if (Object.hasOwn(value, 'rotate')) {
    if (typeof value.rotate !== 'boolean') throw new Error('rotate must be boolean')
    result.rotate = value.rotate
  }
  return result
}

export function revokeInput(value: unknown): { deviceId: string } {
  if (!isObject(value) || Object.keys(value).length !== 1 || typeof value.deviceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.deviceId)) throw new Error('deviceId must be a UUID')
  return { deviceId: value.deviceId }
}

export function openInput(value: unknown): MobileOpenInput {
  if (!isObject(value) || Object.keys(value).some((key) => key !== 'settings')) throw new Error('open params must contain only settings')
  if (value.settings !== undefined && typeof value.settings !== 'boolean') throw new Error('settings must be boolean')
  return { settings: value.settings === true }
}
