import type { CommandHandler } from '../dispatch'
import { getOptionalJsonFlag, getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'
import { readCallerHintFromEnv } from '../../shared/public-rpc/caller-hint'
import {
  METHOD_CLASSIFICATION,
  classifyMethod,
  type MethodClass
} from '../../shared/public-rpc/method-classification'
import { PUBLIC_METHOD_SPECS, publicSpecForMethod } from '../../shared/public-rpc/public-methods'
import { RPC_PARAMS_BY_METHOD } from '../../shared/rpc-contract/rpc-params-catalog.generated'

export type RpcListEntry = {
  method: string
  class: MethodClass['kind']
  stability: 'stable' | 'unstable' | null
}

function stabilityOf(entry: MethodClass): RpcListEntry['stability'] {
  if (entry.kind === 'public') {
    return entry.spec.stability
  }
  return entry.kind === 'unstable' ? 'unstable' : null
}

/**
 * Every concrete method name the runtime registers, joined with its classification. The generated
 * params catalog is read back from the host registry, so it names exactly the methods a runtime of
 * this build serves; public specs and exact classification entries are added in case a build
 * variant registers a method the catalog omits.
 */
export function buildRpcList(): RpcListEntry[] {
  const names = new Set<string>([
    ...Object.keys(RPC_PARAMS_BY_METHOD),
    ...PUBLIC_METHOD_SPECS.map((spec) => spec.method),
    ...Object.keys(METHOD_CLASSIFICATION)
  ])
  const entries: RpcListEntry[] = []
  for (const method of names) {
    const classification = classifyMethod(method)
    if (classification) {
      entries.push({
        method,
        class: classification.kind,
        stability: stabilityOf(classification)
      })
    }
  }
  return entries.toSorted((a, b) => a.method.localeCompare(b.method))
}

function formatRpcListLine(entry: RpcListEntry): string {
  return `${entry.method}  ${entry.class}  ${entry.stability ?? '-'}`
}

function parseRpcParams(flags: Map<string, string | boolean>): unknown {
  const raw = getOptionalJsonFlag(flags, 'params')
  if (raw === undefined) {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new RuntimeClientError('invalid_argument', '--params must be valid JSON')
  }
}

export const RPC_HANDLERS: Record<string, CommandHandler> = {
  'rpc list': async ({ json }) => {
    const entries = buildRpcList()
    if (json) {
      console.log(JSON.stringify(entries, null, 2))
      return
    }
    console.log(entries.map(formatRpcListLine).join('\n'))
  },
  rpc: async ({ flags, client, json }) => {
    const method = getOptionalStringFlag(flags, 'method')
    if (!method) {
      throw new RuntimeClientError('invalid_argument', 'Missing <method>. Run `quirky rpc list`.')
    }
    const params = parseRpcParams(flags)
    const hint = readCallerHintFromEnv(process.env)
    const caller = Object.keys(hint).length > 0 ? hint : undefined
    if (publicSpecForMethod(method)?.streaming) {
      await client.stream(method, params, (frame) => console.log(JSON.stringify(frame)), {
        publicContract: true,
        caller
      })
      return
    }
    const response = await client.call(method, params, {
      publicContract: true,
      confirm: flags.has('yes'),
      caller
    })
    const { printResult } = await import('../format.js')
    printResult(response, json, (result) =>
      typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    )
  }
}
