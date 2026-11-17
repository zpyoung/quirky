import type { CSSProperties } from 'react'
import { StatusDot } from '@quirky/ui'
import type { StepsItem, StepsState } from '../turns'
import { callStateLabel, Card, CallDot, grow, muted } from './Card'

const list = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', margin: 0, padding: 0, listStyle: 'none' } satisfies CSSProperties
const row = { display: 'flex', alignItems: 'center', gap: 'var(--ui-space-8)' } satisfies CSSProperties
const doneText = { color: 'var(--ui-muted)', textDecoration: 'line-through' } satisfies CSSProperties

const stepDot = {
  done: { status: 'done', label: 'Done' },
  active: { status: 'working', label: 'In progress' },
  pending: { status: 'idle', label: 'Not started' }
} as const

/** The agent's todo list: each step done, in progress or waiting, with the list's state while the turn is not done. */
export function Steps({ item, state }: { item: StepsItem; state: StepsState }) {
  const done = item.steps.filter((step) => step.state === 'done').length
  return (
    <Card
      label="Plan"
      ariaLabel="Plan"
      tone={state === 'failed' ? 'failing' : 'neutral'}
      header={
        <>
          <span style={muted}>{`${done} of ${item.steps.length} done`}</span>
          <span style={grow} />
          {state !== 'done' && (
            <>
              <CallDot state={state} />
              <span>{callStateLabel[state]}</span>
            </>
          )}
        </>
      }
    >
      <ul style={list}>
        {item.steps.map((step, index) => {
          const dot = stepDot[step.state]
          return (
            <li key={index} style={row} data-step-state={step.state}>
              <StatusDot status={dot.status} label={dot.label} />
              <span style={step.state === 'done' ? doneText : undefined}>{step.text}</span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
