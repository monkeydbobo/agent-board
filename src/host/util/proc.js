/**
 * Process presence probe.
 *
 * The board only needs "is an agent process alive right now", so one `ps`
 * snapshot is shared by every adapter and refreshed on a short TTL. Matching is
 * deliberately conservative: a pattern must identify the app or CLI, never a
 * generic word like `agent`.
 */

import { execFile } from 'node:child_process'

const TTL_MS = 4000
let cache = { at: 0, list: [] }
let inflight

function runPs() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024, timeout: 4000 }, (error, stdout) => {
      if (error || typeof stdout !== 'string') {
        resolve([])
        return
      }
      const list = []
      for (const line of stdout.split('\n')) {
        const text = line.trim()
        if (text === '') continue
        const space = text.indexOf(' ')
        if (space <= 0) continue
        const pid = Number(text.slice(0, space))
        const args = text.slice(space + 1)
        if (!Number.isFinite(pid)) continue
        list.push({ pid, args })
      }
      resolve(list)
    })
  })
}

/** Return the cached process table, refreshing it when stale. */
export async function processes() {
  const now = Date.now()
  if (now - cache.at < TTL_MS) return cache.list
  if (inflight) return inflight
  inflight = runPs().then((list) => {
    cache = { at: Date.now(), list }
    inflight = undefined
    return list
  })
  return inflight
}

/**
 * Count live processes whose argv matches any pattern.
 * @param {Array<RegExp | string>} patterns
 * @returns {Promise<{count: number, pid?: number}>}
 */
export async function countProcesses(patterns) {
  const list = await processes()
  const regexes = patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p)))
  const hits = list.filter((proc) => regexes.some((re) => re.test(proc.args)))
  return { count: hits.length, pid: hits[0]?.pid }
}

/** Provider process signatures used by the adapters. */
export const PROCESS_PATTERNS = {
  dsh: [/DeepSeek Harness\.app\/Contents\/MacOS\//, /\/dsh\s/],
  codex: [/\/codex(?:\s|$)/, /Codex\.app\/Contents\/MacOS\//, /codex exec/],
  claude: [/\/claude(?:\s|$)/, /Claude\.app\/Contents\/MacOS\//],
  cursor: [/Cursor\.app\/Contents\/MacOS\/Cursor/, /cursor-agent/, /\/agent\s+-p\b/],
  localagent: [/LocalAgent\.app\/Contents\/MacOS\//, /\/localagent(?:\s|$)/],
  grokbot: [/Grok Bot\.app\/Contents\/MacOS\//, /grokbot/i],
  antigravity: [/Antigravity(?: IDE)?\.app\/Contents\/MacOS\//],
}
