import { useEffect, useId, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { RecipeLaunchOptions } from '../daemon/recipe-options'
import { messageOf } from '../panel/format'
import { Button, FormRow, InlineError, NoticeLine } from '@quirky/ui'

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
type CatalogState = { agent: string; host: string; info: Catalog | null; loading: boolean; error: string | null }

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
async function readCatalog(
  context: UiPluginContext,
  agent: string,
  host: string,
  latest: MutableRefObject<number>,
  setState: Dispatch<SetStateAction<CatalogState>>
): Promise<void> {
  const request = ++latest.current
  setState({ agent, host, info: null, loading: true, error: null })
  try {
    const info = (await context.call('quirky.agents/options', { agent, host })) as Catalog
    if (request === latest.current) setState({ agent, host, info, loading: false, error: null })
  } catch (error) {
    if (request === latest.current) setState({ agent, host, info: null, loading: false, error: messageOf(error) })
  }
}

function optionsFrom(model: string, optionValues: Record<string, string | boolean>): RecipeLaunchOptions {
  const trimmedModel = model.trim()
  return {
    ...(trimmedModel === '' ? {} : { model: trimmedModel }),
    ...(Object.keys(optionValues).length === 0 ? {} : { optionValues })
  }
}

function optionsForModelChange(catalog: Catalog, optionValues: Record<string, string | boolean>, model: string): RecipeLaunchOptions {
  const supported = optionsFor(catalog, model)
  const retained = Object.fromEntries(Object.entries(optionValues).filter(([id, selected]) => {
    const option = supported.find((candidate) => candidate.id === id)
    return option !== undefined && optionAllows(option, selected)
  })) as Record<string, string | boolean>
  return optionsFrom(model, retained)
}

function optionsForValueChange(
  model: string,
  optionValues: Record<string, string | boolean>,
  option: Option,
  selected: string
): RecipeLaunchOptions {
  const selectedValue = option.type === 'boolean' ? selected === 'true' : selected
  const exists = Object.hasOwn(optionValues, option.id)
  const updated = Object.entries(optionValues)
    .map(([id, value]): [string, string | boolean] =>
      id === option.id && selected !== '' ? [id, selectedValue] : [id, value]
    )
    .filter(([id]) => selected !== '' || id !== option.id)
  const entries: Array<[string, string | boolean]> = exists || selected === '' ? updated : [...updated, [option.id, selectedValue]]
  return optionsFrom(model, Object.fromEntries(entries) as Record<string, string | boolean>)
}

export function LaunchOptionsEditor({ context, agent, host, value, args, labelPrefix = '', resetLabel, onChange }: Props) {
  const [state, setState] = useState<CatalogState>({ agent: '', host: '', info: null, loading: false, error: null })
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const latestCatalog = useRef(0)
  const listId = useId()
  function retryCatalog(): void {
    void readCatalog(context, agent, host, latestCatalog, setState)
  }
  useEffect(() => {
    setRefreshing(false)
    setRefreshMessage(null)
    setRefreshError(null)
    if (agent === '' || agent === 'custom') {
      latestCatalog.current += 1
      setState({ agent, host, info: null, loading: false, error: null })
      return () => {
        latestCatalog.current += 1
      }
    }
    void readCatalog(context, agent, host, latestCatalog, setState)
    return () => {
      latestCatalog.current += 1
    }
  }, [context, agent, host, latestCatalog, setState])

  const currentCatalog = state.agent === agent && state.host === host
  const catalog = currentCatalog ? state.info : null
  const catalogLoading = currentCatalog ? state.loading : agent !== '' && agent !== 'custom'
  const catalogError = currentCatalog ? state.error : null
  const model = value?.model ?? ''
  const optionValues = value?.optionValues ?? {}
  async function refreshModels(): Promise<void> {
    if (!catalog?.discoverable || refreshing) return
    const request = latestCatalog.current
    setRefreshing(true)
    setRefreshMessage(null)
    setRefreshError(null)
    try {
      const result = (await context.call('quirky.agents/discoverModels', { agent, host })) as { authoritative?: boolean; reason?: string }
      if (latestCatalog.current !== request) return
      const refreshed = (await context.call('quirky.agents/options', { agent, host })) as Catalog
      if (latestCatalog.current !== request) return
      setState({ agent, host, info: refreshed, loading: false, error: null })
      if (!result.authoritative) setRefreshMessage(result.reason ?? 'No authoritative model list was returned; saved choices were kept.')
    } catch (error) {
      if (latestCatalog.current === request) setRefreshError(messageOf(error))
    } finally {
      if (latestCatalog.current === request) setRefreshing(false)
    }
  }

  if (agent === 'custom') return <p className="ui-text-muted">Custom command does not support catalog model or option picks.</p>
  if (agent === '') return <p className="ui-text-muted">Choose an agent to see its model and effort choices.</p>
  if (catalogError !== null) {
    return (
      <InlineError
        message={`Could not load this agent’s launch choices: ${catalogError}`}
        action={{ label: 'Retry', onAction: retryCatalog }}
      />
    )
  }
  if (catalog === null) {
    return catalogLoading
      ? <div role="status"><NoticeLine>Loading model and effort choices…</NoticeLine></div>
      : <InlineError message="Could not load this agent’s launch choices." action={{ label: 'Retry', onAction: retryCatalog }} />
  }
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
              onChange={(event) => onChange(optionsForModelChange(catalog, optionValues, event.target.value))}
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
            onChange={(event) => onChange(optionsForModelChange(catalog, optionValues, event.target.value))}
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
      {refreshError !== null && <InlineError message={refreshError} />}
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
              onChange={(event) => onChange(optionsForValueChange(model, optionValues, option, event.target.value))}
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
