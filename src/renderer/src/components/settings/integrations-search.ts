import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getIntegrationsPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.integrations.search.f16e41cc72',
      'GitHub Integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.7166b9090c',
      'GitHub authentication via the gh CLI.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.b79c21bd42',
        'github'
      ),
      ...translateSearchKeyword('auto.components.settings.integrations.search.41ccade05c', 'gh'),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.c450244ad7',
        'integration'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.integrations.search.b50b71ef9d',
      'GitLab Integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.6e2ab619c6',
      'GitLab authentication via the glab CLI.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.b939695c69',
        'gitlab'
      ),
      ...translateSearchKeyword('auto.components.settings.integrations.search.b40cbe5de4', 'glab'),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.c450244ad7',
        'integration'
      ),
      ...translateSearchKeyword('auto.components.settings.integrations.search.581844769a', 'mr'),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.371ee914d2',
        'merge request'
      )
    ]
  },
  {
    title: translate('auto.components.settings.integrations.search.617603509b', 'Jira Integration'),
    description: translate(
      'auto.components.settings.integrations.search.76f6af7c57',
      'Connect Jira Cloud or update Jira API token credentials.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.integrations.search.e1263dd748', 'jira'),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.7345b7c3e6',
        'atlassian'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.c450244ad7',
        'integration'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.2ec2bd328c',
        'api token'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.20540996ef',
        'credentials'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.3c3d3d8ffa',
        'connect'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.a626990bd2',
        'disconnect'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.integrations.search.b027b4b318',
      'Linear Integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.16a486a49d',
      'Connect Linear to browse and link issues.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.7319e3015b',
        'linear'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.c450244ad7',
        'integration'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.faa0b5a0d9',
        'api key'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.3c3d3d8ffa',
        'connect'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.a626990bd2',
        'disconnect'
      )
    ]
  }
])
