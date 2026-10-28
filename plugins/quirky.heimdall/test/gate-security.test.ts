import { expect, test } from 'bun:test'
import type { Enrollment, KernelAction, Snapshot } from '../src/contracts'
import { gateAction } from '../src/gate'

test('an inherited property is not a capability grant, while an explicit same-name grant works', () => {
  const enrollment: Enrollment = {
    watcherId:'watcher-security',kind:'fixture',workspaceKey:'local::/workspace',workspacePath:'/workspace',
    executionHostId:'local',schedulerOwner:'daemon',kindPayload:null,enabled:true,paused:false,commandRevision:0,
    capabilities:{},budget:{ wallClockActiveMs:null,turns:null },coordinator:{ handle:'coordinator',paneKey:'pane' },
    orchestrationRunId:null,createdAtMs:0,terminalAtMs:null,parkReason:null,haltReason:null
  }
  const action: KernelAction = {
    kind:'publish',capability:'constructor',visibility:'external',contentIdentity:'revision',evidenceKey:'evidence',
    expectedState:{ target:'published-revision',before:null }
  }
  const snapshot: Snapshot = { freshness:'live',contentIdentity:'revision',observedAtMs:0,world:null }
  const input = { enrollment,action,snapshot,journal:[],budget:{ activeMs:0,turns:0,exhausted:null } }
  expect(gateAction(input)).toEqual({ verdict:'hold',reason:'capability-off' })
  enrollment.capabilities = { constructor:'on' }
  expect(gateAction(input)).toEqual({ verdict:'allow' })
})
