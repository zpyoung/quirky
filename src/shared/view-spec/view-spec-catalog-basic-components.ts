import {
  BUTTON_VARIANTS,
  CALLOUT_TONES,
  ITEM_STATE_SHAPE,
  STATUS_STATES,
  STEP_STATES,
  TONES,
  type BasicNodeType,
  type Component
} from './view-spec-catalog-schema'
import {
  ACTION_NAME_PATTERN,
  MAX_CHART_POINTS,
  MAX_COLUMNS,
  MAX_LIST_ITEMS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS
} from './view-spec-types'

/** Layout, text, data and input components. */
export const BASIC_COMPONENTS: Record<BasicNodeType, Component> = {
  stack: {
    summary: 'Vertical container; children render top to bottom.',
    container: 'any',
    shape: {},
    example: { type: 'stack', children: [{ type: 'markdown', props: { text: 'Hello' } }] }
  },
  columns: {
    summary: `Side-by-side container; each child is one column, at most ${MAX_COLUMNS}.`,
    container: 'columns',
    shape: {},
    example: {
      type: 'columns',
      children: [
        { type: 'stat', props: { label: 'Passed', value: '120' } },
        { type: 'stat', props: { label: 'Failed', value: '2', tone: 'bad' } }
      ]
    }
  },
  section: {
    summary: 'Titled container.',
    container: 'any',
    shape: { title: { kind: 'string', required: true, max: 120 } },
    example: {
      type: 'section',
      props: { title: 'Details' },
      children: [{ type: 'markdown', props: { text: 'Notes' } }]
    }
  },
  markdown: {
    summary:
      'Formatted text. Links must be absolute http(s) URLs and ask the user before opening; images and raw HTML are dropped. Math written as $x^2$ or $$x^2$$ is typeset.',
    shape: { text: { kind: 'string', required: true, markdown: true } },
    example: {
      type: 'markdown',
      props: { text: 'See the [docs](https://example.com/docs) for **details**.' }
    }
  },
  kv: {
    summary: 'Key and value rows.',
    shape: {
      items: {
        kind: 'list',
        of: { key: { kind: 'string', required: true }, value: { kind: 'string', required: true } },
        min: 1,
        max: MAX_LIST_ITEMS,
        what: 'items'
      }
    },
    example: {
      type: 'kv',
      props: {
        items: [
          { key: 'Branch', value: 'main' },
          { key: 'Commit', value: 'a1b2c3d' }
        ]
      }
    }
  },
  table: {
    summary: `Header row plus data rows; every row has one cell per column, at most ${MAX_TABLE_ROWS} rows.`,
    shape: {
      columns: { kind: 'strings', min: 1, max: MAX_TABLE_COLUMNS },
      rows: { kind: 'matrix', max: MAX_TABLE_ROWS }
    },
    example: {
      type: 'table',
      props: {
        columns: ['Package', 'Size'],
        rows: [
          ['zxcvbn', '14 KB'],
          ['date-fns-tz', '21 KB']
        ]
      }
    }
  },
  stat: {
    summary: 'One headline number with a label.',
    shape: {
      label: { kind: 'string', required: true, max: 80 },
      value: { kind: 'string', required: true, max: 80 },
      delta: { kind: 'string', max: 80 },
      tone: { kind: 'enum', values: TONES }
    },
    example: {
      type: 'stat',
      props: { label: 'Total (gzip)', value: '412 KB', delta: '+38 KB', tone: 'bad' }
    }
  },
  'status-list': {
    summary: 'Rows with a status dot.',
    shape: {
      items: {
        kind: 'list',
        of: {
          label: { kind: 'string', required: true },
          state: { kind: 'enum', values: STATUS_STATES, required: true },
          detail: { kind: 'string' }
        },
        min: 1,
        max: MAX_LIST_ITEMS,
        what: 'items'
      }
    },
    example: {
      type: 'status-list',
      props: {
        items: [
          { label: 'Build', state: 'ok' },
          { label: 'Lint', state: 'warn', detail: '3 warnings' }
        ]
      }
    }
  },
  steps: {
    summary: 'A checklist of steps with progress.',
    shape: {
      items: {
        kind: 'list',
        of: ITEM_STATE_SHAPE(STEP_STATES, 'text'),
        min: 1,
        max: MAX_LIST_ITEMS,
        what: 'items'
      }
    },
    example: {
      type: 'steps',
      props: {
        items: [
          { text: 'Reproduce', state: 'done' },
          { text: 'Fix', state: 'active' },
          { text: 'Ship', state: 'pending' }
        ]
      }
    }
  },
  code: {
    summary: 'A code block shown as text.',
    shape: { text: { kind: 'string', required: true }, language: { kind: 'string', max: 40 } },
    example: { type: 'code', props: { text: 'const answer = 42', language: 'ts' } }
  },
  'file-diff': {
    summary: 'A changed file with its unified diff text.',
    shape: {
      path: { kind: 'string', required: true, max: 400 },
      diff: { kind: 'string', required: true }
    },
    example: { type: 'file-diff', props: { path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' } }
  },
  'bar-chart': {
    summary: `Horizontal bars, one per series entry, at most ${MAX_CHART_POINTS}. Values are plain numbers.`,
    shape: {
      series: {
        kind: 'list',
        of: {
          label: { kind: 'string', required: true },
          value: { kind: 'number', required: true }
        },
        min: 1,
        max: MAX_CHART_POINTS,
        what: 'series entries'
      },
      unit: { kind: 'string', max: 16 }
    },
    example: {
      type: 'bar-chart',
      props: {
        series: [
          { label: '/settings', value: 96 },
          { label: '/login', value: 18 }
        ],
        unit: 'KB'
      }
    }
  },
  'line-chart': {
    summary: `A line through points, at most ${MAX_CHART_POINTS}. x is a label or number, y a number.`,
    shape: {
      points: {
        kind: 'list',
        of: {
          x: { kind: 'text-or-number', required: true },
          y: { kind: 'number', required: true }
        },
        min: 1,
        max: MAX_CHART_POINTS,
        what: 'points'
      },
      unit: { kind: 'string', max: 16 }
    },
    example: {
      type: 'line-chart',
      props: {
        points: [
          { x: 'Mon', y: 3 },
          { x: 'Tue', y: 5 },
          { x: 'Wed', y: 4 }
        ],
        unit: 'ms'
      }
    }
  },
  callout: {
    summary: 'A highlighted note.',
    shape: {
      tone: { kind: 'enum', values: CALLOUT_TONES, required: true },
      text: { kind: 'string', required: true }
    },
    example: {
      type: 'callout',
      props: { tone: 'warn', text: 'The cache is cold; the first run is slow.' }
    }
  },
  button: {
    summary:
      "Sends an action to the agent when clicked. If the agent is blocked in `quirky view wait`, the action is that command's result; otherwise it arrives as a message.",
    shape: {
      label: { kind: 'string', required: true, max: 80 },
      action: {
        kind: 'string',
        required: true,
        pattern: ACTION_NAME_PATTERN,
        hint: 'lowercase letters, digits and dashes, 1 to 40 characters'
      },
      variant: { kind: 'enum', values: BUTTON_VARIANTS }
    },
    example: {
      type: 'button',
      props: { label: 'Lazy-load zxcvbn', action: 'lazy-load-zxcvbn', variant: 'primary' }
    }
  },
  field: {
    summary:
      'Asks the user one question inline. The answer is sent as an action named after the question id, with data {value}. `question` is one ask question: type select|multiselect (options: {value, label, description?}[], at most 12; default), text (multiline?, pattern? (a regular expression, at most 200 characters, at most 3 variable quantifiers, no nested repetition), format?: email|url, default), number (integer?, min?, max?, default) or confirm (default). Also header?, required?. The id follows the button action pattern and is unique in the spec. Credential-shaped ids or text are refused.',
    shape: { question: { kind: 'question' } },
    example: {
      type: 'field',
      props: {
        question: {
          id: 'next-step',
          type: 'select',
          question: 'Which fix first?',
          options: [
            { value: 'lazy', label: 'Lazy-load' },
            { value: 'intl', label: 'Use Intl' }
          ]
        }
      }
    }
  }
}
