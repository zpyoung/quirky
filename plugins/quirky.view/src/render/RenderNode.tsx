import type { ReactNode } from 'react'
import type { CatalogType, ViewNode } from '../core/contract'
import { nodeKey } from './changes'
import { Callout, Code, DataTable, FileDiff, KeyValue, Stat, StatusList, Steps } from './data'
import { BarChart, LineChart } from './charts'
import { Field, ViewButton } from './controls'
import { Diagram } from './Diagram'
import { HtmlFrame } from './HtmlFrame'
import { ImageNode } from './ImageNode'
import { Columns, Section, Stack } from './layout'
import { LivePreview } from './LivePreview'
import { Markdown } from './Markdown'
import { clampLabel, pointKey } from './point'
import { asString, type Props } from './props'
import { useRuntime } from './runtime'
import { AnnotatedCode, Board, FileMap, Matrix, Plot, Sketch, Timeline } from './visuals'

/** Nodes that are layout or controls: a click on them is not a request to talk about the node. */
const NOT_POINTABLE: readonly CatalogType[] = ['stack', 'columns', 'button', 'field']

const CHANGED_OUTLINE = { outlineWidth: 'var(--ui-focus-width)', outlineStyle: 'solid', outlineColor: 'var(--ui-working)', outlineOffset: 'var(--ui-space-2)', borderRadius: 'var(--ui-radius-control)' } as const

/** What a node is called when it is pointed at: its title or label prop, else its kind. */
function labelOf(node: ViewNode, props: Props): string {
  const named = ['title', 'label', 'caption', 'alt', 'path'].map((name) => asString(props[name])).find((text) => text !== '')
  return clampLabel(named ?? node.type)
}

function drawNode(node: ViewNode, props: Props, children: ReactNode[], path: string): ReactNode {
  switch (node.type) {
    case 'stack':
      return <Stack>{children}</Stack>
    case 'columns':
      return <Columns count={children.length}>{children}</Columns>
    case 'section':
      return <Section props={props}>{children}</Section>
    case 'markdown':
      return <Markdown props={props} />
    case 'kv':
      return <KeyValue props={props} />
    case 'table':
      return <DataTable props={props} />
    case 'stat':
      return <Stat props={props} />
    case 'status-list':
      return <StatusList props={props} />
    case 'steps':
      return <Steps props={props} />
    case 'code':
      return <Code props={props} />
    case 'file-diff':
      return <FileDiff props={props} />
    case 'bar-chart':
      return <BarChart props={props} />
    case 'line-chart':
      return <LineChart props={props} />
    case 'callout':
      return <Callout props={props} />
    case 'button':
      return <ViewButton props={props} />
    case 'field':
      return <Field props={props} />
    case 'diagram':
      return <Diagram props={props} />
    case 'image':
      return <ImageNode props={props} />
    case 'html':
      return <HtmlFrame props={props} />
    case 'live-preview':
      return <LivePreview key={path} props={props} />
    case 'timeline':
      return <Timeline props={props} />
    case 'board':
      return <Board props={props} />
    case 'matrix':
      return <Matrix props={props} />
    case 'annotated-code':
      return <AnnotatedCode props={props} />
    case 'file-map':
      return <FileMap props={props} />
    case 'plot':
      return <Plot props={props} />
    case 'sketch':
      return <Sketch props={props} />
    default:
      return null
  }
}

/**
 * Draws one catalog node and its children as React elements; a node of an unknown type draws nothing.
 * A node the agent gave an id can be pointed at, and a node that differs from the previous version is outlined.
 */
export function RenderNode({ node, path = '0' }: { node: ViewNode; path?: string }) {
  const { changed } = useRuntime()
  const props = node.props ?? {}
  const children = (node.children ?? []).map((child, index) => <RenderNode key={index} node={child} path={`${path}.${index}`} />)
  const body = drawNode(node, props, children, path)
  const pointable = node.id !== undefined && !NOT_POINTABLE.includes(node.type)
  const pointed = pointable ? <div data-point-key={pointKey('node', node.id!)} data-point-label={labelOf(node, props)}>{body}</div> : body
  return changed.has(nodeKey(node, path)) ? <div data-view-changed style={CHANGED_OUTLINE}>{pointed}</div> : pointed
}
