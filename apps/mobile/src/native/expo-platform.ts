import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Clipboard from 'expo-clipboard'
import * as Crypto from 'expo-crypto'
import * as Haptics from 'expo-haptics'
import * as ExpoLinking from 'expo-linking'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { Linking as NativeLinking } from 'react-native'
import type { MobileNativeActions, MobilePermission, MobileStorage } from '../contracts'
import { createSecureSecretStorage } from '../storage/secure-store'
import { createMobileRuntime, type MobileRuntimeInstance } from './runtime'

export const expoStorage: MobileStorage = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key)
}

export const expoSecrets = createSecureSecretStorage({
  isAvailableAsync: () => SecureStore.isAvailableAsync(),
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value, options) => SecureStore.setItemAsync(key, value, options),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
})

const expoNative: MobileNativeActions = {
  clipboardRead: () => Clipboard.getStringAsync(),
  clipboardWrite: async (text) => { await Clipboard.setStringAsync(text) },
  async openExternal(value) {
    let url: URL
    try { url = new URL(value) } catch { throw new Error('External link is invalid') }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only web links can be opened externally')
    await ExpoLinking.openURL(url.toString())
  },
  async haptic() { await Haptics.selectionAsync() },
  async notificationPermission(request): Promise<MobilePermission> {
    try {
      const current = await Notifications.getPermissionsAsync()
      if (current.granted) return 'granted'
      if (!request) return current.status === 'undetermined' ? 'undetermined' : 'denied'
      const result = await Notifications.requestPermissionsAsync()
      return result.granted ? 'granted' : 'denied'
    } catch {
      return 'unavailable'
    }
  },
  async openSystemSettings() { await NativeLinking.openSettings() }
}

export function createExpoRuntime(): MobileRuntimeInstance {
  return createMobileRuntime({
    storage: expoStorage,
    secrets: expoSecrets,
    native: expoNative,
    randomBytes: (length) => Crypto.getRandomBytesAsync(length)
  })
}
