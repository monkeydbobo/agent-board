/**
 * Local provider icon table.
 *
 * Icons were resolved once through the dashboard-icons MCP server and are
 * served from this package, so the board has a stable default icon for every
 * provider without a runtime network dependency.
 */

import fs from 'node:fs/promises'

export const ICON_FILES = {
  dsh: 'dsh.svg',
  codex: 'codex.svg',
  claude: 'claude.svg',
  cursor: 'cursor.svg',
  grokbot: 'grokbot.svg',
  antigravity: 'antigravity.svg',
}

const BASE = new URL('../../assets/icons/', import.meta.url)
const cache = new Map()

/**
 * Read one bundled icon.
 * @param {string} provider
 * @returns {Promise<Buffer | undefined>}
 */
export async function readIcon(provider) {
  const file = ICON_FILES[provider]
  if (file === undefined) return undefined
  const cached = cache.get(provider)
  if (cached) return cached
  try {
    const data = await fs.readFile(new URL(file, BASE))
    cache.set(provider, data)
    return data
  } catch {
    return undefined
  }
}

/** Absolute path for diagnostics only. */
export function iconPath(provider) {
  const file = ICON_FILES[provider]
  return file === undefined ? undefined : new URL(file, BASE).pathname
}
