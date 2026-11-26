import {
  CAPTION_FIELD,
  FILE_STATUSES,
  ID_FIELD,
  SKETCH_ELEMENT_KINDS,
  TONE_FIELD,
  type Component,
  type VisualNodeType
} from './view-spec-catalog-schema'
import {
  MAX_CHART_POINTS,
  MAX_CODE_BYTES,
  MAX_DIAGRAM_BYTES,
  MAX_HTML_BYTES,
  MAX_HTML_HEIGHT,
  MAX_MATRIX_COLUMNS,
  MAX_SKETCH_SIDE,
  MIN_HTML_HEIGHT,
  MIN_SKETCH_SIDE
} from './view-spec-types'

/** Components that draw something: diagrams, images, pages, timelines, boards and similar. */
export const VISUAL_COMPONENTS: Record<VisualNodeType, Component> = {
  diagram: {
    summary:
      'A Mermaid diagram (flowchart, sequence, class, state and the rest), drawn by Quirky. Node labels are plain text, and a source that could load an image or other remote content (img: shapes, <img>, url()) is refused. Quirky does not parse the source here: a diagram that fails to draw is reported back to you as a message, so fix it with `quirky view update` or `patch`.',
    props: {
      source: { kind: 'string', required: true, max: MAX_DIAGRAM_BYTES, bytes: true },
      caption: CAPTION_FIELD
    },
    example: {
      type: 'diagram',
      props: {
        source: 'flowchart LR\n  client[Client app] --> daemon[Daemon]',
        caption: 'Request path'
      }
    }
  },
  image: {
    summary:
      'A picture from the worktree. `path` is relative to the worktree root, never starts with / or contains .., and ends in png, jpg, jpeg, gif, webp or svg. `alt` describes it.',
    props: {
      path: { kind: 'string', required: true, max: 400 },
      alt: { kind: 'string', required: true, max: 200 },
      caption: CAPTION_FIELD
    },
    example: {
      type: 'image',
      props: { path: 'docs/shots/login.png', alt: 'The login screen', caption: 'Before the change' }
    }
  },
  html: {
    summary: `A small page or prototype in a sandboxed frame with no network. It may carry inline CSS and, when \`interactive\` is true, inline scripts. Nothing may load from http:, https: or // (src, href, action, srcset, poster or CSS url()); inline images as data: URLs. An element with a data-point attribute can be pointed at; add data-point-label for its name. height is in pixels (${MIN_HTML_HEIGHT} to ${MAX_HTML_HEIGHT}).`,
    props: {
      html: { kind: 'string', required: true, max: MAX_HTML_BYTES, bytes: true },
      interactive: { kind: 'boolean', required: true },
      height: { kind: 'number', min: MIN_HTML_HEIGHT, max: MAX_HTML_HEIGHT }
    },
    example: {
      type: 'html',
      props: {
        html: '<button data-point="save" data-point-label="Save">Save</button>',
        interactive: true,
        height: 160
      }
    }
  },
  'live-preview': {
    summary:
      'A running local app shown in a browser view. `url` must be http:// on localhost, 127.0.0.1 or a *.quirky.localhost host.',
    props: { url: { kind: 'string', required: true, max: 2048 }, caption: CAPTION_FIELD },
    example: {
      type: 'live-preview',
      props: { url: 'http://localhost:5173/', caption: 'The dev server' }
    }
  },
  timeline: {
    summary:
      'Items on a time axis, at most 100. `start` and `end` are plain labels or dates; items keep the order given.',
    props: {
      items: {
        kind: 'list',
        of: {
          id: ID_FIELD,
          label: { kind: 'string', required: true, max: 120 },
          start: { kind: 'string', required: true, max: 40 },
          end: { kind: 'string', max: 40 },
          tone: TONE_FIELD
        },
        min: 1,
        max: 100,
        what: 'items'
      }
    },
    example: {
      type: 'timeline',
      props: {
        items: [
          { id: 'design', label: 'Design', start: '2026-11-02', end: '2026-11-06', tone: 'good' },
          { label: 'Launch', start: '2026-11-23' }
        ]
      }
    }
  },
  board: {
    summary: 'Columns of cards, like a kanban board: at most 8 columns of at most 50 cards.',
    props: {
      columns: {
        kind: 'list',
        of: {
          title: { kind: 'string', required: true, max: 80 },
          cards: {
            kind: 'list',
            of: {
              id: ID_FIELD,
              title: { kind: 'string', required: true, max: 120 },
              detail: { kind: 'string', max: 400 },
              tone: TONE_FIELD
            },
            min: 0,
            max: 50,
            what: 'cards'
          }
        },
        min: 1,
        max: 8,
        what: 'columns'
      }
    },
    example: {
      type: 'board',
      props: {
        columns: [
          { title: 'To do', cards: [{ id: 'docs', title: 'Write docs' }] },
          { title: 'Done', cards: [] }
        ]
      }
    }
  },
  matrix: {
    summary: `A grid of short cells: rows by named columns, at most ${MAX_MATRIX_COLUMNS} columns and 50 rows. Every row has one cell per column. \`highlight\` lists column names whose cell in that row stands out.`,
    props: {
      columns: { kind: 'strings', min: 1, max: MAX_MATRIX_COLUMNS },
      rows: {
        kind: 'list',
        of: {
          label: { kind: 'string', required: true, max: 120 },
          cells: { kind: 'strings', min: 1, max: MAX_MATRIX_COLUMNS },
          highlight: { kind: 'strings', min: 0, max: MAX_MATRIX_COLUMNS, optional: true }
        },
        min: 1,
        max: 50,
        what: 'rows'
      }
    },
    example: {
      type: 'matrix',
      props: {
        columns: ['Claude', 'Codex'],
        rows: [{ label: 'Patch', cells: ['yes', 'no'], highlight: ['Codex'] }]
      }
    }
  },
  'annotated-code': {
    summary:
      'Code with notes attached to lines. `lines` is a 1-based line "4" or a range "3-7" inside the code; at most 50 notes.',
    props: {
      language: { kind: 'string', required: true, max: 40 },
      code: { kind: 'string', required: true, max: MAX_CODE_BYTES, bytes: true },
      notes: {
        kind: 'list',
        of: {
          lines: { kind: 'string', required: true, max: 20 },
          note: { kind: 'string', required: true, max: 400 }
        },
        min: 0,
        max: 50,
        what: 'notes'
      }
    },
    example: {
      type: 'annotated-code',
      props: {
        language: 'ts',
        code: 'const a = 1\nconst b = a + 1\n',
        notes: [{ lines: '2', note: 'Uses a.' }]
      }
    }
  },
  'file-map': {
    summary:
      'Paths with what happened to each, at most 300. status is added, modified, deleted, renamed or touched.',
    props: {
      entries: {
        kind: 'list',
        of: {
          path: { kind: 'string', required: true, max: 400 },
          status: { kind: 'enum', values: FILE_STATUSES, required: true },
          note: { kind: 'string', max: 200 }
        },
        min: 1,
        max: 300,
        what: 'entries'
      }
    },
    example: {
      type: 'file-map',
      props: {
        entries: [
          { path: 'src/a.ts', status: 'modified', note: 'new check' },
          { path: 'src/b.ts', status: 'added' }
        ]
      }
    }
  },
  plot: {
    summary: 'An x/y plot of up to 8 series, each with 2 to 500 numeric points.',
    props: {
      xLabel: { kind: 'string', max: 80 },
      yLabel: { kind: 'string', max: 80 },
      series: {
        kind: 'list',
        of: {
          label: { kind: 'string', required: true, max: 80 },
          points: {
            kind: 'list',
            of: { x: { kind: 'number', required: true }, y: { kind: 'number', required: true } },
            min: 2,
            max: MAX_CHART_POINTS,
            what: 'points'
          }
        },
        min: 1,
        max: 8,
        what: 'series'
      }
    },
    example: {
      type: 'plot',
      props: {
        xLabel: 'Request',
        yLabel: 'ms',
        series: [
          {
            label: 'p50',
            points: [
              { x: 1, y: 12 },
              { x: 2, y: 14 }
            ]
          }
        ]
      }
    }
  },
  sketch: {
    summary: `A rough hand-drawn diagram on a width by height canvas (${MIN_SKETCH_SIDE} to ${MAX_SKETCH_SIDE}), at most 200 shapes. box and ellipse use x, y, w and h; line and arrow run from x, y to x2, y2; text puts its label at x, y.`,
    props: {
      width: { kind: 'number', required: true, min: MIN_SKETCH_SIDE, max: MAX_SKETCH_SIDE },
      height: { kind: 'number', required: true, min: MIN_SKETCH_SIDE, max: MAX_SKETCH_SIDE },
      shapes: {
        kind: 'list',
        of: {
          id: ID_FIELD,
          kind: { kind: 'enum', values: SKETCH_ELEMENT_KINDS, required: true },
          x: { kind: 'number', required: true },
          y: { kind: 'number', required: true },
          w: { kind: 'number' },
          h: { kind: 'number' },
          x2: { kind: 'number' },
          y2: { kind: 'number' },
          label: { kind: 'string', max: 200 }
        },
        min: 1,
        max: 200,
        what: 'shapes'
      }
    },
    example: {
      type: 'sketch',
      props: {
        width: 200,
        height: 100,
        shapes: [
          { id: 'frame', kind: 'box', x: 10, y: 10, w: 80, h: 40, label: 'Daemon' },
          { kind: 'arrow', x: 90, y: 30, x2: 150, y2: 30 }
        ]
      }
    }
  }
}
