/**
 * Cursor adapter (metadata level).
 *
 * The Cursor CLI keeps one SQLite database per chat under
 * `~/.cursor/chats/<workspace-hash>/<chat-id>/store.db`. The board does not open
 * that database in this version: the schema is undocumented and changes between
 * releases. It monitors chat presence, recency, and workspace grouping, and says
 * so in the provider note instead of pretending to know the transcript.
 */

import path from 'node:path'

import { expandHome, listDirs, readJsonSafe, statSafe } from '../util/fsx.js'
import { deriveTaskStatus, rollupProvider } from '../status.js'
import { iso } from '../util/text.js'
import { countProcesses, PROCESS_PATTERNS } from '../util/proc.js'

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export class CursorAdapter {
  constructor(config = {}) {
    this.id = 'cursor'
    this.label = 'Cursor'
    this.root = expandHome(config.root ?? '~/.cursor/chats')
    this.stateFile = expandHome('~/.cursor/agent-cli-state.json')
    this.note = 'Cursor chats are monitored at metadata level (store.db); transcripts are not parsed'
  }

  async poll({ config }) {
    const alive = await countProcesses(PROCESS_PATTERNS.cursor)
    const limit = Math.max(10, Number(config?.maxTasksPerProvider ?? 40))
    const workers = await readJsonSafe(this.stateFile)
    const workerCount = workers?.workerIdsByDisplayName ? Object.keys(workers.workerIdsByDisplayName).length : 0

    const workspaces = await listDirs(this.root, 60)
    const chats = []
    for (const workspace of workspaces) {
      const entries = await listDirs(workspace.path, 60)
      for (const entry of entries) {
        const dbPath = path.join(entry.path, 'store.db')
        const db = await statSafe(dbPath)
        if (!db) continue
        chats.push({
          key: `${workspace.name}/${entry.name}`,
          workspaceHash: workspace.name,
          chatId: entry.name,
          dbPath,
          mtimeMs: Math.max(db.mtimeMs, entry.mtimeMs),
          size: db.size,
        })
      }
    }
    chats.sort((a, b) => b.mtimeMs - a.mtimeMs)

    const tasks = []
    for (const chat of chats.slice(0, limit)) {
      if (Date.now() - chat.mtimeMs > MAX_AGE_MS) continue
      const { status, reason } = deriveTaskStatus({
        lastActivityMs: chat.mtimeMs,
        alive: alive.count > 0,
        stallMs: Number(config?.stallSeconds ?? 600) * 1000,
      })
      tasks.push({
        key: chat.key,
        title: `Chat ${chat.chatId.slice(0, 8)}`,
        workspace: `workspace ${chat.workspaceHash.slice(0, 8)}`,
        status,
        statusReason: reason,
        lastActivity: iso(chat.mtimeMs),
        startedAt: null,
        sessionRef: chat.chatId,
        events: [{
          at: iso(chat.mtimeMs),
          kind: 'session.meta',
          severity: 'info',
          summary: 'Cursor chat store updated',
        }],
        meta: {
          chatId: chat.chatId,
          workspaceHash: chat.workspaceHash,
          db: chat.dbPath,
          sizeBytes: chat.size,
          workers: workerCount,
        },
      })
    }

    const rollup = rollupProvider(tasks, {
      alive: alive.count > 0,
      note: alive.count > 0 ? this.note : 'Cursor is not running',
    })
    return { id: this.id, label: this.label, status: rollup.status, note: rollup.note, alive: alive.count > 0, tasks }
  }
}
