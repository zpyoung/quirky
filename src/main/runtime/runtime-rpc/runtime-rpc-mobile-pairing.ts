import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../network-exposure-guidance'
import { RuntimeRpcPairing } from './runtime-rpc-pairing'
import { pairingUnavailable, type MobilePairingOffer } from './runtime-rpc-pairing-types'

export class RuntimeRpcMobilePairing extends RuntimeRpcPairing {
  async createMobilePairingOffer(args: {
    address?: string | null
    name?: string
    rotate?: boolean
  }): Promise<MobilePairingOffer> {
    // Why: STA-2370 — creating a mobile pairing offer is the user's explicit opt-in to LAN reach, so
    // widen the loopback listener before advertising its LAN endpoint in the QR. If the widen fails the
    // listener stays on loopback, so report unavailable rather than advertise a dead LAN endpoint.
    try {
      await this.ensureNetworkExposure()
    } catch (error) {
      console.error(
        '[runtime] Network exposure failed while creating a mobile pairing offer:',
        error
      )
      return pairingUnavailable('network_exposure_failed', NETWORK_EXPOSURE_FAILED_GUIDANCE)
    }
    return this.createPairingOffer({ ...args, scope: 'mobile' })
  }
}
