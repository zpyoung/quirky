import { useEffect, useState, type CSSProperties } from 'react'
import type { Session, UiPluginContext } from '@quirky/protocol'
import { Button } from '@quirky/ui'
import type { AgentListing } from '../menuEntries'
import { NO_PICKS, type Picks } from './controls'

/** The four agents a chat can run, in the order the picker shows them. */
const CHAT_AGENTS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'pi', label: 'pi' },
  { id: 'omp', label: 'omp' }
] as const

type Readiness = { ready: true; model: string } | { ready: false; reason: string }
type Card = { id: string; label: string; readiness: Readiness }
type Listed = AgentListing['agents'][number] & { signedIn?: boolean }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const layout = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--ui-space-12)', minWidth: 0, padding: 'var(--ui-space-24) var(--ui-space-16)' } satisfies CSSProperties
const title = { margin: 0, fontSize: 'var(--ui-font-title)' } satisfies CSSProperties
const lead = { margin: 0, color: 'var(--ui-muted)', textAlign: 'center' } satisfies CSSProperties
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(var(--compat-px-220), 1fr))', gap: 'var(--ui-space-8)', width: '100%', maxWidth: 'var(--compat-px-520)' } satisfies CSSProperties
const card = { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--ui-space-2)', textAlign: 'left', height: 'auto', padding: 'var(--ui-space-8) var(--ui-space-12)' } satisfies CSSProperties
const note = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties

/** What a card says about an agent, from the catalog row and, when ready, its first listed model. */
function readinessOf(row: Listed | undefined, model: string | undefined): Readiness {
  if (!row || !row.installed) return { ready: false, reason: 'not installed' }
  if (!row.enabled) return { ready: false, reason: 'turned off in Agents settings' }
  if (row.signedIn === false) return { ready: false, reason: 'not signed in' }
  return { ready: true, model: model ?? 'Default model' }
}

/** Loads the four chat agents' readiness; `quirky.agents/list` says what is installed and `options` names the default model. */
function useCards(context: UiPluginContext): Card[] | null {
  const [cards, setCards] = useState<Card[] | null>(null)
  useEffect(() => {
    let cancelled = false
    let latest = 0
    const load = async () => {
      const attempt = ++latest
      let listing: AgentListing | null = null
      try {
        listing = (await context.call('quirky.agents/list')) as AgentListing
      } catch {
        listing = null
      }
      const models = await Promise.all(
        CHAT_AGENTS.map(async ({ id }) => {
          const row = listing?.agents.find((agent) => agent.id === id)
          if (!row?.installed || !row.enabled) return undefined
          try {
            const options = (await context.call('quirky.agents/options', { agent: id })) as { models?: { label?: string }[] }
            return options.models?.[0]?.label
          } catch {
            return undefined
          }
        })
      )
      if (cancelled || attempt !== latest) return
      setCards(
        CHAT_AGENTS.map(({ id, label }, index) => {
          const row = listing?.agents.find((agent) => agent.id === id)
          return { id, label: row?.label ?? label, readiness: readinessOf(row, models[index]) }
        })
      )
    }
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.agents/changed') void load()
    })
    void load()
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [context])
  return cards
}

/**
 * The empty state of a new chat: the four agents with their default model and readiness. Picking a
 * ready one starts a chat in `worktree` with `picks` and reports the session; one that is not ready
 * stays disabled and says why.
 */
export function AgentPicker({
  context,
  worktree,
  picks = NO_PICKS,
  onCreated
}: {
  context: UiPluginContext
  worktree: string
  picks?: Picks
  onCreated: (session: Session) => void
}) {
  const cards = useCards(context)
  const [starting, setStarting] = useState<string | null>(null)

  const start = async (agent: string) => {
    const options = {
      ...(picks.effort === null ? {} : { effort: picks.effort }),
      ...(picks.mode === null ? {} : { mode: picks.mode }),
      ...(picks.plan ? { plan: true } : {})
    }
    setStarting(agent)
    try {
      const created = (await context.call('quirky.structured/create', {
        agent,
        worktree,
        deferStart: true,
        ...(picks.model === null ? {} : { model: picks.model }),
        ...(Object.keys(options).length === 0 ? {} : { options })
      })) as Session
      onCreated(created)
    } catch (error) {
      context.toast('Could not start chat', messageOf(error))
    } finally {
      setStarting(null)
    }
  }

  return (
    <section style={layout} aria-label="New chat">
      <h3 style={title}>New chat</h3>
      <p style={lead}>Pick an agent. It works in this worktree, and you can switch to its terminal anytime.</p>
      <div style={grid} role="group" aria-label="Agents">
        {(cards ?? []).map(({ id, label, readiness }) => (
          <Button
            key={id}
            style={card}
            disabled={!readiness.ready || starting !== null}
            title={readiness.ready ? undefined : readiness.reason}
            onClick={() => void start(id)}
          >
            <strong>{label}</strong>
            <span style={note}>{readiness.ready ? `${readiness.model} · ready` : readiness.reason}</span>
          </Button>
        ))}
      </div>
    </section>
  )
}
