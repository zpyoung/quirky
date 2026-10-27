import { join } from 'node:path'
import type { BrowserDependencies, BrowserSpawn } from './dependencies'
import { productionKeyProvider } from '../cookies/sources'

const productionSpawn: BrowserSpawn = (command, options) => Bun.spawn(command, options)

export function browserDependencies(runtimeRoot: string): BrowserDependencies {
  return {
    runtimeRoot,
    spawn: productionSpawn,
    keyProvider: productionKeyProvider,
    sourceRoots: undefined
  }
}

export function profileDataPath(dataDir: string, profileId: string): string {
  return join(dataDir, 'profiles', profileId)
}
