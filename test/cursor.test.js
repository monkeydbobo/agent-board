import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  decodeCursorMeta,
  extractCursorQuery,
  parseCursorRootIds,
  parseCursorTimestamp,
  readCursorChat,
} from '../src/host/adapters/cursor-db.js'

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex')

test('cursor: meta is hex-encoded JSON', () => {
  const value = Buffer.from(JSON.stringify({ name: 'Fix login', latestRootBlobId: 'abc' })).toString('hex')
  assert.equal(decodeCursorMeta(value).name, 'Fix login')
  assert.equal(decodeCursorMeta(JSON.stringify({ name: 'plain' })).name, 'plain')
  assert.equal(decodeCursorMeta('not json'), undefined)
})

test('cursor: root protobuf yields ordered 32-byte ids', () => {
  const ids = [sha('a'), sha('b'), sha('c')]
  const root = Buffer.concat(ids.map((id) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(id, 'hex')])))
  assert.deepEqual(parseCursorRootIds(root), ids)
})

test('cursor: timestamp carries the UTC offset', () => {
  const value = parseCursorTimestamp('<timestamp>Tuesday, Nov 24, 2026, 11:58 AM (UTC+8)</timestamp>')
  assert.equal(value, Date.UTC(2026, 10, 24, 3, 58))
})

test('cursor: user query strips the environment preamble', () => {
  const text = '<user_info>\nWorkspace Path: /tmp/p\n</user_info><user_query>fix it</user_query>'
  assert.equal(extractCursorQuery(text), 'fix it')
  assert.equal(extractCursorQuery('<user_info>only env</user_info>'), '')
})

test('cursor: reader reconstructs a chat store', async () => {
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-chat-'))
  const dbPath = path.join(dir, 'store.db')
  const db = new sqlite.DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
    const put = (value) => {
      const data = Buffer.from(JSON.stringify(value))
      const id = sha(data)
      insert.run(id, data)
      return id
    }
    const user = put({
      role: 'user',
      content: '<user_info>\nWorkspace Path: /tmp/proj\n</user_info>\n'
        + '<timestamp>Tuesday, Nov 24, 2026, 11:58 AM (UTC+8)</timestamp>\n'
        + '<user_query>fix the login</user_query>',
    })
    const assistant = put({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '' },
        { type: 'text', text: 'Done: patched the handler.' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'Shell', args: { command: 'pnpm test' } },
      ],
    })
    const tool = put({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Shell', result: 'Exit code: 0\nok' }],
    })
    const rootData = Buffer.concat([user, assistant, tool].map((id) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(id, 'hex')])))
    const rootId = sha(rootData)
    insert.run(rootId, rootData)
    insert.run('meta', Buffer.from('not a blob'))
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify({
      agentId: 'a',
      latestRootBlobId: rootId,
      name: 'Fix login',
      createdAt: Date.UTC(2026, 10, 24, 3, 0),
      lastUsedModel: 'grok-4.7',
    })).toString('hex'))
  } finally {
    db.close()
  }

  const chat = await readCursorChat(dbPath)
  assert.equal(chat.title, 'Fix login')
  assert.equal(chat.workspace, '/tmp/proj')
  assert.equal(chat.model, 'grok-4.7')
  assert.equal(chat.messageCount, 4)
  assert.match(chat.messages[0].summary, /fix the login/)
  assert.match(chat.messages[1].summary, /Done: patched the handler/)
  assert.match(chat.messages[2].summary, /pnpm test/)
  assert.match(chat.messages[3].summary, /Shell finished/)

  await fs.rm(dir, { recursive: true, force: true })
})
