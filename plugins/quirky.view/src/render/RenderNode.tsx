import type { ViewNode } from '../core/catalog'
import { Callout, Code, DataTable, FileDiff, KeyValue, Stat, StatusList, Steps } from './data'
import { BarChart, LineChart } from './charts'
import { Field, ViewButton } from './controls'
import { Columns, Section, Stack } from './layout'
import { Markdown } from './Markdown'

/** Draws one catalog node and its children as React elements; a node of an unknown type draws nothing. */
export function RenderNode({ node }: { node: ViewNode }) {
  const props = node.props ?? {}
  const children = (node.children ?? []).map((child, index) => <RenderNode key={index} node={child} />)
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
    default:
      return null
  }
}
