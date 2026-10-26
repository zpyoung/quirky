import * as realGit from './index'

export * from './index'

/** The git module's function surface, so callers can be handed a fake in tests. */
export type GitApi = typeof realGit

declare global {
  /** Test-only override read by `gitApi()`; production never sets it. */
  var __QUIRKY_TEST_GIT__: GitApi | undefined
}

/** The git implementation to use: the installed test fake if any, else the real module. */
export function gitApi(): GitApi {
  return globalThis.__QUIRKY_TEST_GIT__ ?? realGit
}
