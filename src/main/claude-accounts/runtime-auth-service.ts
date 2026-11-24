import { getAppEnvironment } from '../../shared/app-environment'
import type { Store } from '../persistence'
import { ClaudeProfileRouter } from './claude-profile-router'
import { installClaudeProfileRouter } from './claude-profile-installed-router'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

/** `configDir` is the CLAUDE_CONFIG_DIR value; `readPath` is where this host reads it. */
export type ClaudeAccountFolder = { configDir: string; readPath: string }

/** Routes Claude launches on this host to the selected account folder. */
export class ClaudeRuntimeAuthService {
  readonly router: ClaudeProfileRouter
  private readonly dataRoot = getAppEnvironment().getPath('userData')
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(store: Pick<Store, 'getSettings'>) {
    this.router = new ClaudeProfileRouter({
      getSettings: () => store.getSettings(),
      dataRoot: this.dataRoot
    })
    installClaudeProfileRouter(this.router)
    void this.publishAll().catch((error: unknown) => {
      console.warn('[claude-runtime-auth] Failed to publish the Claude account selection:', error)
    })
  }

  prepareForClaudeLaunch(
    _target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    return this.router.prepareLaunch()
  }

  async prepareForRateLimitFetch(
    _target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    try {
      return await this.router.preparation()
    } catch (error) {
      // Why not thrown: one usage cycle polls every provider, so one account must not stop it.
      return {
        configDir: '',
        envPatch: {},
        provenance: 'profile:unavailable',
        usageError: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /** Rewrites the which-account file after the selection changed. */
  async syncForCurrentSelection(_target?: ClaudeAccountSelectionTarget): Promise<void> {
    await this.serializeMutation(async () => {
      this.router.publish()
    })
  }

  async publishAll(): Promise<void> {
    await this.serializeMutation(async () => {
      this.router.publish()
    })
  }

  /** Creates and sets up an account's folder so Claude can sign in to it. */
  async prepareAccountFolder(
    accountId: string,
    _target: ClaudeAccountSelectionTarget
  ): Promise<ClaudeAccountFolder> {
    const home = await this.router.prepareAccount(accountId)
    return { configDir: home, readPath: home }
  }

  async removeAccountFolder(
    accountId: string,
    _target: ClaudeAccountSelectionTarget
  ): Promise<void> {
    await this.router.removeAccount(accountId)
  }

  /** System default's folder: skills and plugins install there and are linked into accounts. */
  getRuntimeConfigDir(_target?: ClaudeAccountSelectionTarget): string {
    return this.router.systemDefaultHome()
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }
}
