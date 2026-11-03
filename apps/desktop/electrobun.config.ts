import type { ElectrobunConfig } from 'electrobun'

/**
 * The macOS bundle id for this build. Only the release build CI makes (QUIRKY_RELEASE_BUILD=1) uses
 * the installed app's id. Dev builds and locally built apps get their own, so `open -b`, Launch
 * Services and Electrobun's per-identifier app data never reach the installed app by mistake.
 */
export function bundleIdentifier(env: Record<string, string | undefined>): string {
  if (env.ELECTROBUN_BUILD_ENV === 'dev') return 'dev.quirky.app.dev'
  return env.QUIRKY_RELEASE_BUILD === '1' ? 'dev.quirky.app' : 'dev.quirky.app.local'
}

export default {
  app: {
    name: 'Quirky',
    identifier: bundleIdentifier(process.env),
    version: '0.1.0'
  },
  build: {
    mainProcess: 'bun',
    bun: {
      entrypoint: 'src/bun/index.ts'
    },
    copy: {
      resources: 'resources'
    },
    mac: {
      bundleCEF: false,
      createDmg: false
    },
    linux: {
      bundleCEF: false
    },
    win: {
      bundleCEF: false
    }
  },
  scripts: {
    postBuild: 'scripts/allow-label-hosts.ts'
  },
  release: {
    baseUrl: 'https://github.com/zpyoung/quirky/releases/latest/download'
  }
} satisfies ElectrobunConfig
