import type { HandlerGroup } from '../handler-group-manifest'

export const CHAT_HANDLER_GROUPS: HandlerGroup[] = [
  {
    name: 'chat',
    keys: [
      'chat list',
      'chat create',
      'chat resume',
      'chat send',
      'chat cancel',
      'chat rewind',
      'chat clear',
      'chat history',
      'chat options get',
      'chat options set',
      'chat requests',
      'chat respond'
    ],
    load: async () => (await import('./chat.js')).CHAT_HANDLERS
  }
]
