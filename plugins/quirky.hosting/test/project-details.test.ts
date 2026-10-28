import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from './helpers'

const runs: HostingTest[] = []
afterEach(async () => { for (const run of runs.splice(0).reverse()) await run.cleanup() })
const fixture = String.raw`
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
const path = join(process.env.QUIRKY_TEST_FIXTURE_DIR, 'state.json')
const state = JSON.parse(readFileSync(path,'utf8'))
const args=process.argv.slice(2)
const input=JSON.parse(process.env.QUIRKY_TEST_GH_INPUT||'{}')
const variables={...(input.variables||{})}
let query=input.query||''
for(let i=0;i<args.length;i++) {
 const value=['-f','-F','--field','--raw-field'].includes(args[i])?args[++i]:args[i]
 const at=value.indexOf('='); if(at<1) continue
 const key=value.slice(0,at), text=value.slice(at+1)
 if(key==='query') query=text
 else { try {variables[key]=JSON.parse(text)} catch {variables[key]=text} }
}
const output=value=>{console.log(JSON.stringify(value));process.exit(0)}
if(args.includes('auth')) { console.log('Logged in to github.com account fixture (keyring)\nActive account: true\nToken scopes: repo,project,read:org');process.exit(0) }
if(query.includes('ProjectItemContext')) output({data:{project:{__typename:'ProjectV2',id:'P1',owner:{__typename:'Organization',login:'outside'}},item:{__typename:'ProjectV2Item',id:'I1',type:'ISSUE',project:{id:state.wrongProject?'P2':'P1'},content:{__typename:'Issue',number:9,url:'https://github.com/outside/foreign/issues/9'}}}})
if(query.includes('WorkItemDetails')) output({data:{repository:{issue:{
  __typename:'Issue',number:state.issue.number,title:state.issue.title,body:state.issue.body,state:state.issue.state,url:state.issue.html_url,author:{login:'author'},
  ...(query.includes('labels(')?{labels:{nodes:(state.issue.labels||[]).map(value=>typeof value==='string'?{name:value}:value),pageInfo:{hasNextPage:false}}}:{}),
  ...(query.includes('stateReason')?{stateReason:String(state.issue.state_reason||'completed').toUpperCase()}:{}),
  ...(query.includes('viewerCanUpdate')?{viewerCanUpdate:state.editable!==false}:{}),
  assignees:{nodes:[]},participants:{nodes:[{login:'author'}]},comments:{nodes:state.comments,pageInfo:{hasNextPage:false}}
},pullRequest:null}}})
const endpoint=args.find(value=>value.startsWith('repos/'))||''
const methodAt=args.findIndex(value=>value==='--method'||value==='-X')
const method=methodAt<0?'GET':args[methodAt+1]
if(endpoint==='repos/outside/foreign/issues/9'||(state.localIssue&&endpoint==='repos/test-owner/test-repo/issues/9')) output(state.issue)
if(endpoint.includes('/timeline')) output([{event:'assigned',created_at:'2026-10-27T10:00:00Z',actor:{login:'maintainer'}}])
if(endpoint.includes('/comments')) {
 if(method==='POST') {
   const comment={id:state.comments.length+1,body:input.body,url:'https://github.com/outside/foreign/issues/9#issuecomment-1',createdAt:'2026-10-27T11:00:00Z',author:{login:'fixture'}}
   state.comments.push(comment)
   const temporary=path+'.'+process.pid+'.tmp'; writeFileSync(temporary,JSON.stringify(state));renameSync(temporary,path)
   output(comment)
 }
 output(state.comments)
}
console.error('unhandled isolated endpoint '+endpoint);process.exit(1)
`

async function boot() {
  const run = await bootHosting(fixture)
  runs.push(run)
  run.writeState({ issue: { number: 9, title: 'Outside repository issue', body: 'Project-authorized content', state: 'open', html_url: 'https://github.com/outside/foreign/issues/9', author: { login: 'author' }, labels: [], assignees: [] }, comments: [] })
  return run
}

test('project item details read the actual foreign issue and preserve confirmed comments through the ambient authorized route', async () => {
  const run = await boot()
  const target = { projectId: 'P1', itemId: 'I1' }
  const before = await run.call('projectItemDetails', target) as { item: { title: string; url: string }; comments: { body: string }[]; timeline: { event: string }[] }
  expect(before.item.title).toBe('Outside repository issue')
  expect(before.item.url).toBe('https://github.com/outside/foreign/issues/9')
  expect(before.comments).toEqual([])
  expect(before.timeline[0]?.event).toBe('assigned')
  await run.call('projectItemMutation', { ...target, action: 'addComment', body: 'Confirmed project comment' })
  const after = await run.call('projectItemDetails', target) as { comments: { body: string }[] }
  expect(after.comments.map(comment => comment.body)).toEqual(['Confirmed project comment'])
  await expect(run.call('workItemDetails', { reference: before.item.url, kind: 'issue', number: 9 })).rejects.toThrow()
}, 20_000)

test('project details reject mismatched membership and untrusted host before reading any foreign issue data', async () => {
  const run = await boot()
  const initial = run.readState() as Record<string, unknown>
  run.writeState({ ...initial, wrongProject: true })
  await expect(run.call('projectItemDetails', { projectId: 'P1', itemId: 'I1' })).rejects.toThrow()
  expect(run.invocations().some(entry => entry.args.some(arg => arg.startsWith('repos/outside/foreign/')))).toBe(false)
  await expect(run.call('projectItemDetails', { projectId: 'P1', itemId: 'I1', host: 'attacker.example' })).rejects.toThrow()
  expect(run.invocations().some(entry => entry.args.includes('attacker.example'))).toBe(false)
}, 20_000)

test('manual detail refresh adopts external changes and replaces the stale cached projection', async () => {
  const run = await boot()
  const issue = { number: 9, title: 'Local issue', body: 'Before external edit', state: 'open', html_url: 'https://github.com/test-owner/test-repo/issues/9', author: { login: 'author' }, labels: [], assignees: [] }
  run.writeState({ issue, localIssue: true, comments: [] })
  const before = await run.call('workItemDetails', { kind: 'issue', number: 9 }) as { item: { body: string } }
  expect(before.item.body).toBe('Before external edit')
  run.writeState({ issue: { ...issue, body: 'After external edit' }, localIssue: true, comments: [] })
  const refreshed = await run.call('workItemDetails', { kind: 'issue', number: 9, noCache: true }) as { item: { body: string } }
  expect(refreshed.item.body).toBe('After external edit')
  const retained = await run.call('workItemDetails', { kind: 'issue', number: 9 }) as { item: { body: string } }
  expect(retained.item.body).toBe('After external edit')
}, 20_000)

test('issue details retain labels and closure reason and report a real read-only description capability', async () => {
  const run = await boot()
  run.writeState({ issue: { number: 9, title: 'Read-only issue', body: 'Keep metadata', state: 'closed', state_reason: 'not_planned', html_url: 'https://github.com/test-owner/test-repo/issues/9', labels: [{ name: 'triaged' }], assignees: [] }, localIssue: true, comments: [], editable: false })
  const result = await run.call('workItemDetails', { kind: 'issue', number: 9 }) as { item: { labels: string[]; stateReason: string }; viewerCanUpdate: boolean | null }
  expect(result.item.labels).toEqual(['triaged'])
  expect(result.item.stateReason).toBe('not_planned')
  expect(result.viewerCanUpdate).toBe(false)
}, 20_000)
