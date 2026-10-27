import type { BrowserDependencies, BrowserSpawn } from './dependencies'

const productionSpawn: BrowserSpawn = (command, options) => Bun.spawn(command, options)

export function browserDependencies(runtimeRoot: string): BrowserDependencies {
  return { runtimeRoot, spawn: productionSpawn }
}
