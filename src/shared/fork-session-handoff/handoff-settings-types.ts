import type { TuiAgent } from '../tui-agent'

/** A reusable operator-authored instruction block for a session handoff. */
export type ForkSessionHandoffTemplate = {
  id: string
  name: string
  body: string
}

/** An atomic write-only change to the persisted template catalog. */
export type ForkSessionHandoffTemplateMutation =
  | {
      type: 'add'
      template: ForkSessionHandoffTemplate
      seedTemplates: ForkSessionHandoffTemplate[]
    }
  | {
      type: 'update'
      id: string
      patch: Pick<ForkSessionHandoffTemplate, 'name' | 'body'>
      seedTemplates: ForkSessionHandoffTemplate[]
    }
  | {
      type: 'remove'
      id: string
      seedTemplates: ForkSessionHandoffTemplate[]
    }
  | { type: 'reset' }

/** Controls which optional workspace context Quirky adds to a handoff brief. */
export type ForkSessionHandoffIncludeToggles = {
  repoState: boolean
  diffBodies: boolean
  openEditorTabs: boolean
}

/** Global preferences for session handoffs. Context mode intentionally resets per handoff. */
export type ForkSessionHandoffSettings = {
  lastAgent?: TuiAgent
  includeToggles?: ForkSessionHandoffIncludeToggles
  lastTemplateId?: string | null
  templates?: ForkSessionHandoffTemplate[]
  /** Write-only transport field; the settings merge applies and removes it before persistence. */
  templateMutation?: ForkSessionHandoffTemplateMutation
}

export const DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES: ForkSessionHandoffIncludeToggles = {
  repoState: true,
  diffBodies: false,
  openEditorTabs: true
}
