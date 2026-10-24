import { join } from 'node:path'
import {
  bytesToBase64,
  encodeTerminalOutput,
  type Ask,
  type GitFileStatus,
  type Repo,
  type Session,
  type Worktree
} from '@quirky/protocol'

const DIST = join(import.meta.dir, '..', 'dist')
const TOKEN = 'mock-token'

const repo: Repo = { id: 'r1', name: 'demo', path: '/demo', addedAt: 1 }
const worktrees: Worktree[] = [
  { id: 'w1', repoId: 'r1', path: '/demo', branch: 'main', head: 'abc', isMain: true, name: 'main' },
  { id: 'w2', repoId: 'r1', path: '/wt/demo/feature', branch: 'feature', head: 'def', isMain: false, name: 'feature' }
]
const sessions: Session[] = [
  mkSession('s1', 'w1', 'shell', 'running', 'Shell'),
  mkSession('s2', 'w1', 'claude', 'waiting', 'Claude'),
  mkSession('s3', 'w2', 'shell', 'working', 'Shell'),
  { ...mkSession('s4', 'w2', 'claude', 'running', 'Claude (bg)'), kind: 'structured' },
  { ...mkSession('s5', 'w2', 'claude', 'exited', 'Claude (done)'), kind: 'structured', exitCode: 0 }
]
const transcript = (sessionId: string) => [
  { sessionId, seq: 1, role: 'system', text: 'hook_started: SessionStart', at: 0 },
  { sessionId, seq: 2, role: 'system', text: 'hook_response: ok', at: 0 },
  { sessionId, seq: 3, role: 'user', text: 'say hi', at: 0 },
  { sessionId, seq: 4, role: 'assistant', text: '', at: 0 },
  { sessionId, seq: 5, role: 'assistant', text: 'hi there', at: 0 }
]
const asks: Ask[] = [
  {
    id: 'a1',
    spec: {
      title: 'Which database?',
      questions: [
        {
          id: 'db',
          type: 'select',
          question: 'Pick one',
          options: [
            { value: 'pg', label: 'Postgres' },
            { value: 'sqlite', label: 'SQLite' }
          ]
        }
      ]
    },
    sessionId: 's2',
    worktreeId: 'w1',
    createdAt: 1,
    envelope: { status: 'pending', askId: 'a1', answers: {}, skipped: [] }
  }
]
const files: GitFileStatus[] = [
  { path: 'src/app.ts', index: ' ', worktree: 'M', untracked: false },
  { path: 'README.md', index: 'M', worktree: ' ', untracked: false }
]

function mkSession(id: string, worktreeId: string, agent: Session['agent'], status: Session['status'], title: string): Session {
  return { id, kind: 'terminal', agent, worktreeId, cwd: '/demo', title, status, createdAt: Number(id.slice(1)), lastActivityAt: 0, exitCode: null }
}

function handle(method: string, params: any, send: (bytes: Uint8Array) => void): unknown {
  switch (method) {
    case 'client.hello':
      return { protocolVersion: 1, daemonVersion: 'mock' }
    case 'events.subscribe':
    case 'terminal.detach':
    case 'terminal.write':
    case 'terminal.resize':
    case 'git.stage':
    case 'git.unstage':
      return { ok: true }
    case 'ask.cancel':
    case 'ask.answer':
      return { status: 'declined', askId: params.askId, answers: {}, skipped: [] }
    case 'session.create': {
      const session = mkSession(`s${sessions.length + 1}`, params.worktreeId, params.agent, 'running', params.agent)
      sessions.push(session)
      return session
    }
    case 'settings.get':
      return { worktreesRoot: '/wt', terminalScrollback: 2000, notifications: true }
    case 'repo.list':
      return [repo]
    case 'worktree.list':
      return worktrees
    case 'session.list':
      return sessions
    case 'ask.list':
      return asks
    case 'terminal.attach': {
      setTimeout(() => send(encodeTerminalOutput(1, new TextEncoder().encode('live output\r\n'))), 100)
      return { streamId: 1, replay: bytesToBase64(new TextEncoder().encode('hello\r\n')), offset: 7 }
    }
    case 'git.status':
      return { branch: 'main', upstream: null, ahead: 0, behind: 0, files }
    case 'git.diff':
      return {
        path: params.path,
        staged: params.staged,
        original: 'export const a = 1\nexport const b = 2\n',
        modified: 'export const a = 1\nexport const b = 3\nexport const c = 4\n',
        binary: false
      }
    case 'structured.messages':
      return transcript(params.sessionId)
    default:
      throw new Error(`mock daemon: unhandled ${method}`)
  }
}

/** Serves `dist/` and a canned daemon at `/rpc?token=mock-token`; returns the base URL. */
export function startMockDaemon(port = 0): { url: string; stop: () => void } {
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === '/health') return Response.json({ ok: true })
      if (url.pathname === '/rpc') {
        if (url.searchParams.get('token') !== TOKEN) return new Response('unauthorized', { status: 401 })
        return server.upgrade(request) ? undefined : new Response('upgrade failed', { status: 400 })
      }
      const file = Bun.file(join(DIST, url.pathname === '/' ? 'index.html' : url.pathname))
      return (await file.exists()) ? new Response(file) : new Response(Bun.file(join(DIST, 'index.html')))
    },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(String(message))
        try {
          const result = handle(request.method, request.params, (bytes) => socket.send(bytes))
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
        } catch (error) {
          socket.send(
            JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: String(error) } })
          )
        }
      }
    }
  })
  return { url: `http://127.0.0.1:${server.port}/#token=${TOKEN}`, stop: () => server.stop(true) }
}

if (import.meta.main) {
  const { url } = startMockDaemon(Number(process.env.PORT ?? 0))
  console.log(url)
}
