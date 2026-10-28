import * as FileSystem from 'expo-file-system/legacy'
import { sha256 } from '@quirky/protocol/paired-client'
import { createGenerationStore, decodeBase64, encodeBase64, type BundleFileSystem, type GenerationStore } from './generation'

const fileSystem: BundleFileSystem = {
  async exists(path) {
    return (await FileSystem.getInfoAsync(path)).exists
  },
  async createDirectory(path) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true })
  },
  async listDirectory(path) {
    let names: string[]
    try { names = await FileSystem.readDirectoryAsync(path) } catch { return [] }
    const entries = await Promise.all(names.map(async (name) => {
      try {
        const info = await FileSystem.getInfoAsync(`${path.replace(/\/+$/, '')}/${name}`)
        if (!info.exists) return null
        return { name, isDirectory: info.isDirectory === true, modifiedAt: info.modificationTime ?? 0 }
      } catch {
        return null
      }
    }))
    return entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  },
  async readFile(path) {
    const encoded = await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.Base64 })
    return decodeBase64(encoded)
  },
  async writeFile(path, bytes) {
    await FileSystem.writeAsStringAsync(path, encodeBase64(bytes), { encoding: FileSystem.EncodingType.Base64 })
  },
  async movePath(source, destination) {
    await FileSystem.moveAsync({ from: source, to: destination })
  },
  async removePath(path) {
    await FileSystem.deleteAsync(path, { idempotent: true })
  }
}

let storePromise: Promise<GenerationStore> | undefined

export function getMobilePageGenerationStore(): Promise<GenerationStore> {
  if (storePromise) return storePromise
  const documentDirectory = FileSystem.documentDirectory
  if (!documentDirectory) throw new Error('mobile generation storage is unavailable')
  const root = `${documentDirectory.replace(/\/+$/, '')}/mobile-generations`
  storePromise = createGenerationStore(fileSystem, root, sha256)
  return storePromise
}
