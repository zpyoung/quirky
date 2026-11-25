import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { asItems, asString, isRecord, oneOf, type NodeProps } from './view-prop-readers'

/** Answering from a panel has no host method yet, so controls render and do nothing. */
export const CONTROLS_UNAVAILABLE_HINT = "Answering from the panel isn't available yet"

const QUESTION_TYPES = ['select', 'multiselect', 'text', 'number', 'confirm'] as const

function UnavailableHint() {
  return (
    <span role="note" className="native-chat-view-muted" data-controls-hint>
      {CONTROLS_UNAVAILABLE_HINT}
    </span>
  )
}

export function ButtonNode({ props }: { props: NodeProps }) {
  return (
    <span data-view-node="button" className="native-chat-view-row">
      <Button
        size="sm"
        variant={props.variant === 'primary' ? 'default' : 'outline'}
        disabled
        aria-disabled="true"
      >
        {asString(props.label)}
      </Button>
      <UnavailableHint />
    </span>
  )
}

export function FieldNode({ props }: { props: NodeProps }) {
  const question = isRecord(props.question) ? props.question : {}
  const type = oneOf(question.type, QUESTION_TYPES, 'text')
  const prompt = asString(question.question)
  const header = asString(question.header)
  const options = asItems(question.options)
  let control
  if (type === 'select' || type === 'multiselect') {
    control = (
      <div
        role="group"
        aria-label={prompt}
        className="native-chat-view-column native-chat-view-tight"
      >
        {options.map((option, index) => (
          <Button key={index} size="sm" variant="outline" disabled>
            {asString(option.label)}
            {asString(option.description) !== '' && (
              <span className="native-chat-view-muted">{asString(option.description)}</span>
            )}
          </Button>
        ))}
      </div>
    )
  } else if (type === 'confirm') {
    control = (
      <div role="group" aria-label={prompt} className="native-chat-view-row">
        <Button size="sm" variant="outline" disabled>
          Yes
        </Button>
        <Button size="sm" variant="outline" disabled>
          No
        </Button>
      </div>
    )
  } else if (question.multiline === true) {
    control = <Textarea aria-label={prompt} rows={3} disabled />
  } else {
    control = <Input aria-label={prompt} type={type === 'number' ? 'number' : 'text'} disabled />
  }
  return (
    <div data-view-node="field" className="native-chat-view-column native-chat-view-tight">
      {header !== '' && <div className="native-chat-view-muted">{header}</div>}
      <div>{prompt}</div>
      {control}
      <UnavailableHint />
    </div>
  )
}
