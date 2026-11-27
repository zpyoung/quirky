import { z } from 'zod'
import { definePublicMethod, type PublicMethodSpec } from '../public-method-spec'
import { SettingsUpdate } from '../../rpc-contract/client-settings-params'
import { FileDelete, FileWrite } from '../../rpc-contract/files-mutation-params'
import { FilePathSearch, FileSearch, FileTreePath } from '../../rpc-contract/files-params'
import { FileOpen } from '../../rpc-contract/files-target-params'
import { NotificationGetMissedSinceParams } from '../../rpc-contract/notifications-params'
import {
  PluginInvokeCommandParams,
  PluginSetEnabledParams
} from '../../rpc-contract/plugins-params'
import {
  ActivateTab,
  CloseTab,
  MoveTab,
  SetTabProps
} from '../../rpc-contract/session-tabs-schemas-params'

/** The runtime method `notifications.dismiss` parses; declared here because the spec and the method must share one object. */
export const NotificationDismissParams = z.object({ id: z.string().min(1) })

const SETTINGS_RESULT = z.object({ settings: z.record(z.string(), z.unknown()) })
const PLUGIN_LIST_RESULT = z.array(z.record(z.string(), z.unknown()))
const OPAQUE_RESULT = z.unknown()
const SESSION_TABS_RESULT = z.record(z.string(), z.unknown())

const COMMON_ERRORS = ['invalid_argument', 'unavailable', 'unauthorized', 'internal'] as const

/**
 * `settings.update` leaves `approvalCategory` unset on purpose: only a call that touches
 * `agentDefaultEnv`, `agentDefaultArgs`, `nativeChatPermissionMode` or `agentStatusHooksEnabled`
 * needs the `security-settings` approval, and the server decides that per call.
 */
export const ADMIN_PUBLIC_METHODS: readonly PublicMethodSpec[] = [
  definePublicMethod({
    method: 'settings.get',
    cliPath: ['settings', 'get'],
    summary: 'Read the client settings, or one setting by key',
    stability: 'stable',
    effect: 'read',
    params: null,
    result: SETTINGS_RESULT,
    errors: [...COMMON_ERRORS, 'not_found']
  }),
  definePublicMethod({
    method: 'settings.update',
    cliPath: ['settings', 'update'],
    summary: 'Change client settings',
    stability: 'stable',
    effect: 'mutate',
    params: SettingsUpdate,
    result: SETTINGS_RESULT,
    errors: [...COMMON_ERRORS, 'needs_confirmation']
  }),
  definePublicMethod({
    method: 'notifications.getMissedSince',
    cliPath: ['notifications', 'list'],
    summary: 'List notifications raised after a sequence number',
    stability: 'stable',
    effect: 'read',
    params: NotificationGetMissedSinceParams,
    result: z.object({
      notifications: z.array(z.record(z.string(), z.unknown())),
      epoch: z.string(),
      dismissedPushes: z.array(z.unknown()).optional()
    }),
    errors: [...COMMON_ERRORS]
  }),
  definePublicMethod({
    method: 'notifications.dismiss',
    cliPath: ['notifications', 'dismiss'],
    summary: 'Dismiss a notification so clients stop showing it',
    stability: 'stable',
    effect: 'mutate',
    params: NotificationDismissParams,
    result: z.object({ dismissed: z.literal(true), id: z.string() }),
    positionals: ['id'],
    errors: [...COMMON_ERRORS]
  }),
  definePublicMethod({
    method: 'plugins.list',
    cliPath: ['plugins', 'list'],
    summary: 'List installed plugins and whether each is enabled',
    stability: 'stable',
    effect: 'read',
    params: null,
    result: PLUGIN_LIST_RESULT,
    errors: [...COMMON_ERRORS]
  }),
  definePublicMethod({
    method: 'plugins.setEnabled',
    cliPath: ['plugins', 'enable'],
    summary: 'Enable or disable a plugin',
    stability: 'stable',
    effect: 'mutate',
    params: PluginSetEnabledParams,
    result: PLUGIN_LIST_RESULT,
    positionals: ['pluginKey'],
    errors: [...COMMON_ERRORS, 'not_found']
  }),
  definePublicMethod({
    method: 'plugins.invokeCommand',
    cliPath: ['plugins', 'run'],
    summary: 'Run a command a plugin registered',
    stability: 'stable',
    effect: 'mutate',
    params: PluginInvokeCommandParams,
    result: OPAQUE_RESULT,
    positionals: ['pluginKey', 'commandId'],
    errors: [...COMMON_ERRORS, 'not_found']
  }),
  definePublicMethod({
    method: 'files.readDir',
    cliPath: ['file', 'list'],
    summary: 'List the entries of a directory in a workspace',
    stability: 'stable',
    effect: 'read',
    params: FileTreePath,
    positionals: ['relativePath'],
    result: OPAQUE_RESULT,
    errors: [...COMMON_ERRORS, 'not_found']
  }),
  definePublicMethod({
    method: 'files.read',
    cliPath: ['file', 'read'],
    summary: 'Read a file in a workspace',
    stability: 'stable',
    effect: 'read',
    params: FileOpen,
    positionals: ['relativePath'],
    result: OPAQUE_RESULT,
    errors: [...COMMON_ERRORS, 'not_found']
  }),
  definePublicMethod({
    method: 'files.write',
    cliPath: ['file', 'write'],
    summary: 'Write a file in a workspace, replacing any existing content',
    stability: 'stable',
    effect: 'mutate',
    params: FileWrite,
    positionals: ['relativePath'],
    result: OPAQUE_RESULT,
    destructive: { category: 'file-overwrite-delete' },
    errors: [...COMMON_ERRORS, 'needs_confirmation', 'conflict']
  }),
  definePublicMethod({
    method: 'files.search',
    cliPath: ['file', 'search'],
    summary: 'Search file contents in a workspace',
    stability: 'stable',
    effect: 'read',
    params: FileSearch,
    result: OPAQUE_RESULT,
    errors: [...COMMON_ERRORS]
  }),
  definePublicMethod({
    method: 'files.searchPaths',
    cliPath: ['file', 'search-paths'],
    summary: 'Find files in a workspace by path',
    stability: 'stable',
    effect: 'read',
    params: FilePathSearch,
    result: OPAQUE_RESULT,
    errors: [...COMMON_ERRORS]
  }),
  definePublicMethod({
    method: 'files.delete',
    cliPath: ['file', 'delete'],
    summary: 'Delete a file or directory in a workspace',
    stability: 'stable',
    effect: 'mutate',
    params: FileDelete,
    positionals: ['relativePath'],
    result: OPAQUE_RESULT,
    destructive: { category: 'file-overwrite-delete' },
    errors: [...COMMON_ERRORS, 'needs_confirmation', 'not_found']
  }),
  definePublicMethod({
    method: 'session.tabs.listAll',
    cliPath: ['tab', 'list'],
    summary: 'List the open tabs of every type in every workspace',
    stability: 'unstable',
    effect: 'read',
    params: null,
    result: z.object({ snapshots: z.array(SESSION_TABS_RESULT) }),
    errors: [...COMMON_ERRORS]
  }),
  definePublicMethod({
    method: 'session.tabs.activate',
    cliPath: ['tab', 'focus'],
    summary: 'Make a tab the active tab of its group',
    stability: 'unstable',
    effect: 'mutate',
    params: ActivateTab,
    result: SESSION_TABS_RESULT,
    positionals: ['tabId'],
    errors: [...COMMON_ERRORS, 'not_found']
  }),
  definePublicMethod({
    method: 'session.tabs.close',
    cliPath: ['tab', 'close'],
    summary: 'Close a tab',
    stability: 'unstable',
    effect: 'mutate',
    params: CloseTab,
    result: SESSION_TABS_RESULT,
    errors: [...COMMON_ERRORS, 'not_found']
  }),
  definePublicMethod({
    method: 'session.tabs.move',
    cliPath: ['tab', 'move'],
    summary: 'Move a tab to another group or position',
    stability: 'unstable',
    effect: 'mutate',
    params: MoveTab,
    result: z.object({ moved: z.literal(true) }),
    positionals: ['tabId'],
    errors: [...COMMON_ERRORS, 'not_found']
  }),
  definePublicMethod({
    method: 'session.tabs.setTabProps',
    cliPath: ['tab', 'pin'],
    summary: 'Pin a tab; `tab unpin` clears the pin through the same method',
    stability: 'unstable',
    effect: 'mutate',
    params: SetTabProps,
    result: SESSION_TABS_RESULT,
    positionals: ['tabId'],
    errors: [...COMMON_ERRORS, 'not_found']
  })
]
