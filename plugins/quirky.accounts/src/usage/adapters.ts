import { fetchClaudeUsage } from './claude-adapter'
import { fetchCodexUsage } from './codex-adapter'
import { fetchAntigravityUsage, fetchGeminiUsage, fetchKimiUsage } from './local-adapters'
import { ProviderProcessOwner, createProviderRuntime } from './process'
import { fetchWebProvider } from './web-adapters'
import type { ProviderSnapshot, UsageProvider, UsageTarget } from './types'

export async function fetchProviderUsage(
  provider: UsageProvider,
  target: UsageTarget,
  processes: ProviderProcessOwner,
  signal: AbortSignal,
  dataDir: string,
  geminiOAuthEnabled: boolean
): Promise<ProviderSnapshot> {
  const runtime = createProviderRuntime(processes, signal)
  switch (provider) {
    case 'claude':
      return fetchClaudeUsage(runtime, target)
    case 'codex':
      return fetchCodexUsage(runtime, target)
    case 'gemini':
      return fetchGeminiUsage(runtime, geminiOAuthEnabled)
    case 'antigravity':
      return fetchAntigravityUsage(runtime)
    case 'opencode-go':
    case 'minimax':
    case 'grok':
    case 'cursor':
    case 'zcode':
      return fetchWebProvider(provider, runtime, dataDir)
    case 'kimi':
      return fetchKimiUsage(runtime)
  }
}
