import type { ElectrobunConfig } from 'electrobun'

export default {
  app: {
    name: 'Quirky',
    identifier: 'dev.quirky.app',
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
  }
} satisfies ElectrobunConfig
