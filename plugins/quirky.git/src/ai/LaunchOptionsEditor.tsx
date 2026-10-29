import { useEffect, useId, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { RecipeLaunchOptions } from '../daemon/recipe-options'
import { Button, FormRow } from '@quirky/ui'

type Choice = { value: string; label: string }
type Option = { id: string; label: string; type: 'select' | 'boolean'; choices: Choice[] | null }
type Model = { id: string; label: string; options: Option[] }
type Catalog = {
  supported: boolean
  discoverable?: boolean
  models: Model[]
  unlisted: 'accept' | 'refuse'
  unlistedOptions: Option[]
  extraArgs: { allowed: string | null } | null
}
type CatalogState = { agent: string; host: string; info: Catalog | null; loading: boolean }

type Props = {
  context: UiPluginContext
  agent: string
  host: string
  value: RecipeLaunchOptions | null
  args: string
  labelPrefix?: string
  resetLabel?: string
  onChange(value: RecipeLaunchOptions | null): void
}

function shellTokens(text: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote = ''
  let escaped = false
  let active = false
  for (const character of text) {
    if (escaped) {
      token += character
      escaped = false
      active = true
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaped = true
      active = true
      continue
    }
    if (quote !== '') {
      if (character === quote) quote = ''
      else token += character
      active = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      active = true
    } else if (/\s/.test(character)) {
      if (active) tokens.push(token)
      token = ''
      active = false
    } else {
      token += character
      active = true
    }
  }
  if (escaped) token += '\\'
  if (active) tokens.push(token)
  return tokens
}

type RawFlag = { flag: string; valuePrefix?: string }

function rawFlags(catalog: Catalog, kind: 'model' | 'effort'): RawFlag[] {
  const rules = (catalog.extraArgs?.allowed ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  const matching = rules.flatMap((rule) => {
    const [flag, ...parts] = rule.split(/\s+/)
    const effort = /effort/i.test(rule)
    const model = /model/i.test(rule) && !effort
    if ((kind === 'effort' && !effort) || (kind === 'model' && !model)) return []
    const valuePrefix = parts.join(' ').replace(/(?:…|\.{3}).*$/, '')
    return [{ flag: flag!, ...(valuePrefix === '' ? {} : { valuePrefix }) }]
  })
  if (kind === 'model' && matching.some((rule) => rule.flag === '--model')) matching.push({ flag: '-m' })
  for (const rule of matching.filter((candidate) => candidate.flag === '-c')) matching.push({ ...rule, flag: '--config' })
  return matching
}

function rawSets(args: string, catalog: Catalog, kind: 'model' | 'effort'): boolean {
  const tokens = shellTokens(args)
  return rawFlags(catalog, kind).some(({ flag, valuePrefix }) => {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!
      if (token === flag) {
        if (valuePrefix === undefined || (tokens[index + 1]?.startsWith(valuePrefix) ?? false)) return true
      }
      if (token.startsWith(`${flag}=`)) {
        const value = token.slice(flag.length + 1)
        if (valuePrefix === undefined || value.startsWith(valuePrefix)) return true
      }
      if (flag.startsWith('-') && !flag.startsWith('--') && token.startsWith(flag) && token.length > flag.length) {
        const value = token.slice(flag.length)
        if (valuePrefix === undefined || value.startsWith(valuePrefix)) return true
      }
    }
    return false
  })
}

function optionsFor(catalog: Catalog, modelId: string): Option[] {
  if (modelId === '') return catalog.unlistedOptions
  const listed = catalog.models.find((model) => model.id === modelId)
  if (listed) return listed.options
  return catalog.unlistedOptions
}

function optionAllows(option: Option, value: string | boolean): boolean {
  if (option.type === 'boolean') return typeof value === 'boolean'
  return typeof value === 'string' && option.choices?.some((choice) => choice.value === value) === true
}

function fieldName(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix} ${name.toLowerCase()}`
}

export function LaunchOptionsEditor({ context, agent, host, value, args, labelPrefix = '', resetLabel, onChange }: Props) {
  const [state, setState] = useState<CatalogState>({ agent: '', host: '', info: null, loading: false })
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const alive = useRef(true)
  const listId = useId()
  useEffect(() => {
    alive.current = true
    setRefreshing(false)
    setRefreshMessage(null)
    if (agent === '' || agent === 'custom') {
      setState({ agent, host, info: null, loading: false })
      return () => {
        alive.current = false
      }
    }
    setState({ agent, host, info: null, loading: true })
    void context
      .call('quirky.agents/options', { agent, host })
      .then((info) => {
        if (alive.current) setState({ agent, host, info: info as Catalog, loading: false })
      })
      .catch(() => {
        if (alive.current) setState({ agent, host, info: null, loading: false })
      })
    return () => {
      alive.current = false
    }
  }, [context, agent, host])

  const catalog = state.agent === agent && state.host === host ? state.info : null
  const model = value?.model ?? ''
  const optionValues = value?.optionValues ?? {}
  const commit = (nextModel: string, nextValues: Record<string, string | boolean>) => {
    const next: RecipeLaunchOptions = {}
    if (nextModel.trim() !== '') next.model = nextModel.trim()
    if (Object.keys(nextValues).length > 0) next.optionValues = nextValues
    onChange(next)
  }
  const refreshModels = async () => {
    if (!catalog?.discoverable || refreshing) return
    setRefreshing(true)
    setRefreshMessage(null)
    try {
      const result = (await context.call('quirky.agents/discoverModels', { agent, host })) as { authoritative?: boolean; reason?: string }
      if (!alive.current) return
      const refreshed = (await context.call('quirky.agents/options', { agent, host })) as Catalog
      if (!alive.current) return
      setState({ agent, host, info: refreshed, loading: false })
      if (!result.authoritative) setRefreshMessage(result.reason ?? 'No authoritative model list was returned; saved choices were kept.')
    } catch (error) {
      if (alive.current) setRefreshMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }

  if (agent === 'custom') return <p className="ui-text-muted">Custom command does not support catalog model or option picks.</p>
  if (agent === '') return <p className="ui-text-muted">Choose an agent to see its model and effort choices.</p>
  if (catalog === null) return <p className="ui-text-muted">{state.loading ? 'Loading model and effort choices…' : 'Could not load this agent’s launch choices.'}</p>
  if (!catalog.supported) return <p className="ui-text-muted">This agent does not offer catalog-backed model or option choices.</p>

  const options = optionsFor(catalog, model)
  const modelShadowed = rawSets(args, catalog, 'model')
  const staleModel = model !== '' && catalog.unlisted === 'refuse' && !catalog.models.some((listed) => listed.id === model)
  const modelId = `${listId}-model`

  return (
    <div className="ui-stack">
      <FormRow label={fieldName(labelPrefix, 'Model')} htmlFor={modelId}>
        {catalog.unlisted === 'accept' ? (
          <>
            <input
              id={modelId}
              className="ui-text-field__input"
              type="text"
              aria-label={fieldName(labelPrefix, 'Model')}
              list={`${listId}-models`}
              placeholder="Agent default"
              value={model}
              disabled={modelShadowed}
              onChange={(event) => {
                const selected = event.target.value
                const supported = optionsFor(catalog, selected)
                const retained = Object.fromEntries(Object.entries(optionValues).filter(([id, selectedValue]) => {
                  const option = supported.find((candidate) => candidate.id === id)
                  return option !== undefined && optionAllows(option, selectedValue)
                })) as Record<string, string | boolean>
                commit(selected, retained)
              }}
            />
            <datalist id={`${listId}-models`}>
              {catalog.models.map((listed) => <option key={listed.id} value={listed.id} label={listed.label} />)}
            </datalist>
          </>
        ) : (
          <select
            id={modelId}
            className="ui-text-field__input"
            aria-label={fieldName(labelPrefix, 'Model')}
            value={model}
            disabled={modelShadowed}
            onChange={(event) => {
              const selected = event.target.value
              const supported = optionsFor(catalog, selected)
              const retained = Object.fromEntries(Object.entries(optionValues).filter(([id, selectedValue]) => {
                const option = supported.find((candidate) => candidate.id === id)
                return option !== undefined && optionAllows(option, selectedValue)
              })) as Record<string, string | boolean>
              commit(selected, retained)
            }}
          >
            <option value="">Agent default</option>
            {staleModel && <option value={model}>{model} (unavailable)</option>}
            {catalog.models.map((listed) => <option key={listed.id} value={listed.id}>{listed.label}</option>)}
          </select>
        )}
      </FormRow>
      {catalog.discoverable && (
        <Button type="button" disabled={refreshing} onClick={() => void refreshModels()}>
          {refreshing ? 'Refreshing models…' : 'Refresh models'}
        </Button>
      )}
      {staleModel && <p className="ui-text-muted">Saved model {model} is no longer available.</p>}
      {refreshMessage && <p className="ui-text-muted">{refreshMessage}</p>}
      {modelShadowed && <p className="ui-text-muted">Set by CLI arguments</p>}
      {options.map((option) => {
        const shadowed = rawSets(args, catalog, 'effort') || (modelShadowed && value?.model !== undefined)
        const label = fieldName(labelPrefix, option.label)
        const id = `${listId}-option-${encodeURIComponent(option.id)}`
        const selected = optionValues[option.id]
        return (
          <FormRow key={option.id} label={label} htmlFor={id}>
            <select
              id={id}
              className="ui-text-field__input"
              aria-label={label}
              value={selected === undefined ? '' : String(selected)}
              disabled={shadowed}
              onChange={(event) => {
                const next = { ...optionValues }
                const picked = event.target.value
                if (picked === '') delete next[option.id]
                else next[option.id] = option.type === 'boolean' ? picked === 'true' : picked
                commit(model, next)
              }}
            >
              <option value="">Agent default</option>
              {option.type === 'boolean' ? (
                <>
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </>
              ) : (option.choices ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
            {shadowed && <span className="ui-text-muted">Set by CLI arguments</span>}
          </FormRow>
        )
      })}
      {resetLabel && (
        <Button type="button" disabled={value === null || (model === '' && Object.keys(optionValues).length === 0)} onClick={() => onChange(null)}>
          {resetLabel}
        </Button>
      )}
    </div>
  )
}
