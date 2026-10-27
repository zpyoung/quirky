import { describe, expect, test } from 'bun:test'
import { foldLead } from '../src/fold'
import type { AgentState, Child } from '../src/types'

const agent = (state: Child['state'] = 'working'): Child => ({ id: 'a', kind: 'agent', state })
const shell = (state: Child['state'] = 'working'): Child => ({ id: 's', kind: 'shell', state })
const cron = (state: Child['state'] = 'working'): Child => ({ id: 'c', kind: 'cron', state })

const table: [string, AgentState, Child[], boolean, { state: AgentState; workingMode?: 'monitoring' }][] = [
  ['lead waiting wins over a working agent', 'waiting', [agent()], false, { state: 'waiting' }],
  ['lead blocked wins over a waiting child', 'blocked', [agent('waiting')], false, { state: 'blocked' }],
  ['lead waiting wins over crons', 'waiting', [], true, { state: 'waiting' }],
  ['a waiting child outranks a working lead', 'working', [agent('waiting')], false, { state: 'waiting' }],
  ['a waiting shell outranks a working lead', 'working', [shell('waiting')], false, { state: 'waiting' }],
  ['a waiting child holds a settled lead open as waiting', 'done', [agent('waiting')], false, { state: 'waiting' }],
  ['a waiting child outranks live agent work', 'done', [agent(), agent('waiting')], false, { state: 'waiting' }],
  ['a done child no longer waits', 'working', [agent('done')], false, { state: 'working' }],
  ['a working lead stays working over shells', 'working', [shell()], false, { state: 'working' }],
  ['a working lead with no children', 'working', [], false, { state: 'working' }],
  ['a working lead with crons stays plain working', 'working', [], true, { state: 'working' }],
  ['done lead with a live agent child is working', 'done', [agent()], false, { state: 'working' }],
  ['done lead with agent and shell is working', 'done', [shell(), agent()], false, { state: 'working' }],
  ['done lead with only a shell is monitoring', 'done', [shell()], false, { state: 'working', workingMode: 'monitoring' }],
  ['done lead with only a cron child is monitoring', 'done', [cron()], false, { state: 'working', workingMode: 'monitoring' }],
  ['done lead with active session crons is monitoring', 'done', [], true, { state: 'working', workingMode: 'monitoring' }],
  ['done lead, finished children and no crons is done', 'done', [agent('done'), shell('done')], false, { state: 'done' }],
  ['done lead with nothing is done', 'done', [], false, { state: 'done' }],
]

describe('foldLead', () => {
  test.each(table)('%s', (_name, lead, children, crons, expected) => {
    expect(foldLead(lead, children, crons)).toEqual(expected)
  })
})
