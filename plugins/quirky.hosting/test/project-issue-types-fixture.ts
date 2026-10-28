export const PROJECT_ISSUE_TYPES_FIXTURE = String.raw`
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
const path = join(process.env.QUIRKY_TEST_FIXTURE_DIR, 'state.json')
const state = JSON.parse(readFileSync(path, 'utf8'))
const args = process.argv.slice(2)
const input = JSON.parse(process.env.QUIRKY_TEST_GH_INPUT || '{}')
const variables = { ...(input.variables || {}) }
let query = input.query || ''
for (let i = 0; i < args.length; i++) {
  const value = ['-f', '-F', '--field', '--raw-field'].includes(args[i]) ? args[++i] : args[i]
  const at = value.indexOf('=')
  if (at < 1) continue
  const key = value.slice(0, at)
  const text = value.slice(at + 1)
  if (key === 'query') query = text
  else {
    try { variables[key] = JSON.parse(text) }
    catch { variables[key] = text }
  }
}
const save = () => {
  const temporary = path + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(state))
  renameSync(temporary, path)
}
const output = value => { console.log(JSON.stringify(value)); process.exit(0) }
if (args.includes('auth')) {
  console.log('Logged in to github.com account fixture (keyring)\nActive account: true\nToken scopes: repo,project,read:org')
  process.exit(0)
}
state.graphqlCalls = Array.isArray(state.graphqlCalls) ? state.graphqlCalls : []
state.graphqlCalls.push({ query, variables })
save()
if (query.includes('ProjectItemContext')) {
  output({ data: {
    project: { __typename: 'ProjectV2', id: state.projectId, owner: state.projectOwner },
    item: {
      __typename: 'ProjectV2Item', id: state.itemId, type: 'ISSUE', project: { id: state.projectId },
      content: { __typename: 'Issue', number: state.issueNumber, url: 'https://github.com/' + state.repositoryOwner.login + '/' + state.repository + '/issues/' + state.issueNumber }
    }
  } })
}
if (query.includes('issueTypes') && query.includes('repository(')) {
  const cursor = typeof variables.cursor === 'string' ? variables.cursor : 'start'
  const page = state.issueTypePages && state.issueTypePages[cursor]
  const types = state.organizationIssueTypes[state.repositoryOwner.login] || []
  const repository = { issue: { id: page?.issueId || 'ISSUE_NODE_' + state.issueNumber } }
  if (query.includes('owner {')) {
    const connection = page && Object.prototype.hasOwnProperty.call(page, 'connection')
      ? page.connection
      : { nodes: types, pageInfo: { endCursor: null, hasNextPage: false } }
    repository.owner = state.repositoryOwner.__typename === 'Organization'
      ? { ...state.repositoryOwner, issueTypes: connection }
      : state.repositoryOwner
  }
  const data = { repository }
  if (query.includes('organization(login:')) {
    const requestedOwner = variables.owner
    data.organization = requestedOwner === state.repositoryOwner.login && state.repositoryOwner.__typename === 'Organization'
      ? { issueTypes: { nodes: types, pageInfo: { endCursor: null, hasNextPage: false } } }
      : null
  }
  output({ data })
}
if (query.includes('SetIssueType')) {
  const mutationInput = variables.input || variables
  const types = state.organizationIssueTypes[state.repositoryOwner.login] || []
  const selected = state.repositoryOwner.__typename === 'Organization'
    ? types.find(value => value.id === mutationInput.issueTypeId && value.isEnabled !== false) || null
    : null
  if (selected) state.issueType = selected
  save()
  output({ data: { updateIssueIssueType: { issue: { id: mutationInput.issueId, issueType: selected } } } })
}
console.error('unhandled issue type fixture query')
process.exit(1)
`
