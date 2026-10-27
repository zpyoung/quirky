import type { BrowserDependencies } from '../src/runtime/dependencies'

export type BrowserTestOverrides = Partial<BrowserDependencies> & Pick<BrowserDependencies, 'runtimeRoot'>

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
