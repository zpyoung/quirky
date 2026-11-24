import { ipcMain } from 'electron'
import { z } from 'zod'
import { HOSTED_REVIEW_AGENT_CHANNELS } from '../../shared/fork-hosted-review-sitter/api'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { launchHostedReviewSitterFixAgent } from './agent'

const MAX_ID_LENGTH = 4_096
const MAX_PROMPT_LENGTH = 512 * 1024

const AgentLaunchSchema = z.object({
  repoId: z.string().trim().min(1).max(MAX_ID_LENGTH),
  worktreeId: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ID_LENGTH * 4),
  agent: z.string().refine(isTuiAgent),
  basePrompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  title: z.string().trim().min(1).max(200).optional()
})

/** Register only the explicitly human-invoked manual fix path. */
export function registerHostedReviewAgentIpcHandlers(
  runtime: QuirkyRuntimeService,
  store: Store
): void {
  ipcMain.removeHandler(HOSTED_REVIEW_AGENT_CHANNELS.launchFix)
  ipcMain.handle(HOSTED_REVIEW_AGENT_CHANNELS.launchFix, (_event, value: unknown) => {
    const input = AgentLaunchSchema.parse(value)
    if (!store.getRepo(input.repoId)) {
      throw new Error('Invalid hosted review agent repository identity')
    }
    return launchHostedReviewSitterFixAgent(runtime, store, input)
  })
}
