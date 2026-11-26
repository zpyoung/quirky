import { ACTION_CATALOG, isCatalogedActionId } from '../../../shared/keybindings/action-catalog'
import { UiRunActionParams } from '../../../shared/public-rpc/public-methods/ui'
import {
  registerApprovalCategoryResolver,
  registerDestructiveResolver
} from './destructive-previewers'

// agentApprovalPolicy is listed so an agent cannot switch approvals off without being asked.
const SECURITY_SETTING_KEYS = [
  'agentDefaultEnv',
  'agentDefaultArgs',
  'nativeChatPermissionMode',
  'agentStatusHooksEnabled',
  'agentApprovalPolicy'
] as const

registerDestructiveResolver('ui.runAction', (params) => {
  const parsed = UiRunActionParams.safeParse(params)
  if (!parsed.success || !isCatalogedActionId(parsed.data.actionId)) {
    return undefined
  }
  return ACTION_CATALOG[parsed.data.actionId].destructive
})

registerApprovalCategoryResolver('settings.update', (params) => {
  if (typeof params !== 'object' || params === null) {
    return undefined
  }
  const touched = SECURITY_SETTING_KEYS.some(
    (key) => key in params && (params as Record<string, unknown>)[key] !== undefined
  )
  return touched ? 'security-settings' : undefined
})
