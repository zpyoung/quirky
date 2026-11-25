import { describe, expect, it, vi } from 'vitest'

import { registerForkLocalizationCatalogs } from './fork-localization-catalogs'

describe('registerForkLocalizationCatalogs', () => {
  it('merges English immediately and a lazy locale when i18next loads it', () => {
    const addResourceBundle = vi.fn()
    let loaded: ((resources: Record<string, Record<string, unknown>>) => void) | undefined
    const i18n = {
      addResourceBundle,
      on: vi.fn(
        (
          _event: string,
          listener: (resources: Record<string, Record<string, unknown>>) => void
        ) => {
          loaded = listener
          return i18n
        }
      )
    }

    registerForkLocalizationCatalogs(i18n)

    const englishCatalogs = addResourceBundle.mock.calls
      .filter(([language]) => language === 'en')
      .map(([, , catalog]) => catalog)
    expect(englishCatalogs).toHaveLength(21)
    expect(englishCatalogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          components: expect.objectContaining({
            'native-chat': expect.objectContaining({ state: expect.any(Object) })
          })
        }),
        expect.objectContaining({
          components: expect.objectContaining({
            agentSessionContinuation: expect.objectContaining({
              forkSessionHandoff: expect.any(Object)
            })
          })
        }),
        expect.objectContaining({
          components: expect.objectContaining({
            settings: expect.objectContaining({ forkSessionHandoff: expect.any(Object) })
          })
        }),
        expect.objectContaining({ auto: expect.any(Object) }),
        expect.objectContaining({
          fork: expect.objectContaining({
            sessionInfo: expect.objectContaining({ title: expect.any(String) })
          })
        })
      ])
    )

    loaded?.({ es: { translation: true } })
    const spanishCatalogs = addResourceBundle.mock.calls
      .filter(([language]) => language === 'es')
      .map(([, , catalog]) => catalog)
    expect(spanishCatalogs).toHaveLength(21)
    expect(spanishCatalogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ components: expect.any(Object) }),
        expect.objectContaining({
          forkSessionHandoff: expect.objectContaining({ lineage: expect.any(Object) })
        }),
        expect.objectContaining({
          components: expect.objectContaining({
            settings: expect.objectContaining({ forkSessionHandoff: expect.any(Object) })
          })
        }),
        expect.objectContaining({ auto: expect.any(Object) }),
        expect.objectContaining({
          fork: expect.objectContaining({
            sessionInfo: expect.objectContaining({ title: expect.any(String) })
          })
        })
      ])
    )
  })
})
