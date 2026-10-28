import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from './helpers'
import { conversationFixture } from './review-conversation-fixture'
let h: HostingTest | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })
const source = String.raw`
import {readFileSync as readLinkState} from 'node:fs';
const linkArgs = process.argv.slice(2);
const linkState = JSON.parse(readLinkState(process.env.QUIRKY_TEST_FIXTURE_DIR + '/state.json', 'utf8'));
const linkEndpoint = linkArgs.find(value => value.startsWith('repos/'));
if (linkEndpoint === 'repos/test-owner/test-repo/issues/7/comments?per_page=100') { process.stdout.write(JSON.stringify(linkState.restComments || [])); process.exit(0); }
if (linkEndpoint === 'repos/test-owner/test-repo/pulls/7/reviews?per_page=100') { process.stdout.write('[]'); process.exit(0); }
if (linkArgs.includes('graphql')) {
 const linkBody = JSON.parse(process.env.QUIRKY_TEST_GH_INPUT || '{}');
 if (typeof linkBody.query === 'string' && linkBody.query.includes('HostingComments')) { process.stdout.write(JSON.stringify(linkState.graph || { errors: [{message:'temporarily unavailable'}] })); process.exit(0); }
}
` + conversationFixture

function comments(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || !('comments' in value) || !Array.isArray(value.comments)) throw new Error('Missing comments')
  return value.comments.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid comment')
    return item as Record<string, unknown>
  })
}

test('existing comments expose safe human routes and provider bot identity without advertising unsafe destinations', async () => {
  h = await bootHosting(source)
  h.writeState({ graph: { data: { repository: { pullRequest: {
    comments: { nodes: [
      { id: 'IC101', databaseId: 101, body: 'bot without a bot nickname', url: 'https://github.com/test-owner/test-repo/pull/7#issuecomment-101', author: {login:'alex',__typename:'Bot'} },
      { id: 'IC102', databaseId: 102, body: 'unsafe route', url: 'javascript:alert(1)', author: {login:'pat',__typename:'User'} }
    ], pageInfo: {hasNextPage:false} }, reviews:{nodes:[],pageInfo:{hasNextPage:false}},reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}
  } } } } })
  const graph = comments(await h.call('comments', { number: 7, noCache: true }))
  expect(graph.find(item => item.id === 101)).toMatchObject({ url: 'https://github.com/test-owner/test-repo/pull/7#issuecomment-101', isBot: true })
  expect(graph.find(item => item.id === 102)).toMatchObject({ url: null, isBot: false })
  h.writeState({restComments:[{id:103,body:'fallback',html_url:'https://github.com/test-owner/test-repo/pull/7#issuecomment-103',url:'https://api.github.com/repos/test-owner/test-repo/issues/comments/103',user:{login:'sam',type:'User'}},{id:104,body:'credential URL',html_url:'https://secret@example.test/comment',user:{login:'unknown'}}]})
  const rest = comments(await h.call('comments', { number: 7, noCache: true }))
  expect(rest.find(item => item.id === 103)).toMatchObject({ url: 'https://github.com/test-owner/test-repo/pull/7#issuecomment-103', isBot: false })
  expect(rest.find(item => item.id === 104)).toMatchObject({ url: null, isBot: null })
}, 20_000)
