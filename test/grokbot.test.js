import test from 'node:test'
import assert from 'node:assert/strict'

import { parseGrokConversation } from '../src/host/adapters/grokbot.js'

const agents = new Map([
  ['a1', { id: 'a1', name: 'example-agent · sample 仓库代理', description: 'repo /Users/me/projects/example-repo' }],
])

test('grok: conversation folds user, assistant, widget, and event entries', () => {
  const conversation = parseGrokConversation({
    entries: [
      { kind: 'message', role: 'user', content: 'fix the login', timestampMs: 1000 },
      {
        kind: 'send-message',
        message: { type: 'text', content: 'found the handler' },
        timestampMs: 2000,
        author: { id: 'a1', name: 'example-agent · sample 仓库代理' },
      },
      { kind: 'send-message', message: { type: 'widget', widget: { prompt: 'pick one' } }, timestampMs: 3000 },
      { kind: 'event', event: { type: 'automation-changed', action: 'created' }, timestampMs: 4000 },
    ],
  }, agents)

  assert.equal(conversation.title, 'fix the login')
  assert.equal(conversation.agentName, 'example-agent · sample 仓库代理')
  assert.equal(conversation.workspace, '/Users/me/projects/example-repo')
  assert.equal(conversation.open, false)
  assert.equal(conversation.users, 1)
  assert.equal(conversation.assistant, 1)
  assert.equal(conversation.widgets, 1)
  assert.equal(conversation.events.length, 4)
  assert.equal(conversation.events[0].kind, 'run.turn')
  assert.equal(conversation.events[1].kind, 'run.message')
  assert.equal(conversation.events[2].summary, 'assistant: pick one')
  assert.equal(conversation.events[3].kind, 'session.meta')
  assert.equal(conversation.lastAt, 4000)
})

test('grok: a trailing user message keeps the conversation open', () => {
  const conversation = parseGrokConversation({
    entries: [
      { kind: 'send-message', message: { type: 'text', content: 'hello' }, timestampMs: 1000 },
      { kind: 'message', role: 'user', content: 'are you there?', timestampMs: 2000 },
    ],
  }, agents)
  assert.equal(conversation.open, true)
  assert.equal(conversation.title, 'are you there?')
  assert.equal(conversation.events[1].kind, 'run.turn')
})

test('grok: agent-only conversations use the agent name as the title', () => {
  const conversation = parseGrokConversation({
    entries: [
      { kind: 'send-message', message: { type: 'text', content: 'I am your repo agent' }, timestampMs: 1000, author: { id: 'a1' } },
    ],
  }, agents)
  assert.equal(conversation.title, 'example-agent · sample 仓库代理')
  assert.equal(conversation.agentName, 'example-agent · sample 仓库代理')
})
