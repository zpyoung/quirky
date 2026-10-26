import type { DistroInfo, DistroInspection, DistroManifest } from '@quirky/protocol'
import { internal } from '../errors'
import type { Store } from '../store'
import type { PluginHost } from './host'

export type DistroServiceOptions = {
  home: string
  store: Pick<Store, 'getDistro' | 'putDistro' | 'deleteDistro'>
  plugins: PluginHost
  log: (message: string) => void
  /** True in safe mode: the stored distro is kept but not applied. */
  safeMode: boolean
}

/** Installs, lists and removes the distro layer and serves it to the host, settings and UI model. */
export class DistroService {
  constructor(private readonly options: DistroServiceOptions) {}

  /** Reads a distro directory and everything installing it would change; installs nothing. */
  inspect(_path: string): Promise<DistroInspection> {
    throw internal('not implemented: DistroService.inspect')
  }

  install(_path: string): Promise<DistroInfo> {
    throw internal('not implemented: DistroService.install')
  }

  list(): DistroInfo[] {
    return []
  }

  remove(_id: string): Promise<void> {
    throw internal('not implemented: DistroService.remove')
  }

  /** The manifest being applied, or null with no distro installed or in safe mode. */
  active(): DistroManifest | null {
    return null
  }
}
