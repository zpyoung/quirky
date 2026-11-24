import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalRightClickToPasteSearchEntry = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.windows.search.f0b8448570',
      'Right-click to paste'
    ),
    description: translate(
      'auto.components.settings.terminal.windows.search.8ba875c132',
      'Right-click pastes the clipboard into the terminal. Use Ctrl+right-click to open the context menu.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.terminal.windows.search.e7d2793b03',
        'terminal'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.windows.search.e55186fe2b',
        'right click'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.windows.search.fcfa53920b',
        'paste'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.windows.search.4d09141a42',
        'context menu'
      )
    ]
  }
])
