import { translate } from '@/i18n/i18n'
import type { ReactNode } from 'react'
import type { ViewNode } from '../../../../../../shared/view-spec/view-spec-types'
import { BarChartNode, LineChartNode } from './ChartNodes'
import { ButtonNode, FieldNode } from './ControlNodes'
import {
  CalloutNode,
  CodeNode,
  FileDiffNode,
  KeyValueNode,
  MarkdownNode,
  StatNode,
  StatusListNode,
  StepsNode,
  TableNode
} from './DataNodes'
import { DiagramNode } from './DiagramNode'
import { HtmlFrame } from './HtmlFrame'
import { ImageNode } from './ImageNode'
import { ColumnsNode, SectionNode, StackNode } from './LayoutNodes'
import { LivePreviewNode } from './LivePreviewNode'
import { SketchNode } from './SketchNode'
import { asNumber, asString, type NodeProps } from './view-prop-readers'
import { useViewRuntime } from './view-runtime'
import {
  AnnotatedCodeNode,
  BoardNode,
  FileMapNode,
  MatrixNode,
  PlotNode,
  TimelineNode
} from './VisualNodes'
import { positionKeyed } from '../../position-keyed'

function HtmlNode({ props }: { props: NodeProps }) {
  const { viewId } = useViewRuntime()
  return (
    <HtmlFrame
      html={asString(props.html)}
      interactive={props.interactive === true}
      height={asNumber(props.height)}
      title={translate('components.chat.viewRender.visualTitle', 'Visual {{viewId}}', { viewId })}
    />
  )
}

function drawNode(node: ViewNode, props: NodeProps, children: ReactNode[]): ReactNode {
  switch (node.type) {
    case 'stack':
      return <StackNode>{children}</StackNode>
    case 'columns':
      return <ColumnsNode count={children.length}>{children}</ColumnsNode>
    case 'section':
      return <SectionNode props={props}>{children}</SectionNode>
    case 'markdown':
      return <MarkdownNode props={props} />
    case 'kv':
      return <KeyValueNode props={props} />
    case 'table':
      return <TableNode props={props} />
    case 'stat':
      return <StatNode props={props} />
    case 'status-list':
      return <StatusListNode props={props} />
    case 'steps':
      return <StepsNode props={props} />
    case 'code':
      return <CodeNode props={props} />
    case 'file-diff':
      return <FileDiffNode props={props} />
    case 'bar-chart':
      return <BarChartNode props={props} />
    case 'line-chart':
      return <LineChartNode props={props} />
    case 'callout':
      return <CalloutNode props={props} />
    case 'button':
      return <ButtonNode props={props} />
    case 'field':
      return <FieldNode props={props} />
    case 'diagram':
      return <DiagramNode props={props} />
    case 'image':
      return <ImageNode props={props} />
    case 'html':
      return <HtmlNode props={props} />
    case 'live-preview':
      return <LivePreviewNode props={props} />
    case 'timeline':
      return <TimelineNode props={props} />
    case 'board':
      return <BoardNode props={props} />
    case 'matrix':
      return <MatrixNode props={props} />
    case 'annotated-code':
      return <AnnotatedCodeNode props={props} />
    case 'file-map':
      return <FileMapNode props={props} />
    case 'plot':
      return <PlotNode props={props} />
    case 'sketch':
      return <SketchNode props={props} />
  }
}

/** Draws one catalog node and its children as React elements. */
export function ViewNodeRenderer({ node }: { node: ViewNode }) {
  const children = positionKeyed(node.children ?? []).map(({ key, item: child }) => (
    <ViewNodeRenderer key={key} node={child} />
  ))
  return drawNode(node, node.props ?? {}, children)
}
