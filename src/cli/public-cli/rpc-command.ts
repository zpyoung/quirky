import type { CommandHandler } from '../dispatch'
import { getOptionalJsonFlag, getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'
import { readCallerHintFromEnv } from '../../shared/public-rpc/caller-hint'
import {
  METHOD_CLASSIFICATION,
  NAMESPACE_DEFAULTS,
  type MethodClass
} from '../../shared/public-rpc/method-classification'
import { PUBLIC_METHOD_SPECS, publicSpecForMethod } from '../../shared/public-rpc/public-methods'

export type RpcListEntry = {
  method: string
  class: MethodClass['kind']
  stability: 'stable' | 'unstable' | null
  /** True for a namespace prefix such as `agentSession.`, which covers many methods. */
  pattern?: true
}

function stabilityOf(entry: MethodClass): RpcListEntry['stability'] {
  if (entry.kind === 'public') {
    return entry.spec.stability
  }
  return entry.kind === 'unstable' ? 'unstable' : null
}

/**
 * Every method name the classification tables and public specs know, plus each namespace prefix.
 * The runtime's full registry lives server-side, so this is the part the CLI can state offline.
 */
export function buildRpcList(): RpcListEntry[] {
  const entries: RpcListEntry[] = []
  for (const spec of PUBLIC_METHOD_SPECS) {
    entries.push({ method: spec.method, class: 'public', stability: spec.stability })
  }
  for (const [method, entry] of Object.entries(METHOD_CLASSIFICATION)) {
    if (!publicSpecForMethod(method)) {
      entries.push({ method, class: entry.kind, stability: stabilityOf(entry) })
    }
  }
  for (const [prefix, entry] of Object.entries(NAMESPACE_DEFAULTS)) {
    entries.push({
      method: `${prefix}*`,
      class: entry.kind,
      stability: stabilityOf(entry),
      pattern: true
    })
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
