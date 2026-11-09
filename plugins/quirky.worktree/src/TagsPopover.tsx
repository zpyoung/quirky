import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Checkbox, Popover, SwatchGroup, TextField } from '@quirky/ui'
import { assignTag, createTag, fetchTags, updateTag, type TagsSnapshot } from './actions'

type Props = {
  context: UiPluginContext
  /** The worktrees the popover tags: one for a row, several for a selection. */
  worktreeIds: string[]
  anchor: HTMLElement
  onClose(): void
}

/**
 * Checks, creates and recolors tags for one or several worktrees. With several, a tag only some of
 * them carry shows a mixed checkbox. It reloads on `tagsChanged`, so other windows' edits show up.
 */
export function TagsPopover({ context, worktreeIds, anchor, onClose }: Props) {
  const anchorRef = useRef<HTMLElement>(anchor)
  anchorRef.current = anchor
  const [snapshot, setSnapshot] = useState<TagsSnapshot | null>(null)
  const [query, setQuery] = useState('')
  const [coloring, setColoring] = useState<string | null>(null)
  const latest = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++latest.current
    try {
      const next = await fetchTags(context)
      if (ticket === latest.current) setSnapshot(next)
    } catch (error) {
      if (ticket === latest.current) context.log(`could not load tags: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [context])

  useEffect(() => {
    void load()
    return context.subscribe((event) => {
      if (event.type === 'quirky.worktree/tagsChanged') void load()
    })
  }, [context, load])

  const tags = snapshot?.tags ?? []
  const assignments = snapshot?.assignments ?? {}
  const needle = query.trim().toLowerCase()
  const shown = needle === '' ? tags : tags.filter((tag) => tag.name.toLowerCase().includes(needle))
  const exact = tags.some((tag) => tag.name.toLowerCase() === needle)
  const canCreate = needle !== '' && !exact

  const countOf = (tagId: string) => worktreeIds.filter((id) => assignments[id]?.includes(tagId)).length
  const toggle = async (tagId: string, assigned: boolean) => {
    if (await assignTag(context, worktreeIds, tagId, assigned)) await load()
  }
  const create = async () => {
    const tag = await createTag(context, query.trim())
    if (!tag) return
    setQuery('')
    if (await assignTag(context, worktreeIds, tag.id, true)) await load()
  }

  return (
    <Popover open label="Tags" anchor={anchorRef} onClose={onClose}>
      <div className="ui-stack worktree-tags">
        <TextField
          label="Add or create a tag"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (canCreate) void create()
            else if (shown.length === 1) void toggle(shown[0]!.id, countOf(shown[0]!.id) !== worktreeIds.length)
          }}
        />
        <ul className="ui-tree worktree-tags__list">
          {shown.map((tag) => {
            const count = countOf(tag.id)
            const all = worktreeIds.length > 0 && count === worktreeIds.length
            return (
              <li key={tag.id} className="ui-tree-item">
                <div className="worktree-tags__row">
                  <Checkbox
                    checked={all}
                    indeterminate={count > 0 && !all}
                    label={tag.name}
                    onChange={(checked) => void toggle(tag.id, checked)}
                  />
                  <button
                    type="button"
                    className="ui-swatch"
                    data-color={tag.color ?? 'grey'}
                    aria-label={`Color for ${tag.name}`}
                    aria-expanded={coloring === tag.id}
                    onClick={() => setColoring((current) => (current === tag.id ? null : tag.id))}
                  />
                </div>
                {coloring === tag.id && (
                  <SwatchGroup
                    label={`Color for ${tag.name}`}
                    value={tag.color}
                    onChange={(color) => void updateTag(context, tag.id, { color }).then(() => load())}
                  />
                )}
              </li>
            )
          })}
        </ul>
        {canCreate && (
          <button type="button" className="worktree-tags__create" onClick={() => void create()}>
            {`Create "${query.trim()}"`}
          </button>
        )}
        {shown.length === 0 && !canCreate && <p className="ui-help-text">No tags yet. Type a name to create one.</p>}
      </div>
    </Popover>
  )
}
