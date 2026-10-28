import { formatContributionId, type PluginCaller, type PluginContext } from '@quirky/protocol'
import { LedgerEngine } from './src/daemon/engine'
import type { LedgerOperation, LedgerRequest } from './src/types'

type Params = Record<string, unknown>
type Handler = (params: Params, caller: PluginCaller) => unknown

const OPERATIONS: LedgerOperation[] = [
  'file',
  'list',
  'show',
  'edit',
  'state',
  'review',
  'revert',
  'import',
  'catalog',
  'approve',
  'bulk-state',
  'delete-entries',
  'delete-ledger',
  'attach',
  'settings',
  'removal-preview'
]

export async function activate(context: PluginContext): Promise<void> {
  const engine = new LedgerEngine(context)
  const provide = (name: string, handler: Handler) =>
    context.provide(formatContributionId('method', context.pluginId, name), handler)
  const operation = (name: LedgerOperation, params: Params, caller: PluginCaller) =>
    engine.request({ ...params, operation: name } as LedgerRequest, caller)
  const describe = (name: LedgerOperation, params: Params, caller: PluginCaller) =>
    engine.describe({ ...params, operation: name } as LedgerRequest, caller)

  provide('request', (params, caller) => engine.request(params as LedgerRequest, caller))
  provide('describe', (params, caller) => engine.describe(params as LedgerRequest, caller))
  for (const name of OPERATIONS) provide(name, (params, caller) => operation(name, params, caller))

  provide('describeBulkState', (params, caller) => describe('bulk-state', params, caller))
  provide('describeDeleteEntries', (params, caller) => describe('delete-entries', params, caller))
  provide('describeDeleteLedger', (params, caller) => describe('delete-ledger', params, caller))
  provide('describeAttach', (params, caller) => describe('attach', params, caller))

  await engine.start()
}
