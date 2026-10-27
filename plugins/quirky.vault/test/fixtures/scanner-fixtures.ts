import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import type { HistoryAgent } from '../../src/agents'

type ExpectedSession = { sessionId: string; title: string; cwd: string | null }
export type EveryAgentFixture = {
  expected: Record<string, ExpectedSession>
  paths: { claude?: string }
}
type JsonlOptions = { unterminatedTail?: unknown }
type CursorFixture = {
  transcript: string
  metadata: string
  sessionId: string
  files: { transcript: string; metadata: string }
}

const CURSOR_CREATED_AT_MS = 1_787_039_612_017
const CURSOR_UPDATED_AT_MS = 1_787_039_640_532
const KIRO_SESSION_ID = '0b5e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d'
const ANTIGRAVITY_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SQLITE_EPOCH_MS = 1_740_000_000_000
function fixtureMarker(agent: HistoryAgent): string {
  return `vault-fixture-${agent}-marker`
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

async function writeJsonl(path: string, records: readonly unknown[], options: JsonlOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  let body = records.map((record) => JSON.stringify(record)).join('\n')
  if (options.unterminatedTail !== undefined) {
    if (records.length > 0) body += '\n'
    body += JSON.stringify(options.unterminatedTail)
  } else {
    body += '\n'
  }
  await writeFile(path, body)
}

function jsonlPath(home: string, agent: HistoryAgent, sessionId: string): string {
  switch (agent) {
    case 'claude':
      return join(home, '.claude', 'projects', 'project', `${sessionId}.jsonl`)
    case 'codebuddy':
      return join(home, '.codebuddy', 'projects', 'project', `${sessionId}.jsonl`)
    case 'qoder':
      return join(home, '.qoder', 'projects', 'project', `${sessionId}.jsonl`)
    case 'codex':
      return join(home, '.codex', 'sessions', '2026', '05', '01', `rollout-${sessionId}.jsonl`)
    case 'copilot':
      return join(home, '.copilot', 'session-state', `${sessionId}.jsonl`)
    case 'cursor':
      return join(home, '.cursor', 'projects', 'project', 'agent-transcripts', sessionId, `${sessionId}.jsonl`)
    case 'antigravity':
      return join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl')
    case 'pi':
      return join(home, '.pi', 'agent', 'sessions', `${sessionId}.jsonl`)
    case 'omp':
      return join(home, '.omp', 'agent', 'sessions', `${sessionId}.jsonl`)
    case 'prime-agent':
      return join(home, '.prime', 'agent', 'sessions', `${sessionId}.jsonl`)
    case 'openclaw':
      return join(home, '.openclaw', 'agents', 'default', 'sessions', `${sessionId}.jsonl`)
    case 'droid':
      return join(home, '.factory', 'sessions', `${sessionId}.jsonl`)
    case 'muse':
      return join(home, '.local', 'share', 'muse', 'sessions', '2026', '05', '01', sessionId, 'session.jsonl')
    default:
      throw new Error(`${agent} does not use a standalone JSONL session transcript`)
  }
}

export async function writeJsonlFixture(
  home: string,
  agent: HistoryAgent,
  sessionId: string,
  records: readonly unknown[],
  options: JsonlOptions = {}
): Promise<string> {
  const filePath = jsonlPath(resolve(home), agent, sessionId)
  await writeJsonl(filePath, records, options)
  return filePath
}

export async function writeClaudeFixture(
  home: string,
  options: { titleRecords?: boolean } = {}
): Promise<{ filePath: string }> {
  const sessionId = options.titleRecords ? 'claude-title-session' : 'claude-fixture-session'
  const timestamp = options.titleRecords ? '2026-10-01T00:00:00.000Z' : '2026-05-01T10:00:00.000Z'
  const records: unknown[] = [
    {
      type: 'user',
      message: { role: 'user', content: options.titleRecords ? 'A concrete first request' : `Claude fixture title ${fixtureMarker('claude')}` },
      timestamp,
      cwd: '/tmp/claude'
    },
    {
      type: 'assistant',
      sessionId,
      timestamp: options.titleRecords ? '2026-10-01T00:00:01.000Z' : '2026-05-01T10:00:01.000Z',
      message: {
        id: 'claude-assistant-message',
        type: 'message',
        role: 'assistant',
        model: 'claude-test-model',
        content: [{ type: 'text', text: 'A concrete response' }]
      }
    }
  ]
  if (options.titleRecords) {
    records.push(
      {
        type: 'ai-title',
        sessionId,
        timestamp: '2026-10-01T00:00:02.000Z',
        aiTitle: 'Generated title that must lose'
      },
      {
        type: 'custom-title',
        sessionId,
        timestamp: '2026-10-01T00:00:03.000Z',
        customTitle: 'User custom title'
      }
    )
  } else {
    records.push({
      type: 'ai-title',
      sessionId,
      timestamp: '2026-05-01T10:00:02.000Z',
      aiTitle: 'Claude fixture title'
    })
  }
  const filePath = await writeJsonlFixture(home, 'claude', sessionId, records)
  return { filePath }
}

export async function writeCursorFixture(home: string): Promise<CursorFixture> {
  const sessionId = 'cursor-fixture-session'
  const root = resolve(home)
  const cwd = '/tmp/cursor-fixture'
  const workspaceHash = createHash('md5').update(cwd).digest('hex')
  const transcript = jsonlPath(root, 'cursor', sessionId)
  const metadata = join(root, '.cursor', 'chats', workspaceHash, sessionId, 'meta.json')
  await writeJsonl(transcript, [
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }
  ])
  await writeJson(metadata, {
    schemaVersion: 1,
    createdAtMs: CURSOR_CREATED_AT_MS,
    updatedAtMs: CURSOR_UPDATED_AT_MS,
    cwd,
    hasConversation: true,
    title: 'Cursor sidecar title'
  })
  return { transcript, metadata, sessionId, files: { transcript, metadata } }
}

async function writeOpenCodeV1Database(path: string, sessionId: string, title: string, cwd: string, markerText: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const db = new Database(path)
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
        directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
        summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
        summary_diffs TEXT, revert TEXT, permission TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER,
        time_archived INTEGER, workspace_id TEXT, path TEXT, agent TEXT, model TEXT,
        cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL,
        tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
        tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
        metadata TEXT
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE project (
        id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT,
        icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
        time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT, icon_url_override TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
    `)
    db.query(`
      INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
      VALUES ('proj-1', ?, 'fixture', ?, ?, '[]')
    `).run(cwd, SQLITE_EPOCH_MS, SQLITE_EPOCH_MS)
    db.query(`
      INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
        time_created, time_updated, agent, model, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write)
      VALUES (?, 'proj-1', NULL, 'fixture-slug', ?, ?, '1.0.0', ?, ?, 'build',
        '{"id":"glm"}', 0, 1, 1, 0, 0, 0)
    `).run(sessionId, cwd, title, SQLITE_EPOCH_MS, SQLITE_EPOCH_MS + 120_000)

    const turns = [
      { role: 'user', text: `${title} prompt ${markerText}` },
      { role: 'assistant', text: `${title} answer` }
    ] as const
    for (const [index, turn] of turns.entries()) {
      const at = SQLITE_EPOCH_MS + (index + 1) * 60_000
      const messageId = `${sessionId}-msg-${index}`
      db.query(`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?)
      `).run(messageId, sessionId, at, at, JSON.stringify({ role: turn.role, time: { created: at } }))
      db.query(`
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        `${messageId}-part-0`,
        messageId,
        sessionId,
        at,
        at,
        JSON.stringify({ type: 'text', text: turn.text })
      )
    }
  } finally {
    db.close()
  }
}

async function writeOpenCode2Database(path: string, sessionId: string, title: string, cwd: string, markerText: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const db = new Database(path)
  try {
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
        directory TEXT NOT NULL, title TEXT, version TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
    `)
    db.query(`
      INSERT INTO session_v2
        (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, 'proj-1', NULL, 'fixture-slug', ?, ?, '0.0.0-next-1', ?, ?)
    `).run(sessionId, cwd, title, SQLITE_EPOCH_MS, SQLITE_EPOCH_MS + 120_000)
    for (const [index, role] of ['user', 'assistant'].entries()) {
      const at = SQLITE_EPOCH_MS + (index + 1) * 60_000
      const id = `${sessionId}-message-${index}`
      const text = index === 0 ? `${title} prompt ${markerText}` : `${title} answer`
      db.query(`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, role, index + 1, at, at, JSON.stringify({ id, type: role, text, time: { created: at } }))
    }
  } finally {
    db.close()
  }
}

export async function writeEveryAgentFixture(home: string): Promise<EveryAgentFixture> {
  home = resolve(home)
  const { filePath: claudePath } = await writeClaudeFixture(home)
  await writeJsonl(join(home, '.codebuddy', 'projects', 'project', 'codebuddy-session.jsonl'), [
    {
      id: 'codebuddy-msg-1',
      timestamp: 1_777_634_430_000,
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `CodeBuddy title ${fixtureMarker('codebuddy')}` }],
      sessionId: 'codebuddy-session',
      cwd: '/tmp/codebuddy'
    }
  ])
  await writeJsonl(join(home, '.qoder', 'projects', 'project', 'qoder-session.jsonl'), [
    { type: 'workspace-directories', sessionId: 'qoder-session', directories: ['/tmp/qoder'] },
    {
      type: 'user',
      sessionId: 'qoder-session',
      timestamp: '2026-05-01T10:00:00.000Z',
      message: { role: 'user', content: `Qoder title ${fixtureMarker('qoder')}` }
    }
  ])
  await writeJsonl(join(home, '.codex', 'sessions', '2026', '05', '01', 'rollout-codex-session.jsonl'), [
    {
      timestamp: '2026-05-01T10:01:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-session', cwd: '/tmp/codex' }
    },
    {
      timestamp: '2026-05-01T10:01:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: `Codex title ${fixtureMarker('codex')}` }]
      }
    }
  ])
  await writeJsonl(join(home, '.codex', 'session_index.jsonl'), [
    { id: 'codex-session', thread_name: 'Codex fixture indexed title' }
  ])
  await writeJson(join(home, '.hermes', 'sessions', 'session_hermes-session.json'), {
    session_id: 'hermes-session',
    model: 'hermes-1',
    cwd: '/tmp/hermes',
    session_start: '2026-05-01T10:05:00.000Z',
    last_updated: '2026-05-01T10:05:01.000Z',
    messages: [{ role: 'user', content: `Hermes title ${fixtureMarker('hermes')}` }]
  })
  await writeJsonl(join(home, '.pi', 'agent', 'sessions', 'pi-session.jsonl'), [
    { type: 'session', id: 'pi-session', timestamp: '2026-05-01T10:08:00.000Z', cwd: '/tmp/pi' },
    {
      type: 'message',
      timestamp: '2026-05-01T10:08:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: `Pi title ${fixtureMarker('pi')}` }] }
    }
  ])
  await writeJsonl(join(home, '.omp', 'agent', 'sessions', 'omp-session.jsonl'), [
    {
      type: 'session',
      version: 3,
      id: 'omp-session',
      title: 'OMP session title',
      timestamp: '2026-05-01T10:08:30.000Z',
      cwd: '/tmp/omp'
    },
    { type: 'model_change', model: 'gpt-5.4-mini', timestamp: '2026-05-01T10:08:30.500Z' },
    {
      type: 'message',
      timestamp: '2026-05-01T10:08:31.000Z',
      message: { role: 'user', content: [{ type: 'text', text: `OMP title ${fixtureMarker('omp')}` }] }
    },
    {
      type: 'message',
      timestamp: '2026-05-01T10:08:32.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'OMP answer' }],
        model: 'gpt-5.4-mini',
        usage: { input: 10, output: 5, totalTokens: 160 }
      }
    }
  ])
  await writeJsonl(join(home, '.prime', 'agent', 'sessions', 'prime-agent-session.jsonl'), [
    {
      type: 'session',
      version: 3,
      id: 'prime-agent-session',
      timestamp: '2026-05-01T10:08:40.000Z',
      cwd: '/tmp/prime-agent'
    },
    {
      type: 'model_change',
      provider: 'prime-intellect',
      modelId: 'inference/big-model',
      timestamp: '2026-05-01T10:08:40.500Z'
    },
    {
      type: 'message',
      timestamp: '2026-05-01T10:08:41.000Z',
      message: { role: 'user', content: [{ type: 'text', text: `Prime Agent title ${fixtureMarker('prime-agent')}` }] }
    }
  ])
  const cursor = await writeCursorFixture(home)
  await writeJson(join(home, '.gemini', 'tmp', 'gemini-session.json'), {
    sessionId: 'gemini-session',
    startTime: '2026-05-01T10:02:00.000Z',
    lastUpdated: '2026-05-01T10:02:01.000Z',
    messages: [
      { type: 'user', timestamp: '2026-05-01T10:02:00.000Z', content: [{ text: `Gemini title ${fixtureMarker('gemini')}` }] },
      { type: 'gemini', timestamp: '2026-05-01T10:02:01.000Z', model: 'gemini-2.5-pro', tokens: { input: 10, output: 5 } }
    ]
  })
  await writeJsonl(join(home, '.gemini', 'antigravity-cli', 'brain', ANTIGRAVITY_SESSION_ID, '.system_generated', 'logs', 'transcript.jsonl'), [
    {
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-05-01T10:02:30.000Z',
      content: `<USER_REQUEST>Antigravity title ${fixtureMarker('antigravity')}</USER_REQUEST>`
    },
    { source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-05-01T10:02:31.000Z', content: 'Done' }
  ])
  await writeJsonl(join(home, '.gemini', 'antigravity-cli', 'history.jsonl'), [
    {
      conversationId: ANTIGRAVITY_SESSION_ID,
      display: `Antigravity title ${fixtureMarker('antigravity')}`,
      timestamp: Date.parse('2026-05-01T10:02:30.000Z') / 1000,
      workspace: '/tmp/antigravity'
    }
  ])
  await writeJson(join(home, '.rovodev', 'sessions', 'rovo-session', 'metadata.json'), {
    title: 'Rovo title',
    workspace_path: '/tmp/rovo'
  })
  await writeJson(join(home, '.rovodev', 'sessions', 'rovo-session', 'session_context.json'), {
    message_history: [
      {
        kind: 'request',
        timestamp: '2026-05-01T10:06:00.000Z',
        parts: [{ part_kind: 'user-prompt', content: `Rovo title ${fixtureMarker('rovo')}` }]
      }
    ]
  })
  await writeJsonl(join(home, '.copilot', 'session-state', 'copilot-session.jsonl'), [
    {
      type: 'session.start',
      data: { sessionId: 'copilot-session', startTime: '2026-05-01T10:03:00.000Z' },
      timestamp: '2026-05-01T10:03:00.000Z'
    },
    {
      type: 'session.info',
      data: { infoType: 'folder_trust', message: 'Folder /tmp/copilot has been added to trusted folders.' },
      timestamp: '2026-05-01T10:03:01.000Z'
    },
    { type: 'user.message', data: { transformedContent: `Copilot title ${fixtureMarker('copilot')}` }, timestamp: '2026-05-01T10:03:02.000Z' }
  ])

  const opencodeDir = join(home, '.local', 'share', 'opencode')
  await writeOpenCodeV1Database(join(opencodeDir, 'opencode.db'), 'opencode-fixture-session', 'OpenCode fixture title', '/tmp/opencode', fixtureMarker('opencode'))
  await writeOpenCode2Database(join(opencodeDir, 'opencode-next.db'), 'opencode2-fixture-session', 'OpenCode 2 fixture title', '/tmp/opencode2', fixtureMarker('opencode2'))
  await writeOpenCodeV1Database(join(home, '.zcode', 'cli', 'db', 'db.sqlite'), 'zcode-fixture-session', 'ZCode fixture title', '/tmp/zcode', fixtureMarker('zcode'))

  const grokDir = join(home, '.grok', 'sessions', encodeURIComponent('/tmp/grok'), 'grok-session')
  await writeJson(join(grokDir, 'summary.json'), {
    info: { id: 'grok-session', cwd: '/tmp/grok' },
    session_summary: '',
    created_at: '2026-05-01T10:04:00.000Z',
    updated_at: '2026-05-01T10:04:01.000Z',
    num_chat_messages: 2,
    current_model_id: 'grok-build',
    head_branch: 'feature/grok-vault'
  })
  await writeJsonl(join(grokDir, 'chat_history.jsonl'), [
    { type: 'user', content: [{ type: 'text', text: `<user_info>context</user_info><user_query>Grok title ${fixtureMarker('grok')}</user_query>` }] },
    { type: 'assistant', content: 'Done' }
  ])
  await writeJsonl(join(home, '.openclaw', 'agents', 'default', 'sessions', 'openclaw-session.jsonl'), [
    { type: 'session', id: 'openclaw-session', timestamp: '2026-05-01T10:07:00.000Z', cwd: '/tmp/openclaw' },
    {
      type: 'message',
      timestamp: '2026-05-01T10:07:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: `OpenClaw title ${fixtureMarker('openclaw')}` }] }
    }
  ])
  await writeJson(join(home, '.local', 'share', 'devin', 'cli', 'transcripts', 'devin-session.json'), {
    session_id: 'devin-session',
    working_directory: '/tmp/devin',
    agent: { model_name: 'swe-1-6-fast' },
    steps: [
      {
        metadata: {
          created_at: '2026-05-01T10:10:00.000Z',
          is_user_input: true,
          metrics: { input_tokens: 1, output_tokens: 2 }
        },
        text: `Devin vault title ${fixtureMarker('devin')}`
      }
    ]
  })
  await writeJsonl(join(home, '.factory', 'sessions', 'droid-session.jsonl'), [
    {
      type: 'system',
      session_id: 'droid-session',
      timestamp: '2026-05-01T10:09:00.000Z',
      model: 'droid-model',
      cwd: '/tmp/droid'
    },
    {
      type: 'message',
      session_id: 'droid-session',
      timestamp: '2026-05-01T10:09:01.000Z',
      role: 'user',
      text: `Droid title ${fixtureMarker('droid')}`
    },
    { type: 'completion', session_id: 'droid-session', timestamp: '2026-05-01T10:09:02.000Z', usage: { input_tokens: 2, output_tokens: 3 } }
  ])

  const clineDir = join(home, '.cline', 'data', 'sessions', 'cline-session')
  await writeJson(join(clineDir, 'cline-session.json'), {
    session_id: 'cline-session',
    started_at: '2026-05-01T10:10:30.000Z',
    model: 'cline-model',
    cwd: '/tmp/cline'
  })
  await writeJson(join(clineDir, 'cline-session.messages.json'), {
    updated_at: '2026-05-01T10:10:31.000Z',
    messages: [{ role: 'user', content: [{ type: 'text', text: `Cline vault title ${fixtureMarker('cline')}` }] }]
  })

  const kimiDir = join(home, '.kimi-code', 'sessions', 'wd_app_abc', 'session_kimi-session')
  await writeJson(join(kimiDir, 'state.json'), {
    createdAt: '2026-05-01T10:11:00.000Z',
    updatedAt: '2026-05-01T10:11:05.000Z',
    title: 'Kimi vault title',
    lastPrompt: 'Kimi vault title',
    agents: { main: { type: 'main', parentAgentId: null } }
  })
  await writeJsonl(join(home, '.kimi-code', 'sessions', 'session_index.jsonl'), [
    { sessionId: 'session_kimi-session', sessionDir: kimiDir, workDir: '/tmp/kimi' }
  ])
  await writeJsonl(join(kimiDir, 'agents', 'main', 'wire.jsonl'), [
    { type: 'config.update', modelAlias: 'kimi-k2.6', time: 1781853559132 },
    {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `Kimi vault title ${fixtureMarker('kimi')}` }],
        origin: { kind: 'user' }
      },
      time: 1781853559164
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'content.part', part: { type: 'text', text: 'Kimi reply' } },
      time: 1781853559177
    },
    { type: 'context.append_loop_event', event: { type: 'step.end' }, time: 1781853559178 },
    {
      type: 'usage.record',
      model: 'kimi-k2.6',
      usage: { inputOther: 4, output: 6, inputCacheRead: 0, inputCacheCreation: 0 },
      usageScope: 'turn',
      time: 1781853559178
    }
  ])
  await writeJsonl(join(home, '.local', 'share', 'muse', 'sessions', '2026', '05', '01', 'muse-session', 'session.jsonl'), [
    {
      record_type: 'event',
      payload_type: 'runtime.session.metadata',
      recorded_at: 1780000000000000,
      payload: { kind: 'metadata', record: { workspace_root: '/tmp/muse', provider_id: 'meta' } }
    },
    {
      record_type: 'event',
      payload_type: 'runtime.user_intent.accepted',
      recorded_at: 1780000001000000,
      payload: { intent_id: 'intent-1', refill_blocks: [{ kind: 'text', text: `Muse vault title ${fixtureMarker('muse')}` }] }
    },
    {
      record_type: 'event',
      payload_type: 'runtime.session',
      recorded_at: 1780000001000007,
      payload: { kind: 'run', run_id: 'run-1', event: { kind: 'started', prompt: `Muse vault title ${fixtureMarker('muse')}` } }
    },
    {
      retained_frame: true,
      frame_schema_version: 1,
      outer_log_ordinal: 3,
      transaction_id: 'txn-1',
      children: [
        {
          child_index: 0,
          record_json: JSON.stringify({
            record_type: 'event',
            payload_type: 'runtime.session',
            recorded_at: 1780000002000000,
            payload: { kind: 'run', run_id: 'run-1', event: { kind: 'assistant_message_committed', text: 'Muse answer' } }
          })
        }
      ]
    },
    {
      record_type: 'event',
      payload_type: 'runtime.session',
      recorded_at: 1780000003000000,
      payload: {
        kind: 'run',
        run_id: 'run-1',
        event: { kind: 'model_completed', model: 'muse-spark-test', usage: { input_tokens: 10, output_tokens: 5 } }
      }
    },
    { retained_marker: 'omitted_live_only', schema_version: 1, stream: { kind: 'session', id: 'muse-session' } }
  ])
  await writeJson(join(home, '.jcode', 'sessions', 'session_jcode-session.json'), {
    id: 'session_jcode-session',
    short_name: 'jcode-session',
    model: 'jcode-model',
    working_dir: '/tmp/jcode',
    created_at: '2026-05-01T10:12:00.000Z',
    updated_at: '2026-05-01T10:12:01.000Z',
    messages: [
      {
        id: 'm1',
        role: 'user',
        display_role: 'system',
        content: [{ type: 'text', text: '<system-reminder>injected</system-reminder>' }]
      },
      { id: 'm2', role: 'user', content: [{ type: 'text', text: `Jcode title ${fixtureMarker('jcode')}` }] }
    ]
  })

  await writeJson(join(home, '.kiro', 'sessions', 'cli', `${KIRO_SESSION_ID}.json`), {
    session_id: KIRO_SESSION_ID,
    cwd: '/tmp/kiro',
    created_at: '2026-05-01T10:13:00.000000000Z',
    updated_at: '2026-05-01T10:13:02.000000000Z',
    title: 'Kiro title',
    session_created_reason: 'subagent',
    session_state: { rts_model_state: { model_info: { model_id: 'kiro-model' } } }
  })
  await writeJsonl(join(home, '.kiro', 'sessions', 'cli', `${KIRO_SESSION_ID}.jsonl`), [
    {
      version: 'v1',
      kind: 'Prompt',
      data: { content: [{ kind: 'text', data: `Kiro title ${fixtureMarker('kiro')}` }], meta: { timestamp: 1777630381 } }
    },
    {
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'Kiro reply' }] }
    }
  ])

  const expected: EveryAgentFixture['expected'] & Record<HistoryAgent, ExpectedSession> = {
    claude: { sessionId: 'claude-fixture-session', title: 'Claude fixture title', cwd: '/tmp/claude' },
    codebuddy: { sessionId: 'codebuddy-session', title: `CodeBuddy title ${fixtureMarker('codebuddy')}`, cwd: '/tmp/codebuddy' },
    qoder: { sessionId: 'qoder-session', title: `Qoder title ${fixtureMarker('qoder')}`, cwd: '/tmp/qoder' },
    codex: { sessionId: 'codex-session', title: 'Codex fixture indexed title', cwd: '/tmp/codex' },
    hermes: { sessionId: 'hermes-session', title: `Hermes title ${fixtureMarker('hermes')}`, cwd: '/tmp/hermes' },
    pi: { sessionId: 'pi-session', title: `Pi title ${fixtureMarker('pi')}`, cwd: '/tmp/pi' },
    omp: { sessionId: 'omp-session', title: 'OMP session title', cwd: '/tmp/omp' },
    'prime-agent': { sessionId: 'prime-agent-session', title: `Prime Agent title ${fixtureMarker('prime-agent')}`, cwd: '/tmp/prime-agent' },
    cursor: { sessionId: cursor.sessionId, title: 'Cursor sidecar title', cwd: '/tmp/cursor-fixture' },
    gemini: { sessionId: 'gemini-session', title: `Gemini title ${fixtureMarker('gemini')}`, cwd: null },
    antigravity: { sessionId: ANTIGRAVITY_SESSION_ID, title: `Antigravity title ${fixtureMarker('antigravity')}`, cwd: '/tmp/antigravity' },
    rovo: { sessionId: 'rovo-session', title: 'Rovo title', cwd: '/tmp/rovo' },
    copilot: { sessionId: 'copilot-session', title: `Copilot title ${fixtureMarker('copilot')}`, cwd: '/tmp/copilot' },
    opencode: { sessionId: 'opencode-fixture-session', title: 'OpenCode fixture title', cwd: '/tmp/opencode' },
    opencode2: { sessionId: 'opencode2-fixture-session', title: 'OpenCode 2 fixture title', cwd: '/tmp/opencode2' },
    zcode: { sessionId: 'zcode-fixture-session', title: 'ZCode fixture title', cwd: '/tmp/zcode' },
    grok: { sessionId: 'grok-session', title: `Grok title ${fixtureMarker('grok')}`, cwd: '/tmp/grok' },
    openclaw: { sessionId: 'openclaw-session', title: `OpenClaw title ${fixtureMarker('openclaw')}`, cwd: '/tmp/openclaw' },
    devin: { sessionId: 'devin-session', title: `Devin vault title ${fixtureMarker('devin')}`, cwd: '/tmp/devin' },
    droid: { sessionId: 'droid-session', title: `Droid title ${fixtureMarker('droid')}`, cwd: '/tmp/droid' },
    cline: { sessionId: 'cline-session', title: `Cline vault title ${fixtureMarker('cline')}`, cwd: '/tmp/cline' },
    kimi: { sessionId: 'session_kimi-session', title: 'Kimi vault title', cwd: '/tmp/kimi' },
    muse: { sessionId: 'muse-session', title: `Muse vault title ${fixtureMarker('muse')}`, cwd: '/tmp/muse' },
    jcode: { sessionId: 'session_jcode-session', title: `Jcode title ${fixtureMarker('jcode')}`, cwd: '/tmp/jcode' },
    kiro: { sessionId: KIRO_SESSION_ID, title: 'Kiro title', cwd: '/tmp/kiro' }
  }
  return { expected, paths: { claude: claudePath } }
}

export async function writeOpenCodeLegacyFixture(home: string): Promise<{ filePath: string; sessionId: string }> {
  const sessionId = 'legacy-opencode-session'
  const storage = join(resolve(home), '.local', 'share', 'opencode', 'storage')
  const filePath = join(storage, 'session', 'legacy-project', `${sessionId}.json`)
  const messageDir = join(storage, 'message', sessionId)
  const created = Date.parse('2026-10-01T00:00:00.000Z')
  await writeJson(filePath, {
    id: sessionId,
    title: 'Legacy OpenCode title',
    directory: '/tmp/opencode-legacy',
    time: { created, updated: created + 2_000 }
  })
  await writeJson(join(messageDir, '002-assistant.json'), {
    id: 'legacy-assistant',
    role: 'assistant',
    time: { created: created + 1_000 },
    content: [{ type: 'text', text: 'Legacy assistant answer' }],
    model: { modelID: 'legacy-model' },
    tokens: { input: 4, output: 7, total: 11 }
  })
  await writeJson(join(messageDir, '001-user.json'), {
    id: 'legacy-user',
    role: 'user',
    time: { created },
    content: [{ type: 'text', text: 'Legacy first prompt' }]
  })
  return { filePath, sessionId }
}

export async function writeScopeFixture(
  home: string,
  outsideCount: number
): Promise<{ worktreeSessionId: string }> {
  home = resolve(home)
  const worktreeSessionId = 'worktree-session'
  const base = Date.UTC(2026, 9, 1, 10, 0, 0)
  await writeJsonlFixture(home, 'claude', worktreeSessionId, [
    {
      type: 'user',
      sessionId: worktreeSessionId,
      timestamp: new Date(base).toISOString(),
      cwd: '/tmp/vault-worktree',
      message: { role: 'user', content: `Worktree target session ${fixtureMarker('claude')}` }
    },
    {
      type: 'assistant',
      timestamp: new Date(base + 1_000).toISOString(),
      message: { role: 'assistant', content: 'Target response' }
    }
  ])
  for (let index = 0; index < outsideCount; index++) {
    const sessionId = `outside-session-${index}`
    const timestamp = new Date(base + (index + 2) * 1_000).toISOString()
    await writeJsonlFixture(home, 'claude', sessionId, [
      {
        type: 'user',
        sessionId,
        timestamp,
        cwd: `/tmp/vault-outside-${index}`,
        message: { role: 'user', content: `Outside session ${index} ${fixtureMarker('claude')}` }
      },
      {
        type: 'assistant',
        timestamp: new Date(base + (index + 2) * 1_000 + 1).toISOString(),
        message: { role: 'assistant', content: 'Outside response' }
      }
    ])
  }
  await writeJsonl(join(home, '.claude', 'projects', 'project', worktreeSessionId, 'subagents', 'agent-scope.jsonl'), [
    {
      type: 'user',
      sessionId: worktreeSessionId,
      timestamp: new Date(base + 2_000).toISOString(),
      cwd: '/tmp/vault-worktree',
      message: { role: 'user', content: 'Subagent task' }
    },
    {
      type: 'assistant',
      timestamp: new Date(base + 3_000).toISOString(),
      message: { role: 'assistant', content: 'Subagent response' }
    }
  ])
  return { worktreeSessionId }
}
