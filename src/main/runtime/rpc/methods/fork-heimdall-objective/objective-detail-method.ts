import { defineMethod } from '../../core'
import { HEIMDALL_CHANNELS } from '../../../../../shared/fork-heimdall/api'
import { WatcherTargetSchema } from '../../../../../shared/fork-heimdall/fleet-types'
import { ObjectiveDetailSchema } from '../../../../../shared/fork-heimdall-objective/detail-types'
import { ObjectiveEnrollmentPayloadSchema } from '../../../../../shared/fork-heimdall-objective/contract-types'
import type { QuirkyRuntimeService } from '../../../../runtime/quirky-runtime'
import type { HeimdallFleetTransport } from '../../../../fork-heimdall/fleet-transport'
import { requireHeimdallKernel, requireHeimdallTransport } from '../fork-heimdall/kernel-binding'
import { requireHeimdallObjectiveStore } from './objective-binding'
import { ObjectiveDetailReaderSchema } from './objective-detail-reader-schema'
import { projectObjectiveDetailParallelForClient } from '../fork-heimdall/park-reason-wire'

async function readLocalObjectiveDetail(runtime: QuirkyRuntimeService, watcherId: string) {
  const target = { watcherId, connectionId: null, pairingRevision: null } as const
  const detail = await requireHeimdallKernel(runtime).detail(target)
  if (detail.watcher.entry.enrollment.kind !== 'objective') {
    throw new Error('Requested Heimdall watcher is not an objective')
  }
  const contract = ObjectiveEnrollmentPayloadSchema.parse(
    detail.watcher.entry.enrollment.kindPayload
  )
  return requireHeimdallObjectiveStore(runtime).detail(watcherId, contract, detail.ledger)
}

async function readRemoteObjectiveDetail(
  transport: Pick<HeimdallFleetTransport, 'readRemote'>,
  target: {
    watcherId: string
    connectionId: string
    pairingRevision: number
  }
) {
  const response = await transport.readRemote(
    { id: target.connectionId, pairingRevision: target.pairingRevision },
    HEIMDALL_CHANNELS.objectiveDetail,
    { watcherId: target.watcherId, connectionId: null, pairingRevision: null }
  )
  if (response.ok !== true) {
    throw new Error(
      `The owning runtime refused the objective detail read: ${response.error.message}`
    )
  }
  return ObjectiveDetailReaderSchema.parse(response.result)
}

export const HEIMDALL_OBJECTIVE_METHODS = [
  defineMethod({
    name: HEIMDALL_CHANNELS.objectiveDetail,
    permission: 'workspace',
    params: WatcherTargetSchema,
    handler: async (target, context) => {
      const { runtime, clientKind } = context
      if (clientKind === 'runtime') {
        if (target.connectionId !== null || target.pairingRevision !== null) {
          throw new Error('A remote runtime can only serve locally owned Heimdall objectives')
        }
        return projectObjectiveDetailParallelForClient(
          ObjectiveDetailSchema.parse(await readLocalObjectiveDetail(runtime, target.watcherId)),
          context
        )
      }
      if (target.connectionId === null) {
        return projectObjectiveDetailParallelForClient(
          ObjectiveDetailSchema.parse(await readLocalObjectiveDetail(runtime, target.watcherId)),
          context
        )
      }
      return projectObjectiveDetailParallelForClient(
        await readRemoteObjectiveDetail(requireHeimdallTransport(runtime), {
          watcherId: target.watcherId,
          connectionId: target.connectionId,
          pairingRevision: target.pairingRevision!
        }),
        context
      )
    }
  })
]
