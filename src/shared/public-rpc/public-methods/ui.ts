import { z } from 'zod'
import { LayoutApplyParams } from '../../rpc-contract/workspace-layout-params'
import { definePublicMethod, type PublicMethodSpec } from '../public-method-spec'
import { UiStateSnapshotSchema } from '../ui-state'

export const UiListActionsParams = z.object({
  /** Keep only actions the renderer can run right now. */
  available: z.boolean().optional(),
  /** Workspace the availability is judged against; the active workspace when absent. */
  workspace: z.string().min(1).optional()
})

export const UiRunActionParams = z.object({
  actionId: z.string().min(1),
  /** Required by actions that name a workspace, such as `workspace.delete`. */
  workspace: z.string().min(1).optional()
})

export const UiListActionsResultSchema = z.object({
  actions: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      available: z.boolean(),
      reason: z.string().optional(),
      destructive: z.boolean()
    })
  )
})

export const UiRunActionResultSchema = z.object({ claimed: z.literal(true) })

const UI_STATE_SPEC = definePublicMethod({
  method: 'ui.state',
  cliPath: ['ui', 'state'],
  summary: 'Show what the user is looking at: workspace, view, tab, pane and panels.',
  stability: 'stable',
  effect: 'read',
  params: null,
  result: UiStateSnapshotSchema,
  errors: ['unavailable', 'timeout']
})

const UI_LIST_ACTIONS_SPEC = definePublicMethod({
  method: 'ui.listActions',
  cliPath: ['action', 'list'],
  summary: 'List app actions (the keybinding catalog) and whether each can run right now.',
  stability: 'stable',
  effect: 'read',
  params: UiListActionsParams,
  result: UiListActionsResultSchema,
  errors: ['unavailable', 'timeout', 'not_found']
})

// Destructiveness depends on the action id, so the gate asks this method's previewer instead.
const UI_RUN_ACTION_SPEC = definePublicMethod({
  method: 'ui.runAction',
  cliPath: ['action', 'run'],
  summary: 'Run an app action by id, as if its shortcut had been pressed.',
  stability: 'stable',
  effect: 'mutate',
  params: UiRunActionParams,
  result: UiRunActionResultSchema,
  positionals: ['actionId'],
  destructive: undefined,
  approvalCategory: undefined,
  errors: ['invalid_argument', 'not_found', 'unavailable', 'timeout', 'needs_confirmation']
})

// A runtime without the method answers method_not_found, which reports as unavailable/capability_missing.
const LAYOUT_APPLY_SPEC = definePublicMethod({
  method: 'layout.apply',
  cliPath: ['layout', 'apply'],
  summary: 'Apply one layout command to a workspace (split, move, close or rename panes and tabs).',
  stability: 'unstable',
  effect: 'mutate',
  params: LayoutApplyParams,
  result: z.unknown(),
  errors: ['invalid_argument', 'not_found', 'conflict', 'unavailable']
})

export const UI_PUBLIC_METHODS: readonly PublicMethodSpec[] = [
  UI_STATE_SPEC,
  UI_LIST_ACTIONS_SPEC,
  UI_RUN_ACTION_SPEC,
  LAYOUT_APPLY_SPEC
]
