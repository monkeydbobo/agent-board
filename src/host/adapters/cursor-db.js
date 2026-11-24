/**
 * Cursor chat store reader.
 *
 * Cursor CLI keeps one SQLite database per chat:
 *
 *   ~/.cursor/chats/<workspace-hash>/<chat-id>/store.db
 *
 * The schema is deliberately tiny:
 *   - `meta(key, value)` stores one hex-encoded JSON document with the chat
 *     name, creation time, model, and `latestRootBlobId`.
 *   - `blobs(id, data)` is a content-addressed store; `id` is the SHA-256 of
 *     `data`. Message blobs are JSON (`role`, `content`); the root blob is a
 *     small protobuf whose repeated field 1 lists message blob ids in order.
 *
 * This reader is read-only and defensive: an unknown schema, a missing blob,
 * or a binary blob yields no message instead of an exception.
 */

import crypto from 'node:crypto'

let sqlitePromise

async function loadSqlite() {
  if (!sqlitePromise) {
    sqlitePromise = import('node:sqlite').catch(() => null)
  }
  return sqlitePromise
}

/** Decode the single meta document (hex JSON, or plain JSON for tweaked stores). */
export function decodeCursorMeta(value) {
  const text = typeof value === 'string' ? value : Buffer.from(value ?? []).toString('utf8')
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    if (trimmed.startsWith('{')) return JSON.parse(trimmed)
    if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
      return JSON.parse(Buffer.from(trimmed, 'hex').toString('utf8'))
    }
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** Select the meta row that actually carries `latestRootBlobId`. */
export function pickCursorMeta(rows) {
  for (const row of rows ?? []) {
    const decoded = decodeCursorMeta(row?.value)
    if (decoded && typeof decoded.latestRootBlobId === 'string') return decoded
  }
  return undefined
}

function readVarint(buffer, offset) {
  let value = 0
  let shift = 0
  let cursor = offset
  while (cursor < buffer.length) {
    const byte = buffer[cursor]
    cursor += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return [value, cursor]
    shift += 7
    if (shift > 35) return [null, cursor]
  }
  return [null, cursor]
}

/**
 * Extract the ordered 32-byte blob ids from the root protobuf.
 * Only top-level length-delimited field 1 values of exactly 32 bytes qualify.
 */
export function parseCursorRootIds(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  const ids = []
  let offset = 0
  while (offset < bytes.length && ids.length < 2000) {
    const [tag, afterTag] = readVarint(bytes, offset)
    if (tag === null) break
    offset = afterTag
    const wire = tag & 7
    const field = tag >>> 3
    if (wire === 2) {
      const [length, afterLength] = readVarint(bytes, offset)
      if (length === null || length < 0 || afterLength + length > bytes.length) break
      const payload = bytes.subarray(afterLength, afterLength + length)
      offset = afterLength + length
      if (field === 1 && length === 32) ids.push(payload.toString('hex'))
    } else if (wire === 0) {
      const [, next] = readVarint(bytes, offset)
      offset = next
    } else if (wire === 1) {
      offset += 8
    } else if (wire === 5) {
      offset += 4
    } else {
      break
    }
  }
  return ids
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/**
 * Parse Cursor's `<timestamp>Tuesday, Nov 24, 2026, 11:58 AM (UTC+8)</timestamp>`.
 * Falls back to the platform parser, then to 0.
 */
export function parseCursorTimestamp(text) {
  const raw = String(text ?? '').match(/<timestamp>([\s\S]*?)<\/timestamp>/)?.[1]?.trim()
  if (!raw) return 0
  const match = raw.match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i)
  if (!match) return Date.parse(raw) || 0
  const month = MONTHS[match[1].slice(0, 3).toLowerCase()]
  if (month === undefined) return Date.parse(raw) || 0
  let hour = Number(match[4]) % 12
  if (/pm/i.test(match[6])) hour += 12
  const offset = raw.match(/\(UTC([+-])(\d{1,2})(?::?(\d{2}))?\)/i)
  if (offset) {
    const minutes = (Number(offset[2]) || 0) * 60 + (Number(offset[3]) || 0)
    const sign = offset[1] === '-' ? -1 : 1
    return Date.UTC(Number(match[3]), month, Number(match[2]), hour, Number(match[5])) - sign * minutes * 60000
  }
  return new Date(Number(match[3]), month, Number(match[2]), hour, Number(match[5])).getTime()
}

/** Extract `<user_query>` text; environment-only messages yield an empty string. */
export function extractCursorQuery(text) {
  const value = String(text ?? '')
  const query = value.match(/<user_query>([\s\S]*?)<\/user_query>/i)?.[1]?.trim()
  if (query) return query
  if (/<user_info>/i.test(value)) return ''
  return value.trim()
}

/** Extract the workspace path Cursor records in the environment preamble. */
export function extractCursorWorkspace(text) {
  return String(text ?? '').match(/Workspace Path:\s*([^\n<]+)/i)?.[1]?.trim() ?? ''
}

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

function textOf(blocks) {
  return blocks
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function summarizeLocal(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Read one chat database.
 *
 * @param {string} dbPath
 * @returns {Promise<{
 *   title: string,
 *   workspace: string,
 *   model: string,
 *   createdAt: number,
 *   lastActivityMs: number,
 *   messages: Array<{at: number, kind: string, severity: string, summary: string, role: string}>,
 *   messageCount: number,
 *   missing: number,
 * }>}
 */
export async function readCursorChat(dbPath) {
  const sqlite = await loadSqlite()
  if (!sqlite?.DatabaseSync) throw new Error('node:sqlite is unavailable in this runtime')
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    const metaRows = db.prepare('SELECT key, value FROM meta').all()
    const meta = pickCursorMeta(metaRows) ?? {}
    const createdAt = Number(meta.createdAt) || 0
    const title = typeof meta.name === 'string' ? meta.name.trim() : ''
    const model = typeof meta.lastUsedModel === 'string' && meta.lastUsedModel !== 'default' ? meta.lastUsedModel : ''

    const rootId = typeof meta.latestRootBlobId === 'string' ? meta.latestRootBlobId : ''
    if (rootId === '') {
      return { title, workspace: '', model, createdAt, lastActivityMs: createdAt, messages: [], messageCount: 0, missing: 0 }
    }

    const getBlob = db.prepare('SELECT data FROM blobs WHERE id = ?')
    const rootRow = getBlob.get(rootId)
    if (!rootRow?.data) {
      return { title, workspace: '', model, createdAt, lastActivityMs: createdAt, messages: [], messageCount: 0, missing: 1 }
    }
    const ids = parseCursorRootIds(rootRow.data)
    const toolNames = new Map()
    const messages = []
    let workspace = ''
    let clock = createdAt
    let sequence = 0
    let missing = 0

    // Ids are in conversation order; `clock` advances from the last user
    // timestamp so assistant/tool rows stay ordered without their own stamps.
    for (const id of ids) {
      const row = getBlob.get(id)
      if (!row?.data) {
        missing += 1
        continue
      }
      let blob
      try {
        blob = JSON.parse(Buffer.from(row.data).toString('utf8'))
      } catch {
        continue
      }
      const role = blob?.role
      if (role === 'system') continue
      const blocks = blocksOf(blob?.content)

      if (role === 'user') {
        const text = blocksOf(blob.content).map((block) => String(block?.text ?? '')).join('\n')
        if (workspace === '') workspace = extractCursorWorkspace(text)
        const at = parseCursorTimestamp(text) || clock
        const query = extractCursorQuery(text)
        if (query === '') continue
        clock = at
        sequence = 0
        messages.push({
          at: clock + sequence++ * 1000,
          kind: 'run.turn',
          severity: 'info',
          role: 'user',
          summary: `user: ${summarizeLocal(query, 200)}`,
        })
        continue
      }

      if (role === 'assistant') {
        for (const block of blocks) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            messages.push({
              at: clock + sequence++ * 1000,
              kind: 'run.message',
              severity: 'info',
              role: 'assistant',
              summary: `assistant: ${summarizeLocal(block.text, 220)}`,
            })
            continue
          }
          if (block?.type === 'tool-call') {
            if (typeof block.toolCallId === 'string') toolNames.set(block.toolCallId, block.toolName)
            const args = block?.args ?? {}
            const detail = args.command ?? args.description ?? args.path ?? ''
            messages.push({
              at: clock + sequence++ * 1000,
              kind: 'run.tool',
              severity: 'info',
              role: 'assistant',
              summary: summarizeLocal(`${block.toolName ?? 'tool'}: ${String(detail)}`, 180),
            })
          }
        }
        continue
      }

      if (role === 'tool') {
        for (const block of blocks) {
          const name = toolNames.get(block?.toolCallId) ?? block?.toolName ?? 'tool'
          const result = String(block?.result ?? '')
          const failed = /Exit code: [1-9]/.test(result) || /\b(error|failed|denied)\b/i.test(result.slice(0, 300))
          messages.push({
            at: clock + sequence++ * 1000,
            kind: 'run.tool',
            severity: failed ? 'warn' : 'info',
            role: 'tool',
            summary: summarizeLocal(`${name} finished${failed ? ' with errors' : ''}`, 120),
          })
        }
      }
    }

    const firstQuery = messages.find((message) => message.role === 'user')?.summary.replace(/^user:\s*/, '') ?? ''
    const lastActivityMs = messages.length > 0 ? messages[messages.length - 1].at : createdAt
    return {
      title: title || firstQuery,
      workspace,
      model,
      createdAt,
      lastActivityMs,
      messages: messages.slice(-60),
      messageCount: messages.length,
      missing,
    }
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

/** Content-addressed id check used by tests and diagnostics. */
export function cursorBlobId(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}
