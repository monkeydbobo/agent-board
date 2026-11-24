import test from 'node:test'
import assert from 'node:assert/strict'

import {
  encodeProjectPath,
  localagentTitle,
  normalizeLocalAgentRecord,
} from '../src/host/adapters/localagent.js'

test('localagent: project path encoding matches the on-disk directory', () => {
  assert.equal(
    encodeProjectPath('/Users/alice/.localagent/internal/skills/example-skill'),
    'users-alice-localagent-internal-skills-example-skill',
  )
  assert.equal(
    encodeProjectPath('/Users/alice/projects/example-repo'),
    'users-alice-projects-example-repo',
  )
})

test('localagent: title strips prompt boilerplate and reminder blocks', () => {
  assert.equal(localagentTitle('用户要求：fix the login'), 'fix the login')
  assert.equal(
    localagentTitle('<system-reminder>internal note</system-reminder>\n请检查 API'),
    '请检查 API',
  )
  assert.equal(localagentTitle('<system-reminder>only a reminder</system-reminder>'), '')
})

test('localagent: a user turn opens the session', () => {
  const result = normalizeLocalAgentRecord({
    type: 'message',
    role: 'user',
    timestamp: '2026-11-24T06:58:13.736Z',
    content: '用户要求：查询最近的数据',
  })
  assert.equal(result.open, true)
  assert.match(result.events[0].summary, /查询最近的数据/)
  assert.ok(result.at > 0)
})

test('localagent: assistant text closes, tool_use keeps it open', () => {
  const text = normalizeLocalAgentRecord({
    type: 'message',
    role: 'assistant',
    timestamp: '2026-11-24T06:58:17.620Z',
    model: 'wanqing/auto-1x',
    usage: { input_tokens: 100, output_tokens: 20 },
    content: [{ type: 'text', text: 'done' }],
  })
  assert.equal(text.open, false)
  assert.equal(text.model, 'wanqing/auto-1x')
  assert.equal(text.usage.input_tokens, 100)
  assert.equal(text.events[0].kind, 'run.message')

  const tool = normalizeLocalAgentRecord({
    type: 'message',
    role: 'assistant',
    timestamp: '2026-11-24T06:59:00.000Z',
    content: [{ type: 'tool_use', name: 'bash', input: { command: 'ls -la' } }],
  })
  assert.equal(tool.open, true)
  assert.match(tool.events[0].summary, /bash: ls -la/)
})

test('localagent: tool results detect errors', () => {
  const result = normalizeLocalAgentRecord({
    type: 'message',
    role: 'tool',
    timestamp: '2026-11-24T06:59:01.000Z',
    content: [{
      type: 'tool-result',
      toolName: 'bash',
      result: { llmContent: 'Exit code: 1\ncommand failed' },
    }],
  })
  assert.equal(result.events[0].severity, 'warn')
  assert.match(result.events[0].summary, /bash finished with errors/)
})

test('localagent: turn duration closes the turn', () => {
  const result = normalizeLocalAgentRecord({
    type: 'message',
    role: 'synthetic',
    timestamp: '2026-11-24T07:08:05.785Z',
    metadata: { type: 'turn_duration', durationMs: 90000 },
    content: '__turn_duration__:90000',
  })
  assert.equal(result.open, false)
  assert.equal(result.events[0].kind, 'run.idle')
  assert.match(result.events[0].summary, /1m 30s/)
})
