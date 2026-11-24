import { defineMethod } from '../core'
import { isGitBashAvailable } from '../../../git-bash'

export const HOST_CAPABILITY_METHODS = [
  defineMethod({
    name: 'host.platform',
    permission: 'workspace',
    params: null,
    handler: async () => ({ platform: process.platform })
  }),
  defineMethod({
    name: 'host.gitBash.isAvailable',
    permission: 'workspace',
    params: null,
    handler: async () => isGitBashAvailable()
  })
]
