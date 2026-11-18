import { EditorView, Decoration, WidgetType, type DecorationSet } from '@codemirror/view'
import { invertedEffects } from '@codemirror/commands'
import { StateEffect, StateField, type ChangeDesc, type EditorState, type Extension } from '@codemirror/state'
import type { Pill } from './types'

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path

/** The plain text a pill serialises to: `@<path> ` or `/<name> `. */
export const pillText = (pill: Pill): string => (pill.kind === 'file' ? `@${pill.path} ` : `/${pill.name} `)

class PillWidget extends WidgetType {
  constructor(readonly pill: Pill) {
    super()
  }
  eq(other: PillWidget) {
    return pillText(other.pill) === pillText(this.pill)
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = `cm-composer-pill cm-composer-pill-${this.pill.kind}`
    el.setAttribute('contenteditable', 'false')
    if (this.pill.kind === 'file') {
      el.title = this.pill.path
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      icon.setAttribute('viewBox', '0 0 16 16')
      icon.setAttribute('width', '1em')
      icon.setAttribute('height', '1em')
      icon.setAttribute('aria-hidden', 'true')
      icon.setAttribute('class', 'cm-composer-pill-icon')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13')
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-linejoin', 'round')
      icon.append(path)
      el.append(icon, document.createTextNode(basename(this.pill.path)))
    } else {
      el.textContent = `/${this.pill.name}`
    }
    return el
  }
  ignoreEvent() {
    return false
  }
}

const decorate = (pill: Pill, from: number, to: number) => Decoration.replace({ widget: new PillWidget(pill) }).range(from, to)

/** Pills found in plain text: `@<path> ` and `/<name> ` at the start or after whitespace; a command name never holds a `/`. */
export function parsePills(text: string): { from: number; to: number; pill: Pill }[] {
  return [...text.matchAll(/(?<=^|\s)(?:\/([^\s/]+)|@(\S+)) /g)].map((match) => {
    const from = match.index!
    const to = from + match[0].length
    const pill: Pill = match[1] !== undefined ? { kind: 'command', name: match[1] } : { kind: 'file', path: match[2]! }
    return { from, to, pill }
  })
}

const reparse = StateEffect.define<null>()
type PillRange = { from: number; to: number; pill: Pill }
const mapRange = (value: PillRange, mapping: ChangeDesc): PillRange | undefined => {
  const from = mapping.mapPos(value.from, 1)
  const to = mapping.mapPos(value.to, -1)
  return from < to ? { ...value, from, to } : undefined
}

const addPill = StateEffect.define<PillRange>({ map: mapRange })
// the undo/redo pair: history stores the inverse of each, so redo re-adds the pill the undo dropped
const dropPill = StateEffect.define<PillRange>({ map: mapRange })

const pillField = StateField.define<DecorationSet>({
  create: (state) => Decoration.set(parsePills(state.doc.toString()).map((p) => decorate(p.pill, p.from, p.to)), true),
  update(value, tr) {
    let next = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(reparse)) {
        next = Decoration.set(parsePills(tr.newDoc.toString()).map((p) => decorate(p.pill, p.from, p.to)), true)
      } else if (effect.is(addPill)) {
        const { from, to } = effect.value
        next = next.update({
          filter: (f, t) => f !== from || t !== to,
          add: [decorate(effect.value.pill, from, to)],
          sort: true
        })
      } else if (effect.is(dropPill)) {
        const { from, to } = effect.value
        next = next.update({ filter: (f, t) => f !== from || t !== to })
      }
    }
    return next
  },
  provide: (field) => [
    invertedEffects.of((tr) => {
      // a deleted pill is restored by undo: its decoration is lost with the text, so re-add it explicitly
      const restored: StateEffect<PillRange>[] = []
      if (tr.docChanged) {
        tr.startState.field(field).between(0, tr.startState.doc.length, (from, to, deco) => {
          const pill = (deco.spec.widget as PillWidget | undefined)?.pill
          if (pill && !mapRange({ from, to, pill }, tr.changes)) restored.push(addPill.of({ from, to, pill }))
        })
      }
      return restored.concat(tr.effects.flatMap((effect) => (effect.is(addPill) ? [dropPill.of(effect.value)] : effect.is(dropPill) ? [addPill.of(effect.value)] : []))
      )
    }),
    EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))]
})

/** Atomic, replace-widget pills over `@path ` / `/name ` text. */
export const pillsExtension: Extension = pillField

/** The pill ranges currently in the document, in order. */
export function pillRanges(state: EditorState): { from: number; to: number; text: string }[] {
  const out: { from: number; to: number; text: string }[] = []
  state.field(pillField).between(0, state.doc.length, (from, to) => {
    out.push({ from, to, text: state.doc.sliceString(from, to) })
  })
  return out
}

/** The change and effect that replace `range` with the pill's text and render it as a pill. */
export function pillTransaction(pill: Pill, range: { from: number; to: number }) {
  const text = pillText(pill)
  return {
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
    effects: addPill.of({ from: range.from, to: range.from + text.length, pill })
  }
}

/** Marks the transaction's new document as externally loaded so pills are re-derived from its text. */
export const reparsePills = () => reparse.of(null)
