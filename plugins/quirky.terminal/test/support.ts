import type { PluginSet } from '../../quirky.session/test/support'
import { SESSION_PLUGINS } from '../../quirky.session/test/support'

export * from '../../quirky.session/test/support'

/** The real session and terminal plugins over the session tests' fake worktree, agent-status and structured plugins. */
export const TERMINAL_PLUGINS: PluginSet = {
  real: ['quirky.session', 'quirky.terminal'],
  fakes: SESSION_PLUGINS.fakes
}
