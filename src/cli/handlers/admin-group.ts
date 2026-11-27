import type { HandlerGroup } from '../handler-group-manifest'

export const ADMIN_HANDLER_GROUPS: HandlerGroup[] = [
  {
    name: 'ui-actions',
    keys: ['ui state', 'action list', 'action run', 'layout get'],
    load: async () => (await import('./ui-actions.js')).UI_ACTION_HANDLERS
  },
  {
    name: 'admin',
    keys: [
      'settings get',
      'settings set',
      'settings list',
      'plugins enable',
      'plugins disable',
      'notifications list',
      'notifications dismiss'
    ],
    load: async () => (await import('./admin.js')).ADMIN_HANDLERS
  },
  {
    name: 'tab-all-types',
    keys: ['tab focus', 'tab move', 'tab pin', 'tab unpin'],
    load: async () => (await import('./tab-all-types.js')).TAB_ALL_TYPES_HANDLERS
  }
]
