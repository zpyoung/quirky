#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const fixtureDir = process.env.QUIRKY_TEST_FIXTURE_DIR
if (!fixtureDir) throw new Error('missing isolated GitHub fixture directory')
const state = JSON.parse(readFileSync(join(fixtureDir, 'state.json'), 'utf8'))
const args = process.argv.slice(2)
appendFileSync(join(fixtureDir, 'gh.jsonl'), `${JSON.stringify(args)}\n`)
const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
const fail = (message) => {
  process.stderr.write(message)
  process.exit(1)
}

if (args[0] === 'auth' && args[1] === 'status') {
  if (state.authenticated === false) fail('You are not logged into any GitHub hosts. Run gh auth login.')
  out('Logged in to github.com account fixture-user (keyring)\nActive account: true\nToken scopes: repo, read:org\n')
} else if (args[0] === 'auth' && args[1] === 'token') {
  if (args.includes('--help')) out('gh auth token [--hostname HOST]')
  else out('isolated-fixture-token\n')
} else if (args[0] === 'api') {
  if (args.includes('rate_limit')) {
    out({ resources: { core: { limit: 5000, remaining: 4500, reset: 1999999999 }, graphql: { limit: 5000, remaining: 4500, reset: 1999999999 }, search: { limit: 30, remaining: 30, reset: 1999999999 } } })
  } else if (args.includes('user')) {
    out({ login: 'fixture-user' })
  } else {
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
    const issue = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(endpoint)
    const pull = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(endpoint)
    if (state.apiFailure) fail(String(state.apiFailure))
    if (issue) {
      const number = issue[1]
      const item = state.issues?.[number]
      const pullItem = state.pulls?.[number]
      if (!item && !pullItem) fail('HTTP 404: Not Found')
      out(pullItem
        ? { number: Number(number), title: pullItem.title, body: pullItem.body, html_url: pullItem.html_url, state: pullItem.state, pull_request: { url: `https://api.github.com/repos/${pullItem.base.repo.owner.login}/${pullItem.base.repo.name}/pulls/${number}` } }
        : item)
    } else if (pull) {
      const item = state.pulls?.[pull[1]]
      if (!item) fail('HTTP 404: Not Found')
      out(item)
    } else {
      fail(`unsupported fixture endpoint: ${endpoint}`)
    }
  }
} else if (args[0] === 'pr' && args[1] === 'view') {
  const number = args.find((arg, index) => index > 1 && /^\d+$/.test(arg))
  const item = number ? state.pulls?.[number] : undefined
  if (!item) fail('HTTP 404: Not Found')
  out({
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state.toUpperCase(),
    url: item.html_url,
    isDraft: item.draft === true,
    headRefName: item.head.ref,
    baseRefName: item.base.ref,
    headRefOid: item.head.sha,
    baseRefOid: item.base.sha,
    maintainerCanModify: item.maintainer_can_modify === true,
    headRepository: { name: item.head.repo.name, owner: { login: item.head.repo.owner.login } },
    baseRepository: { name: item.base.repo.name, owner: { login: item.base.repo.owner.login } }
  })
} else {
  fail(`unsupported fixture command: ${args.join(' ')}`)
}
