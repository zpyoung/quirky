import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from './helpers'

const runs: HostingTest[] = []
afterEach(async () => { for (const run of runs.splice(0).reverse()) await run.cleanup() })
const fixture = String.raw`
import { readFileSync,writeFileSync,renameSync } from 'node:fs'
import { join } from 'node:path'
const path=join(process.env.QUIRKY_TEST_FIXTURE_DIR,'state.json'), state=JSON.parse(readFileSync(path,'utf8'))
const args=process.argv.slice(2),input=JSON.parse(process.env.QUIRKY_TEST_GH_INPUT||'{}'),variables={...(input.variables||{})}
let query=input.query||''
for(let i=0;i<args.length;i++) {const value=['-f','-F','--field','--raw-field'].includes(args[i])?args[++i]:args[i];const at=value.indexOf('=');if(at<1)continue;const key=value.slice(0,at),text=value.slice(at+1);if(key==='query')query=text;else{try{variables[key]=JSON.parse(text)}catch{variables[key]=text}}}
const output=value=>{console.log(JSON.stringify(value));process.exit(0)}
if(args.includes('auth')){console.log('Logged in to github.com account fixture (keyring)\nActive account: true\nToken scopes: repo,project,read:org');process.exit(0)}
const iterations=[{id:'sprint-one',title:'Sprint one',startDate:'2026-10-19',duration:14},{id:'sprint-two',title:'Sprint two',startDate:'2026-11-02',duration:14}]
const field={__typename:'ProjectV2IterationField',id:'iteration',name:'Sprint',dataType:'ITERATION',...(query.includes('configuration')?{configuration:{iterations,completedIterations:[]}}:{})}
if(query.includes('ProjectViews'))output({data:{organization:{projectV2:{id:'P1',number:1,views:{nodes:[{id:'V1',number:1,name:'Sprint board',layout:'BOARD',filter:'',fields:{nodes:[field]},verticalGroupByFields:{nodes:[field]},groupByFields:{nodes:[]},sortByFields:{nodes:[]}}],pageInfo:{hasNextPage:false}}}}}})
if(query.includes('ProjectItems')) {
 const selected=iterations.find(value=>value.id===(state.iterationId||'sprint-one'))
 // Like GraphQL, return iteration fields only when this operation requests the type's selection.
 const fieldValues=query.includes('ProjectV2ItemFieldIterationValue')&&selected?[{__typename:'ProjectV2ItemFieldIterationValue',field:{id:'iteration',name:'Sprint'},iterationId:selected.id,title:selected.title,startDate:selected.startDate,duration:selected.duration}]:[{__typename:'ProjectV2ItemFieldIterationValue'}]
 output({data:{organization:{projectV2:{id:'P1',number:1,title:'Iteration project',items:{totalCount:1,pageInfo:{hasNextPage:false},nodes:[{id:'I1',type:'ISSUE',content:{__typename:'Issue',number:7,title:'Plan sprint',issueState:'OPEN',url:'https://github.com/test-owner/test-repo/issues/7',repository:{nameWithOwner:'test-owner/test-repo'}},fieldValues:{nodes:fieldValues}}]}}}}})
}
if(query.includes('ProjectItemContext'))output({data:{project:{id:'P1'},item:{id:'I1',project:{id:'P1'}}}})
if(query.includes('SetProjectField')){state.iterationId=variables.input.value.iterationId;const temp=path+'.'+process.pid;writeFileSync(temp,JSON.stringify(state));renameSync(temp,path);output({data:{updateProjectV2ItemFieldValue:{projectV2Item:{id:'I1'}}}})}
console.error('unhandled iteration fixture query');process.exit(1)
`

test('iteration project views preserve real option intervals and read back a card moved to the next sprint', async () => {
  const run = await bootHosting(fixture)
  runs.push(run)
  run.writeState({ iterationId: 'sprint-one' })
  const target = { owner: 'test-owner', ownerType: 'organization', projectNumber: 1, viewId: 'V1' }
  const before = await run.call('projectTable', target) as { fields: { id: string; options: { id: string; name: string; startDate: string; duration: number }[] }[]; items: { fieldValues: { fieldId: string; value: unknown }[] }[] }
  expect(before.fields[0]?.options).toEqual([
    { id: 'sprint-one', name: 'Sprint one', startDate: '2026-10-19', duration: 14, completed: false },
    { id: 'sprint-two', name: 'Sprint two', startDate: '2026-11-02', duration: 14, completed: false }
  ])
  expect(before.items[0]?.fieldValues[0]?.value).toEqual({ iterationId: 'sprint-one', title: 'Sprint one', startDate: '2026-10-19', duration: 14 })
  await run.call('projectField', { projectId: 'P1', itemId: 'I1', fieldId: 'iteration', value: { iterationId: 'sprint-two' } })
  const after = await run.call('projectTable', target) as { items: { fieldValues: { value: { iterationId: string; startDate: string } }[] }[] }
  expect(after.items[0]?.fieldValues[0]?.value.iterationId).toBe('sprint-two')
  expect(after.items[0]?.fieldValues[0]?.value.startDate).toBe('2026-11-02')
}, 20_000)

test('explicit Project refresh adopts external changes instead of replaying a cached table', async () => {
  const run = await bootHosting(fixture)
  runs.push(run)
  const target = { owner: 'test-owner', ownerType: 'organization', projectNumber: 1, viewId: 'V1' }
  run.writeState({ iterationId: 'sprint-one' })
  const before = await run.call('projectTable', target) as { items: { fieldValues: { value: { iterationId: string } }[] }[] }
  expect(before.items[0]?.fieldValues[0]?.value.iterationId).toBe('sprint-one')
  run.writeState({ iterationId: 'sprint-two' })
  const fresh = await run.call('projectTable', { ...target, noCache: true }) as { items: { fieldValues: { value: { iterationId: string } }[] }[] }
  expect(fresh.items[0]?.fieldValues[0]?.value.iterationId).toBe('sprint-two')
  const retained = await run.call('projectTable', target) as { items: { fieldValues: { value: { iterationId: string } }[] }[] }
  expect(retained.items[0]?.fieldValues[0]?.value.iterationId).toBe('sprint-two')
}, 20_000)
