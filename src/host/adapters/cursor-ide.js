/**
 * Cursor IDE composer reader.
 *
 * Cursor's IDE keeps chat/composer data in a large SQLite state database:
 *
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *
 * Relevant shapes:
 *   - `composerHeaders(composerId, workspaceId, createdAt, lastUpdatedAt,
 *     isArchived, isSubagent, value)` — one row per composer; `value` is JSON
 *     with the display name and workspace identifier.
 *   - `cursorDiskKV(key, value)` — `composerData:<id>` (model, status, token
 *     usage, workspace), `composerConvHeaders:<id>:<chunk>` (ordered bubble
 *     headers), and `bubbleId:<id>:<bubble>` (message text).
 *
 * Reading is strictly bounded: recent non-archived composers only, at most a
 * few thousand rows, and only the bubble keys referenced by the headers. The
 * database is opened read-only with a short busy timeout because Cursor may be
 * writing to it at the same time.
 */

import path from 'node:path'
import os from 'node:os'

import { readJsonSafe } from '../util/fsx.js'
import { summarize } from '../util/text.js'

let sqlitePromise

async function loadSqlite() {
  if (!sqlitePromise) sqlitePromise = import('node:sqlite').catch(() => null)
  return sqlitePromise
}

function parseJson(value) {
  if (typeof value !== 'string') {
    try {
      return JSON.parse(Buffer.from(value ?? []).toString('utf8'))
    } catch {
      return undefined
    }
  }
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

async function workspaceOf(workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId === '') return ''
  const file = path.join(
    os.homedir(),
    'Library/Application Support/Cursor/User/workspaceStorage',
    workspaceId,
    'workspace.json',
  )
  const value = await readJsonSafe(file)
  const folder = typeof value?.folder === 'string' ? value.folder : ''
  if (folder.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(folder).pathname)
    } catch {
      return folder
    }
  }
  return folder
}

function messageText(bubble) {
  if (typeof bubble?.text === 'string' && bubble.text.trim() !== '') return bubble.text
  if (typeof bubble?.richText === 'string') {
    try {
      const rich = JSON.parse(bubble.richText)
      const parts = []
      const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (typeof node.text === 'string') parts.push(node.text)
        if (Array.isArray(node.children)) for (const child of node.children) walk(child)
      }
      walk(rich?.root)
      return parts.join('')
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Read recent IDE composers.
 *
 * @param {string} dbPath
 * @param {object} [options]
 * @param {number} [options.limit] composers to return
 * @param {number} [options.maxMessages] messages kept per composer
 * @param {Map<string, {lastUpdatedAt: number, value: any}>} [options.cache]
 * @returns {Promise<Array<any>>}
 */
export async function readCursorIdeChats(dbPath, options = {}) {
  const { limit = 10, maxMessages = 24, cache } = options
  const sqlite = await loadSqlite()
  if (!sqlite?.DatabaseSync) throw new Error('node:sqlite is unavailable in this runtime')
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 300')
    const headerRows = db.prepare(
      'SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value FROM composerHeaders '
      + 'WHERE isArchived = 0 AND isSubagent = 0 ORDER BY lastUpdatedAt DESC LIMIT ?',
    ).all(Math.max(limit * 2, limit))
    const getData = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
    const getBubble = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
    const getChunks = db.prepare(
      'SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key',
    )
    const chats = []

    for (const row of headerRows) {
      if (chats.length >= limit) break
      const composerId = String(row.composerId)
      const lastUpdatedAt = Number(row.lastUpdatedAt) || 0
      const cached = cache?.get(composerId)
      if (cached && cached.lastUpdatedAt === lastUpdatedAt) {
        chats.push(cached.value)
        continue
      }

      const headerValue = parseJson(row.value) ?? {}
      const data = parseJson(getData.get(`composerData:${composerId}`)?.value) ?? {}
      const model = data.modelConfig?.modelName ?? ''
      const workspace = data.workspaceIdentifier?.fsPath
        ?? headerValue.workspaceIdentifier?.fsPath
        ?? await workspaceOf(row.workspaceId)
      const title = String(headerValue.name ?? data.name ?? '').trim() || `Cursor composer ${composerId.slice(0, 8)}`

      let headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : []
      if (headers.length === 0) {
        const chunks = getChunks.all(
          `composerConvHeaders:${composerId}:`,
          `composerConvHeaders:${composerId};`,
        )
        headers = []
        for (const chunk of chunks) {
          const parsed = parseJson(chunk.value)
          if (Array.isArray(parsed)) headers.push(...parsed)
        }
      }

      const messages = []
      const seen = new Set()
      for (const entry of headers) {
        const bubbleId = String(entry?.bubbleId ?? '')
        if (bubbleId === '' || seen.has(bubbleId)) continue
        const grouping = entry?.grouping ?? {}
        if (entry?.type !== 1 && grouping.hasText !== true) continue
        seen.add(bubbleId)
        const bubble = parseJson(getBubble.get(`bubbleId:${composerId}:${bubbleId}`)?.value)
        if (!bubble) continue
        const text = messageText(bubble).trim()
        if (text === '') continue
        const at = Date.parse(entry?.createdAt ?? bubble.createdAt ?? '') || lastUpdatedAt
        messages.push({
          at,
          role: entry?.type === 1 ? 'user' : 'assistant',
          kind: entry?.type === 1 ? 'run.turn' : 'run.message',
          severity: 'info',
          summary: entry?.type === 1
            ? `user: ${summarize(text, 200)}`
            : `assistant: ${summarize(text, 220)}`,
        })
      }

      const value = {
        id: composerId,
        title,
        workspace,
        model,
        createdAt: Number(row.createdAt) || Number(data.createdAt) || 0,
        lastUpdatedAt,
        status: String(data.status ?? ''),
        contextUsagePercent: Number(data.contextUsagePercent) || 0,
        linesAdded: Number(data.totalLinesAdded) || 0,
        linesRemoved: Number(data.totalLinesRemoved) || 0,
        messages: messages.slice(-maxMessages),
      }
      cache?.set(composerId, { lastUpdatedAt, value })
      chats.push(value)
    }

    if (cache && cache.size > 120) {
      const overflow = cache.size - 100
      let removed = 0
      for (const key of cache.keys()) {
        cache.delete(key)
        if (++removed >= overflow) break
      }
    }
    return chats
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

/** Default IDE state database path for this platform. */
export function defaultCursorStateDb() {
  return path.join(os.homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')
}

/** Exported for tests: parse one composer snapshot without a database. */
export function messagesFromHeaders(headers, bubblesByKey, lastUpdatedAt) {
  const messages = []
  const seen = new Set()
  for (const entry of headers ?? []) {
    const bubbleId = String(entry?.bubbleId ?? '')
    if (bubbleId === '' || seen.has(bubbleId)) continue
    if (entry?.type !== 1 && entry?.grouping?.hasText !== true) continue
    seen.add(bubbleId)
    const bubble = bubblesByKey?.get?.(bubbleId)
    if (!bubble) continue
    const text = messageText(bubble).trim()
    if (text === '') continue
    const at = Date.parse(entry?.createdAt ?? bubble.createdAt ?? '') || lastUpdatedAt
    messages.push({
      at,
      role: entry?.type === 1 ? 'user' : 'assistant',
      kind: entry?.type === 1 ? 'run.turn' : 'run.message',
      severity: 'info',
      summary: entry?.type === 1 ? `user: ${summarize(text, 200)}` : `assistant: ${summarize(text, 220)}`,
    })
  }
  return messages
}
