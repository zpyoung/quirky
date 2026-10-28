import { useEffect, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { isRecord } from './loop-status'

export type VmRecipeSelection = { id: string; trustHash: string; checkoutMode: 'orca-worktree' | 'provisioned-root'; approved: boolean }
type Recipe = Omit<VmRecipeSelection, 'approved'> & { name: string; commands: string }
type Loaded = { repo: string; recipes: Recipe[]; error: string | null }


function readRecipes(value: unknown): Recipe[] {
  if (!isRecord(value) || !Array.isArray(value.recipes)) throw new Error('The VM owner returned no recipe catalog.')
  return value.recipes.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string' ||
      typeof entry.trustHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.trustHash) ||
      (entry.checkoutMode !== 'orca-worktree' && entry.checkoutMode !== 'provisioned-root') || typeof entry.create !== 'string') {
      throw new Error('The VM owner returned an invalid lifecycle recipe.')
    }
    const commands = ['create', 'suspend', 'resume', 'destroy'].map((action) => {
      const command = entry[action]
      if (command !== undefined && typeof command !== 'string') throw new Error('The VM owner returned an invalid lifecycle command.')
      return `${action}:\n${typeof command === 'string' ? command : action === 'destroy' && entry.destroyDisabled === true ? '(disabled)' : '(not configured)'}`
    }).join('\n\n')
    return { id: entry.id, name: entry.name, trustHash: entry.trustHash, checkoutMode: entry.checkoutMode, commands }
  })
}

/** Consent always names the exact complete lifecycle snapshot; selecting a new recipe clears it. */
export function VmRecipeSelector({ context, repo, value, disabled, onChange }: {
  context: UiPluginContext
  repo: string
  value: VmRecipeSelection | null
  disabled: boolean
  onChange(selection: VmRecipeSelection | null): void
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  useEffect(() => {
    let live = true
    void context.call('quirky.worktree/vmRecipes', { repo }).then((result) => {
      const recipes = readRecipes(result)
      if (live) setLoaded({ repo, recipes, error: null })
    }).catch((error: unknown) => {
      if (live) setLoaded({ repo, recipes: [], error: error instanceof Error ? error.message : String(error) })
    })
    return () => { live = false }
  }, [context, repo])
  const current = loaded?.repo === repo ? loaded : null
  const selected = current?.recipes.find((recipe) => recipe.id === value?.id && recipe.trustHash === value.trustHash)

  return <fieldset className="form-group" disabled={disabled}>
    <legend>VM environment</legend>
    {current?.error && <p role="alert">{current.error}</p>}
    <label>Environment recipe
      <select aria-label="Environment recipe" value={value?.id ?? ''} disabled={disabled || current === null || current.error !== null} onChange={(event) => {
        const recipe = current?.recipes.find((candidate) => candidate.id === event.currentTarget.value)
        onChange(recipe ? { id: recipe.id, trustHash: recipe.trustHash, checkoutMode: recipe.checkoutMode, approved: false } : null)
      }}>
        <option value="">Select a VM recipe</option>
        {current?.recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}
      </select>
    </label>
    {selected && <>
      <p className="muted">Lima VM; {selected.checkoutMode === 'provisioned-root' ? 'attach the recipe-provisioned guest workspace' : 'create a canonical guest worktree'}. No local checkout is created.</p>
      <pre>{selected.commands}</pre>
      <small>Lifecycle SHA-256: {selected.trustHash}</small>
      <label className="check-row">
        <input type="checkbox" checked={value?.approved === true} onChange={(event) => onChange({ id: selected.id, trustHash: selected.trustHash, checkoutMode: selected.checkoutMode, approved: event.currentTarget.checked })} />
        <span>Approve these lifecycle commands for this one VM creation</span>
      </label>
    </>}
    {value && !selected && <p role="alert">The selected recipe changed. Select it again and review its current lifecycle.</p>}
  </fieldset>
}
