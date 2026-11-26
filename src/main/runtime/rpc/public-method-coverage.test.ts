import { describe, expect, it } from 'vitest'
import { RPC_PARAMS_BY_METHOD } from '../../../shared/rpc-contract/rpc-params-catalog.generated'
import {
  METHOD_CLASSIFICATION,
  classifyMethod
} from '../../../shared/public-rpc/method-classification'
import { PUBLIC_METHOD_SPECS } from '../../../shared/public-rpc/public-methods'
import { ALL_RPC_METHODS } from './methods'
import { SIDEBAR_INPUT_METHODS } from './methods/sidebar-inputs'
import { LAYOUT_APPLY_METHODS, LAYOUT_VIEW_REPORT_METHODS } from './methods/workspace-layout'

// Both layout-owner and sidebar-inputs build variants, so a method only one variant registers is
// still classified.
const EVERY_METHOD_NAME = new Set<string>(
  [
    ...ALL_RPC_METHODS,
    ...LAYOUT_APPLY_METHODS,
    ...LAYOUT_VIEW_REPORT_METHODS,
    ...SIDEBAR_INPUT_METHODS
  ].map((method) => method.name)
)

describe('public method coverage', () => {
  it('classifies every registered method', () => {
    const unclassified = [...EVERY_METHOD_NAME].filter((name) => classifyMethod(name) === undefined)
    expect(unclassified.toSorted()).toEqual([])
  })

  it('has no classification entry for a method that does not exist', () => {
    const stale = Object.keys(METHOD_CLASSIFICATION).filter((name) => !EVERY_METHOD_NAME.has(name))
    expect(stale.toSorted()).toEqual([])
  })

  it('backs every public spec with a registered method and the method own params schema', () => {
    const paramsByMethod: Readonly<Record<string, unknown>> = RPC_PARAMS_BY_METHOD
    for (const spec of PUBLIC_METHOD_SPECS) {
      expect(EVERY_METHOD_NAME.has(spec.method), `${spec.method} is not registered`).toBe(true)
      if (Object.hasOwn(paramsByMethod, spec.method)) {
        expect(spec.params, `${spec.method} params`).toBe(paramsByMethod[spec.method])
      }
    }
  })

  it('gives every public command a distinct cliPath', () => {
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const spec of PUBLIC_METHOD_SPECS) {
      const key = spec.cliPath.join(' ')
      const other = seen.get(key)
      if (other !== undefined) {
        collisions.push(`${key}: ${other} and ${spec.method}`)
      }
      seen.set(key, spec.method)
    }
    expect(collisions).toEqual([])
  })
})
