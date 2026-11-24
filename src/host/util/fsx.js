/**
 * Small filesystem helpers shared by the host adapters.
 *
 * Everything here is best-effort: a missing directory or an unreadable file
 * reports through the return value instead of throwing, because the board must
 * keep monitoring the other agents when one of them removes its data root.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Expand a leading `~` to the current home directory. */
export function expandHome(value) {
  if (typeof value !== 'string' || value === '') return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

/** `stat` that returns undefined for missing/unreadable paths. */
export async function statSafe(target) {
  try {
    return await fs.stat(target)
  } catch {
    return undefined
  }
}

/** Read a JSON file, returning undefined on any failure. */
export async function readJsonSafe(target) {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'))
  } catch {
    return undefined
  }
}

/** Create a directory recursively, tolerating an existing one. */
export async function ensureDir(target) {
  try {
    await fs.mkdir(target, { recursive: true })
  } catch {
    /* best effort */
  }
}

/**
 * Write JSON atomically (temp file + rename) so a crash never leaves a
 * half-written state file behind.
 */
export async function writeJsonAtomic(target, value) {
  const dir = path.dirname(target)
  await ensureDir(dir)
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`)
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, target)
}

/**
 * List files below `root`, newest first.
 *
 * @param {string} root directory to walk (missing is not an error)
 * @param {object} [options]
 * @param {(name: string) => boolean} [options.match] basename filter
 * @param {number} [options.limit] maximum number of entries returned
 * @param {number} [options.depth] maximum directory depth
 * @param {number} [options.maxAgeMs] ignore entries older than this
 * @returns {Promise<Array<{path: string, name: string, mtimeMs: number, size: number}>>}
 */
export async function listFiles(root, options = {}) {
  const { match = () => true, limit = 200, depth = 4, maxAgeMs = 0 } = options
  const out = []
  const now = Date.now()
  async function walk(dir, level) {
    if (level > depth || out.length >= limit * 4) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit * 4) return
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, level + 1)
        continue
      }
      if (!entry.isFile() || !match(entry.name)) continue
      const st = await statSafe(full)
      if (!st) continue
      if (maxAgeMs > 0 && now - st.mtimeMs > maxAgeMs) continue
      out.push({ path: full, name: entry.name, mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  await walk(root, 0)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, limit)
}

/**
 * List direct child directories with their mtimes, newest first.
 * @param {string} root
 * @param {number} [limit]
 */
export async function listDirs(root, limit = 80) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const full = path.join(root, entry.name)
    const st = await statSafe(full)
    if (st) out.push({ path: full, name: entry.name, mtimeMs: st.mtimeMs })
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, limit)
}
