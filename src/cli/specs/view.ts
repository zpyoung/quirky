import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const SESSION_NOTE =
  'Runs only inside a Quirky chat: the chat is the one named by QUIRKY_AGENT_SESSION_ID.'
const SPEC_NOTE =
  'The spec is checked locally before anything is sent. A refused spec prints its errors and exits non-zero.'

export const VIEW_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['view', 'open'],
    summary: 'Show a visual (page, diagram or view spec) in this chat',
    usage:
      'quirky view open (--spec <@file|json> | --html <file> | --mermaid <file>) [--title <text>] [--placement inline|pane] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'spec', 'html', 'mermaid', 'title', 'placement'],
    notes: [
      SESSION_NOTE,
      SPEC_NOTE,
      '--html wraps a file as an html node and --mermaid wraps a file as a diagram node; the title defaults to the file name.'
    ],
    examples: [
      'quirky view open --spec @view.json',
      'quirky view open --html report.html --title "Report" --placement pane',
      'quirky view open --mermaid flow.mmd'
    ]
  },
  {
    path: ['view', 'update'],
    summary: 'Replace a view with a new spec as its next version',
    usage:
      'quirky view update --id <viewId> (--spec <@file|json> | --html <file> | --mermaid <file>) [--title <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'spec', 'html', 'mermaid', 'title'],
    notes: [SESSION_NOTE, SPEC_NOTE, 'A closed view cannot be updated.'],
    examples: ['quirky view update --id <viewId> --spec @view.json']
  },
  {
    path: ['view', 'patch'],
    summary: 'Change part of a view with add, replace and remove operations',
    usage: 'quirky view patch --id <viewId> --patch <@file|json> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'patch'],
    notes: [
      SESSION_NOTE,
      'The patch is {"ops":[{"op":"add|replace|remove","path":"/root/children/0/props/text","value":...}]}, applied all or nothing, and the result must be a valid spec.'
    ],
    examples: [
      'quirky view patch --id <viewId> --patch @patch.json',
      `quirky view patch --id <viewId> --patch '{"ops":[{"op":"replace","path":"/title","value":"Done"}]}'`
    ]
  },
  {
    path: ['view', 'get'],
    summary: "Print a view's current spec, version and whether it is closed",
    usage: 'quirky view get --id <viewId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    notes: [SESSION_NOTE],
    examples: ['quirky view get --id <viewId> --json']
  },
  {
    path: ['view', 'close'],
    summary: 'Close a view; closing a closed view succeeds',
    usage: 'quirky view close --id <viewId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    notes: [SESSION_NOTE],
    examples: ['quirky view close --id <viewId>']
  }
]
