import type { ProcessScope } from '../../../../scripts/test-support/process-scope'
import { createCodexRunner } from '../../../quirky.structured/codex-runner'
import type { StructuredRunner, StructuredRunnerFactory } from '../../../quirky.structured/runner'
import { createScriptedStructuredRunnerFactory } from '../owner-fakes/scripted-structured-runner'

/** Keeps the owner scripted while worker sessions use the production Codex JSONL runner. */
export function createOwnerWorkerStructuredRunnerFactory(scopeForProvider: () => ProcessScope): StructuredRunnerFactory {
  return (context) => {
    let claude: StructuredRunner | null = null
    const claudeRunner = (): StructuredRunner => {
      claude ??= createScriptedStructuredRunnerFactory(scopeForProvider(), () => {})(context)
      return claude
    }
    const codex = createCodexRunner(context)
    const providers = new Map<string, 'claude' | 'codex'>()
    const runnerFor = (sessionId: string): StructuredRunner => {
      const provider = providers.get(sessionId)
      if (!provider) throw new Error(`no structured provider owns ${sessionId}`)
      return provider === 'codex' ? codex : claudeRunner()
    }
    return {
      async start(session, prompt, options) {
        const provider = session.agent === 'codex' ? 'codex' : 'claude'
        providers.set(session.id, provider)
        try {
          await (provider === 'codex' ? codex : claudeRunner()).start(session, prompt, options)
        } catch (error) {
          providers.delete(session.id)
          throw error
        }
      },
      send(sessionId, text) {
        return runnerFor(sessionId).send(sessionId, text)
      },
      async stop(sessionId) {
        const provider = providers.get(sessionId)
        if (!provider) return
        try {
          await runnerFor(sessionId).stop(sessionId)
        } finally {
          providers.delete(sessionId)
        }
      }
    }
  }
}
