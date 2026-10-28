import { validateValue, type Schema } from '@quirky/protocol'
import { fault } from './errors'
import type { NativeResponse } from './native'

export function nativeData<T>(response: NativeResponse, schema: Schema, description: string): T {
  if (!response.success) throw fault('browser_error', response.error ?? `native helper failed during ${description}`)
  const failure = validateValue(schema, response.data, description)
  if (failure) throw fault('browser_tab_changed', `native helper returned malformed ${description} data`)
  return response.data as T
}
