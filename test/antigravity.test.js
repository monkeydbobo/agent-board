import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { normalizeTrajectories, readAntigravityState } from '../src/host/adapters/antigravity-state.js'

test('antigravity: trajectory arrays and maps normalize to rows', () => {
  assert.deepEqual(
    normalizeTrajectories([{ id: 't1', title: 'Fix login', updatedAt: 1000 }]),
    [{ id: 't1', title: 'Fix login', updatedAt: 1000 }],
  )
  assert.deepEqual(
    normalizeTrajectories({ t2: { title: 'Review diff', timestampMs: 2000 } }),
    [{ id: 't2', title: 'Review diff', updatedAt: 2000 }],
  )
  assert.deepEqual(normalizeTrajectories(''), [])
})

test('antigravity: reader returns version and persisted trajectory summaries', async () => {
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-'))
  const dbPath = path.join(dir, 'state.vscdb')
  const db = new sqlite.DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    const put = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    put.run('antigravityChangelog/lastVersion', '2.8.0')
    put.run('antigravityUnifiedStateSync.trajectorySummaries', JSON.stringify([
      { id: 'tr-1', title: 'Fix login', updatedAt: Date.UTC(2026, 10, 24, 3) },
    ]))
  } finally {
    db.close()
  }

  const state = await readAntigravityState(dbPath)
  assert.equal(state.version, '2.8.0')
  assert.equal(state.trajectories.length, 1)
  assert.equal(state.trajectories[0].title, 'Fix login')

  await fs.rm(dir, { recursive: true, force: true })
})
