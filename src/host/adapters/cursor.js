/**
 * Cursor adapter.
 *
 * Two layers of data:
 *   - `~/.cursor/chats/<workspace-hash>/<chat-id>/store.db` — CLI chat stores.
 *     The schema is decoded by `cursor-db.js`: meta JSON, a content-addressed
 *     blob table, and a root protobuf that lists message blobs in order.
 *     Parsing yields the chat name, workspace, model, user prompts, assistant
 *     text, and tool calls.
 *   - File mtimes and process presence remain the liveness signal.
 *
 * Chats whose store cannot be decoded still appear at metadata level instead of
 * disappearing; the provider note says which mode was used.
 */

import path from 'node:path'

import { expandHome, listDirs, readJsonSafe, statSafe } from '../util/fsx.js'
import { deriveTaskStatus, rollupProvider } from '../status.js'
import { iso } from '../util/text.js'
import { countProcesses, PROCESS_PATTERNS } from '../util/proc.js'
import { readCursorChat } from './cursor-db.js'
import { defaultCursorStateDb, readCursorIdeChats } from './cursor-ide.js'

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const MAX_PARSE = 24
const CACHE_LIMIT = 240
const MAX_IDE = 10
const MAX_CLI = 10
// A Cursor store can be touched when the app opens a chat; only trust that
// mtime as activity while it is close to the last message actually inside it.
const CONTENT_GRACE_MS = 10 * 60 * 1000

export class CursorAdapter {
  constructor(config = {}) {
    this.id = 'cursor'
    this.label = 'Cursor'
    this.root = expandHome(config.root ?? '~/.cursor/chats')
    this.stateFile = expandHome('~/.cursor/agent-cli-state.json')
    this.ideStateDb = expandHome(config.ideStateDb ?? defaultCursorStateDb())
    /** @type {Map<string, {lastUpdatedAt: number, value: any}>} */
    this.ideCache = new Map()
    this.ideError = ''
    /** @type {Map<string, {mtimeMs: number, size: number, value: any}>} */
    this.cache = new Map()
    this.parseFailures = 0
    this.parsedChats = 0
  }

  async readChat(chat) {
    const cached = this.cache.get(chat.dbPath)
    if (cached && cached.mtimeMs === chat.mtimeMs && cached.size === chat.size) return cached.value
    let value
    try {
      value = { ok: true, data: await readCursorChat(chat.dbPath) }
    } catch (error) {
      value = { ok: false, error: String(error?.message ?? error) }
    }
    this.cache.set(chat.dbPath, { mtimeMs: chat.mtimeMs, size: chat.size, value })
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    return value
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
    const ideStat = await statSafe(this.ideStateDb)
    let ideChats = []
    let ideOk = false
    if (ideStat) {
      try {
        ideChats = await readCursorIdeChats(this.ideStateDb, {
          limit: MAX_IDE,
          maxMessages: 24,
          cache: this.ideCache,
        })
        ideOk = true
        this.ideError = ''
      } catch (error) {
        this.ideError = String(error?.message ?? error)
      }
    }

    for (const chat of ideChats) {
      const lastActivityMs = chat.lastUpdatedAt || chat.createdAt
      const { status, reason } = deriveTaskStatus({
        lastActivityMs,
        open: chat.status === 'generating',
        alive: alive.count > 0,
        stallMs: Number(config?.stallSeconds ?? 600) * 1000,
      })
      const events = chat.messages.slice(-24).map((message) => ({
        at: iso(message.at || lastActivityMs),
        kind: message.kind,
        severity: message.severity,
        summary: message.summary,
      }))
      if (events.length === 0) {
        events.push({
          at: iso(lastActivityMs),
          kind: 'session.meta',
          severity: 'info',
          summary: `Cursor composer ${chat.id.slice(0, 8)} updated`,
        })
      }
      tasks.push({
        key: `ide/${chat.id}`,
        title: chat.title,
        workspace: chat.workspace || '',
        status,
        statusReason: reason,
        lastActivity: iso(lastActivityMs),
        startedAt: chat.createdAt ? iso(chat.createdAt) : null,
        sessionRef: chat.id,
        events,
        meta: {
          source: 'ide',
          composerId: chat.id,
          model: chat.model || undefined,
          contextUsagePercent: chat.contextUsagePercent || undefined,
          linesAdded: chat.linesAdded || undefined,
          linesRemoved: chat.linesRemoved || undefined,
          messages: chat.messages.length,
          stateDb: this.ideStateDb,
          workers: workerCount,
        },
      })
    }

    let parsedCount = 0
    let failedCount = 0
    let cliAdded = 0
    for (const chat of chats) {
      if (tasks.length >= limit || cliAdded >= MAX_CLI) break
      if (Date.now() - chat.mtimeMs > MAX_AGE_MS) continue
      const parsed = cliAdded < MAX_PARSE ? await this.readChat(chat) : { ok: false, error: 'not-parsed' }
      const data = parsed.ok ? parsed.data : undefined
      if (parsed.ok) parsedCount += 1
      else if (parsed.error !== 'not-parsed') failedCount += 1

      const contentAt = data?.lastActivityMs ?? 0
      const lastActivityMs = contentAt > 0
        ? Math.max(contentAt, Math.min(chat.mtimeMs, contentAt + CONTENT_GRACE_MS))
        : chat.mtimeMs
      const { status, reason } = deriveTaskStatus({
        lastActivityMs,
        alive: alive.count > 0,
        stallMs: Number(config?.stallSeconds ?? 600) * 1000,
      })

      const events = []
      if (data && data.messages.length > 0) {
        for (const message of data.messages.slice(-30)) {
          events.push({
            at: iso(message.at || data.createdAt || chat.mtimeMs),
            kind: message.kind,
            severity: message.severity,
            summary: message.summary,
          })
        }
      } else {
        events.push({
          at: iso(chat.mtimeMs),
          kind: 'session.meta',
          severity: 'info',
          summary: 'Cursor chat store updated',
        })
      }

      tasks.push({
        key: `cli/${chat.key}`,
        title: data?.title || `Chat ${chat.chatId.slice(0, 8)}`,
        workspace: data?.workspace || `workspace ${chat.workspaceHash.slice(0, 8)}`,
        status,
        statusReason: reason,
        lastActivity: iso(lastActivityMs),
        startedAt: data?.createdAt ? iso(data.createdAt) : null,
        sessionRef: chat.chatId,
        events,
        meta: {
          source: 'cli',
          chatId: chat.chatId,
          workspaceHash: chat.workspaceHash,
          db: chat.dbPath,
          model: data?.model || undefined,
          messages: data?.messageCount,
          missingBlobs: data?.missing,
          parse: parsed.ok ? 'content' : 'metadata',
          workers: workerCount,
          ...(parsed.ok ? {} : { parseError: parsed.error }),
        },
      })
      cliAdded += 1
    }

    tasks.sort((a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? '')))
    this.parsedChats = parsedCount
    this.parseFailures = failedCount
    const noteParts = []
    if (ideOk) noteParts.push(`${ideChats.length} IDE composer(s)`)
    else if (ideStat) noteParts.push(`IDE composers unavailable: ${this.ideError}`)
    if (parsedCount > 0) noteParts.push(`${parsedCount} CLI transcript(s)`)
    if (failedCount > 0) noteParts.push(`${failedCount} CLI chat(s) metadata-only`)
    const note = noteParts.length > 0 ? noteParts.join(' · ') : 'Cursor chats are metadata-only'
    const rollup = rollupProvider(tasks, { alive: alive.count > 0, note })
    return { id: this.id, label: this.label, status: rollup.status, note: rollup.note, alive: alive.count > 0, tasks }
  }
}
