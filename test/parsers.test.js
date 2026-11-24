import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { normalizeCodexRecord } from '../src/host/adapters/codex.js'
import { normalizeClaudeRecord } from '../src/host/adapters/claude.js'
import { deriveTaskStatus } from '../src/host/status.js'
import { redact, summarize, parseTime } from '../src/host/util/text.js'
import { TailReader } from '../src/host/util/tail.js'

test('codex: session_meta carries id, cwd, and a session event', () => {
  const record = {
    type: 'session_meta',
    timestamp: '2026-11-05T02:32:50.176Z',
    payload: { id: 'abc', cwd: '/tmp/repo', model_provider: 'openai' },
  }
  const out = normalizeCodexRecord(record)
  assert.equal(out.sessionId, 'abc')
  assert.equal(out.cwd, '/tmp/repo')
  assert.equal(out.model, 'openai')
  assert.equal(out.event.kind, 'session.meta')
  assert.ok(out.at > 0)
})

test('codex: task_started opens a turn, task_complete closes it', () => {
  const started = normalizeCodexRecord({ type: 'event_msg', timestamp: '2026-11-05T02:33:00Z', payload: { type: 'task_started' } })
  assert.equal(started.open, true)
  assert.equal(started.event.kind, 'run.started')
  const done = normalizeCodexRecord({ type: 'event_msg', timestamp: '2026-11-05T02:34:00Z', payload: { type: 'task_complete' } })
  assert.equal(done.open, false)
  assert.equal(done.event.kind, 'run.idle')
})

test('codex: a tool call is a tool event and keeps the turn open', () => {
  const out = normalizeCodexRecord({
    type: 'response_item',
    timestamp: '2026-11-05T02:33:30Z',
    payload: { type: 'function_call', name: 'shell', arguments: '{"command":"pnpm test"}' },
  })
  assert.equal(out.event.kind, 'run.tool')
  assert.match(out.event.summary, /pnpm test/)
  assert.equal(out.open, true)
})

test('codex: turn_aborted marks an error', () => {
  const out = normalizeCodexRecord({ type: 'event_msg', timestamp: '2026-11-05T02:35:00Z', payload: { type: 'turn_aborted' } })
  assert.equal(out.error, true)
  assert.equal(out.event.severity, 'warn')
})

test('claude: a plain user message opens a turn and seeds the title', () => {
  const out = normalizeClaudeRecord({
    type: 'user',
    timestamp: '2026-11-18T06:17:54.314Z',
    sessionId: 's1',
    cwd: '/tmp/repo',
    message: { role: 'user', content: 'review the diff' },
  })
  assert.equal(out.open, true)
  assert.equal(out.prompt, 'review the diff')
  assert.equal(out.event.kind, 'run.turn')
})

test('claude: assistant tool_use keeps the turn open, text closes it', () => {
  const tool = normalizeClaudeRecord({
    type: 'assistant',
    timestamp: '2026-11-18T06:18:00Z',
    message: { model: 'claude-sonnet', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
  })
  assert.equal(tool.open, true)
  assert.equal(tool.event.kind, 'run.tool')
  assert.equal(tool.model, 'claude-sonnet')
  const text = normalizeClaudeRecord({
    type: 'assistant',
    timestamp: '2026-11-18T06:19:00Z',
    message: { content: [{ type: 'text', text: 'done' }] },
  })
  assert.equal(text.open, false)
  assert.equal(text.event.kind, 'run.message')
})

test('claude: tool_result user records are tool events, not new prompts', () => {
  const out = normalizeClaudeRecord({
    type: 'user',
    timestamp: '2026-11-18T06:18:30Z',
    message: { content: [{ type: 'tool_result', content: 'ok' }] },
  })
  assert.equal(out.event.kind, 'run.tool')
  assert.equal(out.open, undefined)
})

test('status: open + recent is running; open + silent is attention', () => {
  const now = Date.now()
  assert.equal(deriveTaskStatus({ lastActivityMs: now - 5_000, open: true }).status, 'running')
  assert.equal(deriveTaskStatus({ lastActivityMs: now - 20 * 60_000, open: true }).status, 'attention')
  assert.equal(deriveTaskStatus({ lastActivityMs: now - 5_000, open: false }).status, 'running')
  assert.equal(deriveTaskStatus({ lastActivityMs: now - 8 * 60 * 60_000, open: false }).status, 'done')
})

test('redaction removes recognizable credentials', () => {
  const text = redact('token sk-abcdefghijklmnop12345 and ghp_abcdefghijklmnopqrstuvwxyz012345')
  assert.doesNotMatch(text, /sk-abcdefghijklmnop/)
  assert.doesNotMatch(text, /ghp_abcdefghijklmnop/)
  assert.equal(summarize('a\n\nb', 10), 'a b')
})

test('parseTime accepts ISO, seconds, and milliseconds', () => {
  assert.equal(parseTime('2026-11-05T02:33:00Z'), Date.parse('2026-11-05T02:33:00Z'))
  assert.equal(parseTime(1762309980), 1762309980000)
  assert.equal(parseTime(1762309980000), 1762309980000)
  assert.equal(parseTime(''), 0)
})

test('TailReader reads the tail first, then only appended lines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-board-'))
  const file = path.join(dir, 'rollout.jsonl')
  await fs.writeFile(file, '{"n":1}\n{"n":2}\n', 'utf8')
  const reader = new TailReader()
  const first = await reader.read(file, { initialBytes: 1024 })
  assert.deepEqual(first.lines, ['{"n":1}', '{"n":2}'])
  await fs.appendFile(file, '{"n":3}\n', 'utf8')
  const second = await reader.read(file, { initialBytes: 1024 })
  assert.deepEqual(second.lines, ['{"n":3}'])
  const third = await reader.read(file, { initialBytes: 1024 })
  assert.deepEqual(third.lines, [])
  await fs.rm(dir, { recursive: true, force: true })
})
