import type { HostPowerListener, PluginHostPower } from '@quirky/protocol'
import type { HostPowerTransition, NativeHostPowerSource } from './host-power-contracts'

type Activation = {
  pluginId: string
  isRevoked: () => boolean
  active: boolean
  subscriptions: Set<Subscription>
}

type Subscription = {
  activation: Activation
  listener: HostPowerListener
  active: boolean
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || error.name
    return String(error)
  } catch {
    return '<unprintable error>'
  }
}

/** Synchronous in-process host-power broadcaster with per-plugin activation revocation. */
export class HostPowerService {
  readonly #log: (message: string) => void
  readonly #supported: boolean
  readonly #subscriptions = new Set<Subscription>()
  readonly #activations = new Map<string, Set<Activation>>()
  #suspended = false
  #disposed = false
  #stopSource: (() => void) | null = null

  constructor(log: (message: string) => void, source: NativeHostPowerSource | null) {
    this.#log = log
    this.#supported = source !== null
    if (source) this.#stopSource = source.start(transition => this.#transition(transition))
  }

  forPlugin(pluginId: string, isRevoked: () => boolean): PluginHostPower {
    const activation: Activation = {
      pluginId,
      isRevoked,
      active: true,
      subscriptions: new Set()
    }
    let activations = this.#activations.get(pluginId)
    if (!activations) {
      activations = new Set()
      this.#activations.set(pluginId, activations)
    }
    activations.add(activation)

    const thisService = this
    return {
      get supported() {
        thisService.#assertUsable(activation)
        return thisService.#supported
      },
      get suspended() {
        thisService.#assertUsable(activation)
        return thisService.#suspended
      },
      subscribe: listener => {
        this.#assertUsable(activation)
        const subscription: Subscription = { activation, listener, active: true }
        activation.subscriptions.add(subscription)
        this.#subscriptions.add(subscription)
        if (this.#suspended) this.#invoke(subscription, 'suspend')
        return () => this.#removeSubscription(subscription)
      }
    }
  }
  revoke(pluginId: string): void {
    const activations = this.#activations.get(pluginId)
    if (!activations) return
    for (const activation of [...activations]) this.#retireActivation(activation)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const activations of [...this.#activations.values()]) {
      for (const activation of [...activations]) this.#retireActivation(activation)
    }
    const stopSource = this.#stopSource
    this.#stopSource = null
    if (stopSource) {
      try {
        stopSource()
      } catch (error) {
        this.#logSafely(`Host power source disposal failed: ${errorMessage(error)}`)
      }
    }
  }

  #transition(transition: HostPowerTransition): void {
    if (this.#disposed || this.#suspended === (transition === 'suspend')) return
    this.#suspended = transition === 'suspend'
    for (const subscription of [...this.#subscriptions]) {
      if (!subscription.active || !this.#activationIsUsable(subscription.activation)) continue
      this.#invoke(subscription, transition)
    }
  }

  #assertUsable(activation: Activation): void {
    if (this.#disposed) throw new Error('Host power service is disposed')
    if (!activation.active) throw new Error(`Host power capability for plugin "${activation.pluginId}" has been revoked`)
    if (this.#externalRevocation(activation)) {
      this.#retireActivation(activation)
      throw new Error(`Host power capability for plugin "${activation.pluginId}" has been revoked`)
    }
  }

  #activationIsUsable(activation: Activation): boolean {
    if (this.#disposed || !activation.active) return false
    if (!this.#externalRevocation(activation)) return true
    this.#retireActivation(activation)
    return false
  }

  #externalRevocation(activation: Activation): boolean {
    try {
      return activation.isRevoked()
    } catch (error) {
      this.#logSafely(`Host power revocation check for plugin "${activation.pluginId}" failed; revoking activation: ${errorMessage(error)}`)
      return true
    }
  }

  #retireActivation(activation: Activation): void {
    if (!activation.active) return
    activation.active = false
    for (const subscription of activation.subscriptions) {
      subscription.active = false
      this.#subscriptions.delete(subscription)
    }
    activation.subscriptions.clear()
    const activations = this.#activations.get(activation.pluginId)
    activations?.delete(activation)
    if (activations?.size === 0) this.#activations.delete(activation.pluginId)
  }

  #removeSubscription(subscription: Subscription): void {
    if (!subscription.active) return
    subscription.active = false
    subscription.activation.subscriptions.delete(subscription)
    this.#subscriptions.delete(subscription)
  }

  #invoke(subscription: Subscription, transition: HostPowerTransition): void {
    if (!subscription.active) return
    const { activation, listener } = subscription
    try {
      const result: unknown = listener[transition].call(listener)
      this.#observeReturn(result, activation.pluginId, transition)
    } catch (error) {
      this.#logSafely(`Host power ${transition} callback for plugin "${activation.pluginId}" failed synchronously: ${errorMessage(error)}`)
    }
  }

  #observeReturn(result: unknown, pluginId: string, transition: HostPowerTransition): void {
    if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return

    let then: unknown
    try {
      if (!('then' in result)) return
      then = result.then
    } catch (error) {
      this.#logSafely(`Host power ${transition} callback for plugin "${pluginId}" failed while checking its return value: ${errorMessage(error)}`)
      return
    }
    if (typeof then !== 'function') return

    this.#logSafely(`Host power ${transition} callback for plugin "${pluginId}" returned a thenable; lifecycle callbacks must complete synchronously before native acknowledgment`)
    const observed = {
      then: (resolve: (value?: unknown) => void, reject: (reason?: unknown) => void) => Reflect.apply(then, result, [resolve, reject])
    }
    try {
      void Promise.resolve(observed).catch(error => {
        this.#logSafely(`Host power ${transition} callback for plugin "${pluginId}" rejected after the synchronous boundary: ${errorMessage(error)}`)
      })
    } catch (error) {
      this.#logSafely(`Host power ${transition} callback for plugin "${pluginId}" returned a thenable that could not be observed: ${errorMessage(error)}`)
    }
  }

  #logSafely(message: string): void {
    try {
      this.#log(message)
    } catch {
      // Logging must not break a synchronous native lifecycle boundary.
    }
  }
}
