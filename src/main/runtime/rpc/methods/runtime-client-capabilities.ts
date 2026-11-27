import type { RuntimeCapability } from '../../../../shared/protocol-version'
import { defineMethod } from '../core'
import { askRosterFor } from '../../../fork-ask-question-tool/ask-attached-surface-roster'
import { ClientCapabilitiesUpdate } from '../../../../shared/rpc-contract/runtime-client-capabilities-params'

export const RUNTIME_CLIENT_CAPABILITY_METHODS = [
  defineMethod({
    name: 'runtime.clientCapabilities.update',
    permission: 'workspace',
    params: ClientCapabilitiesUpdate,
    handler: (params, { runtime, connectionId, updateClientCapabilities }) => {
      if (!updateClientCapabilities) {
        throw new Error('client_capabilities_update_unsupported')
      }
      const clientCapabilities = params.clientCapabilities as RuntimeCapability[]
      updateClientCapabilities(clientCapabilities)
      if (connectionId) {
        askRosterFor(runtime)?.recordConnectionCapabilities(connectionId, clientCapabilities)
      }
      return { clientCapabilities }
    }
  })
]
