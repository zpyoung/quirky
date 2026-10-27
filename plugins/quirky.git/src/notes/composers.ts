/** A text diff that can take a note on its current selection. */
export type NoteComposer = {
  /** Opens a draft for the editor's selection; false when it opened none. */
  openFromSelection(): boolean
}

const composers = new Set<NoteComposer>()
let lastUsed: NoteComposer | null = null

/** Makes `composer` a target of the Add Review Note command until the returned function runs. */
export function registerComposer(composer: NoteComposer): () => void {
  composers.add(composer)
  return () => {
    composers.delete(composer)
    if (lastUsed === composer) lastUsed = null
  }
}

/** Marks `composer` as the diff the person is working in, for a view with several. */
export function markComposerUsed(composer: NoteComposer): void {
  if (composers.has(composer)) lastUsed = composer
}

/**
 * Opens a draft in the diff the person last used, else the first one shown. Does nothing, and
 * returns false, when no text diff is open.
 */
export function addReviewNote(): boolean {
  const target = lastUsed ?? [...composers][0]
  return target?.openFromSelection() ?? false
}
