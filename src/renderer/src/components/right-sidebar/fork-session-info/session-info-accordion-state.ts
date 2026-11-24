import { useCallback, useState } from 'react'

export const SESSION_INFO_SECTION_IDS = [
  'identity',
  'usage',
  'live',
  'context',
  'files',
  'hooks'
] as const
export type SessionInfoSectionId = (typeof SESSION_INFO_SECTION_IDS)[number]

const STORAGE_KEY = 'quirky:session-info:open-sections:v1'
const DEFAULT_OPEN_SECTIONS: SessionInfoSectionId[] = ['live']
const SECTION_ID_SET = new Set<string>(SESSION_INFO_SECTION_IDS)

export function parseStoredSessionInfoSections(value: string | null): SessionInfoSectionId[] {
  if (value === null) {
    return DEFAULT_OPEN_SECTIONS
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      return DEFAULT_OPEN_SECTIONS
    }
    return parsed.filter(
      (section, index): section is SessionInfoSectionId =>
        typeof section === 'string' &&
        SECTION_ID_SET.has(section) &&
        parsed.indexOf(section) === index
    )
  } catch {
    return DEFAULT_OPEN_SECTIONS
  }
}

function readOpenSections(): SessionInfoSectionId[] {
  try {
    return parseStoredSessionInfoSections(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_OPEN_SECTIONS
  }
}

export function usePersistedSessionInfoSections(): {
  openSections: SessionInfoSectionId[]
  setOpenSections: (sections: string[]) => void
} {
  const [openSections, setOpenSectionsState] = useState<SessionInfoSectionId[]>(readOpenSections)
  const setOpenSections = useCallback((sections: string[]) => {
    const normalized = sections.filter((section): section is SessionInfoSectionId =>
      SECTION_ID_SET.has(section)
    )
    setOpenSectionsState(normalized)
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
    } catch {
      // preference persistence must not block the inspector
    }
  }, [])
  return { openSections, setOpenSections }
}
