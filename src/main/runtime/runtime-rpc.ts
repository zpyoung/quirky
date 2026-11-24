// Why: the single security boundary for the bundled CLI — auth-token enforcement, metadata publication, transport orchestration.
import { RuntimeRpcShutdown } from './runtime-rpc/runtime-rpc-shutdown'
import type { QuirkyRuntimeRpcServerOptions } from './runtime-rpc/runtime-rpc-pairing-types'

export class QuirkyRuntimeRpcServer extends RuntimeRpcShutdown {
  constructor(options: QuirkyRuntimeRpcServerOptions) {
    super(options)
  }
}
