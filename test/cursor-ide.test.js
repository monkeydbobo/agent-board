import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { messagesFromHeaders, readCursorIdeChats } from '../src/host/adapters/cursor-ide.js'

test('cursor ide: headers keep only text bubbles and their order', () => {
  const headers = [
    { bubbleId: 'u1', type: 1, grouping: { hasText: true }, createdAt: '2026-11-24T03:58:00.000Z' },
    { bubbleId: 'r1', type: 2, grouping: { hasThinking: true }, createdAt: '2026-11-24T03:58:01.000Z' },
    { bubbleId: 'a1/s:1', type: 2, grouping: { hasText: true }, createdAt: '2026-11-24T03:58:02.000Z' },
  ]
  const bubbles = new Map([
    ['u1', { text: 'fix the login' }],
    ['r1', { text: 'reasoning should be skipped' }],
    ['a1/s:1', { text: 'patched the handler' }],
  ])
  const messages = messagesFromHeaders(headers, bubbles, Date.UTC(2026, 10, 24, 4))
  assert.equal(messages.length, 2)
  assert.match(messages[0].summary, /fix the login/)
  assert.match(messages[1].summary, /patched the handler/)
})

test('cursor ide: reader reconstructs composers and bubbles', async () => {
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-ide-'))
  const dbPath = path.join(dir, 'state.vscdb')
  const composerId = '11111111-2222-3333-4444-555555555555'
  const db = new sqlite.DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, value TEXT)')
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)')
    db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, 0, 0, ?)').run(
      composerId,
      'ws-1',
      Date.UTC(2026, 10, 24, 3, 0),
      Date.UTC(2026, 10, 24, 4, 0),
      JSON.stringify({ name: 'IDE chat', unifiedMode: 'agent' }),
    )
    const put = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
    put.run(`composerData:${composerId}`, JSON.stringify({
      name: 'IDE chat',
      status: 'completed',
      modelConfig: { modelName: 'grok-4.7' },
      workspaceIdentifier: { fsPath: '/tmp/ide-project' },
      contextUsagePercent: 12.5,
    }))
    put.run(`composerConvHeaders:${composerId}:000000`, JSON.stringify([
      { bubbleId: 'u1', type: 1, grouping: { hasText: true }, createdAt: '2026-11-24T03:58:00.000Z' },
      { bubbleId: 'a1/s:1', type: 2, grouping: { hasText: true }, createdAt: '2026-11-24T03:58:02.000Z' },
    ]))
    put.run(`bubbleId:${composerId}:u1`, JSON.stringify({ text: 'fix the login', type: 1 }))
    put.run(`bubbleId:${composerId}:a1/s:1`, JSON.stringify({ text: 'patched the handler', type: 2 }))
  } finally {
    db.close()
  }

  const chats = await readCursorIdeChats(dbPath, { limit: 5 })
  assert.equal(chats.length, 1)
  assert.equal(chats[0].title, 'IDE chat')
  assert.equal(chats[0].workspace, '/tmp/ide-project')
  assert.equal(chats[0].model, 'grok-4.7')
  assert.equal(chats[0].messages.length, 2)
  assert.match(chats[0].messages[0].summary, /fix the login/)
  assert.match(chats[0].messages[1].summary, /patched the handler/)

  await fs.rm(dir, { recursive: true, force: true })
})
