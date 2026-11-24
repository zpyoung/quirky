import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { RuntimeSkillCommands } from './runtime-skill-command-surface'

describe('RuntimeSkillCommands', () => {
  it('uses the account-managed Claude config directory for global discovery', async () => {
    const commands = new RuntimeSkillCommands({
      getClaudeConfigDirectory: () => '/accounts/claude/managed'
    })

    await expect(
      commands.resolveSkillDiscoveryProviderRoots({ kind: 'native-host' })
    ).resolves.toMatchObject({ claude: join('/accounts/claude/managed', 'skills') })
  })
})
