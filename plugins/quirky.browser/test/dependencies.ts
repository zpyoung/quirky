import type { BrowserChild, BrowserDependencies, BrowserSpawn, BrowserSpawnOptions } from '../src/runtime/dependencies'

export type BrowserTestSpawn = (
  command: string[],
  options: BrowserSpawnOptions,
  defaultSpawn: BrowserSpawn
) => BrowserChild

export type BrowserTestOverrides = Omit<Partial<BrowserDependencies>, 'spawn'> &
  Pick<BrowserDependencies, 'runtimeRoot'> & {
    spawn?: BrowserTestSpawn
  }

const overridesByHome = new Map<string, BrowserTestOverrides>()

export function setBrowserTestOverrides(home: string, overrides: BrowserTestOverrides | undefined): void {
  if (overrides === undefined) overridesByHome.delete(home)
  else overridesByHome.set(home, overrides)
}

export function takeBrowserTestOverrides(home: string): BrowserTestOverrides | undefined {
  const overrides = overridesByHome.get(home)
  overridesByHome.delete(home)
  return overrides
}
