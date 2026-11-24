import { describe, expect, it } from 'vitest'
import { QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/quirkyd-managed-launch-env'
import { quirkydWsPortOptions } from './quirkyd-ws-port-policy'

describe('quirkydWsPortOptions', () => {
  it('leaves the default port and its fallback alone without --port', () => {
    expect(quirkydWsPortOptions(undefined, {})).toEqual({})
  })

  it('requires an operator --port', () => {
    expect(quirkydWsPortOptions(7001, {})).toEqual({
      wsPort: 7001,
      preferPinnedWsPort: true,
      requirePinnedWsPort: true
    })
  })

  it('lets a managed launch fall back when its port is taken', () => {
    expect(
      quirkydWsPortOptions(6768, {
        [QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV]: '/home/u/.quirky-remote'
      })
    ).toEqual({ wsPort: 6768, preferPinnedWsPort: true })
  })
})
