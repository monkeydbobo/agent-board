/**
 * Antigravity local state reader.
 *
 * Antigravity keeps a small VS Code-style `state.vscdb` (one `ItemTable`) per
 * app variant. It does not appear to store agent transcripts locally: the
 * `trajectorySummaries` item is empty on this machine and the rest is UI
 * preference state. We still read the version and any trajectory summaries so
 * a future build that starts persisting them shows up without a code change.
 */

import fs from 'node:fs/promises'

let sqlitePromise

async function loadSqlite() {
  if (!sqlitePromise) sqlitePromise = import('node:sqlite').catch(() => null)
  return sqlitePromise
}

function text(value) {
  return value === undefined ? '' : typeof value === 'string' ? value : Buffer.from(value).toString('utf8')
}

/**
 * Normalize an unknown trajectory-summary payload into board rows.
 * @param {unknown} parsed
 */
export function normalizeTrajectories(parsed) {
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.entries(parsed).map(([id, value]) => (value && typeof value === 'object' ? { id, ...value } : undefined))
      : []
  const out = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = String(row.id ?? row.trajectoryId ?? row.sessionId ?? row.uuid ?? '')
    const title = String(row.title ?? row.name ?? row.summary ?? row.label ?? '').trim()
    const updated = Number(row.lastUpdatedAt ?? row.updatedAtMs ?? row.timestampMs ?? row.updatedAt ?? row.createdAt) || 0
    if (id === '' && title === '') continue
    out.push({ id: id || title, title: title || id, updatedAt: updated })
    if (out.length >= 30) break
  }
  return out
}

/**
 * Read one Antigravity state database.
 * @param {string} dbPath
 * @returns {Promise<{version: string, trajectories: Array<{id: string, title: string, updatedAt: number}>}>}
 */
export async function readAntigravityState(dbPath) {
  const empty = { version: '', trajectories: [] }
  const sqlite = await loadSqlite()
  if (!sqlite?.DatabaseSync) return empty
  let stat
  try {
    stat = await fs.stat(dbPath)
  } catch {
    return empty
  }
  if (!stat.isFile()) return empty
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    const get = (key) => {
      try {
        return db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)?.value
      } catch {
        return undefined
      }
    }
    const version = text(get('antigravityChangelog/lastVersion')).trim()
    const raw = text(get('antigravityUnifiedStateSync.trajectorySummaries')).trim()
    let trajectories = []
    if (raw !== '') {
      try {
        trajectories = normalizeTrajectories(JSON.parse(raw))
      } catch {
        trajectories = []
      }
    }
    return { version, trajectories }
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}
