import { useAppState } from '../context'
import { AskCard } from './AskCard'

export function AskCards() {
  const { asks } = useAppState()
  if (asks.length === 0) return null
  return (
    <div className="ask-stack">
      {asks.map((ask) => (
        <AskCard key={ask.id} ask={ask} />
      ))}
    </div>
  )
}
