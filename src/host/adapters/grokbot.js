/**
 * Grok Bot adapter (observation only).
 *
 * Grok Bot ships no CLI on this machine, so the board cannot dispatch into it.
 * It reads the local-exec daemon log for activity and errors and uses process
 * presence for liveness. The provider note says so in the UI.
 */

import path from 'node:path'

import { expandHome, statSafe } from '../util/fsx.js'
import { TailReader } from '../util/tail.js'
import { deriveTaskStatus, rollupProvider } from '../status.js'
import { iso, parseTime, summarize, oneLine } from '../util/text.js'
import { countProcesses, PROCESS_PATTERNS } from '../util/proc.js'

const ISO_RE = /\d{4}-\d\d-\d\dT[\d:.]+Z/
const MAX_LINES = 600

/** Parse one daemon log line into a board event (or null). */
export function normalizeGrokLine(line, fallbackAt = 0) {
  const text = oneLine(line)
  if (text === '') return null
  const stamp = text.match(ISO_RE)
  const at = stamp ? parseTime(stamp[0]) : fallbackAt
  const severity = /\b(error|fail|failed|denied|unauthorized|timeout)\b/i.test(text)
    ? 'error'
    : /\b(warn|retry|stall|quiet)\b/i.test(text)
      ? 'warn'
      : 'info'
  return {
    at,
    event: { kind: 'run.heartbeat', severity, summary: summarize(text, 160) },
  }
}

export class GrokBotAdapter {
  constructor(config = {}) {
    this.id = 'grokbot'
    this.label = 'Grok Bot'
    this.root = expandHome(config.root ?? '~/.grokbot')
    this.logFile = path.join(this.root, 'local-exec-daemon.log')
    this.tail = new TailReader()
    this.events = []
    this.lastEventAt = 0
  }

  async poll({ config }) {
    const alive = await countProcesses(PROCESS_PATTERNS.grokbot)
    const stat = await statSafe(this.logFile)
    if (stat) {
      const { lines } = await this.tail.read(this.logFile, { initialBytes: 64 * 1024 })
      for (const line of lines.slice(-MAX_LINES)) {
        const parsed = normalizeGrokLine(line, stat.mtimeMs)
        if (!parsed) continue
        if (parsed.at <= this.lastEventAt) continue
        this.lastEventAt = parsed.at
        this.events.push({ at: iso(parsed.at), ...parsed.event })
      }
      if (this.events.length > 80) this.events.splice(0, this.events.length - 80)
    }

    const lastLogAt = this.lastEventAt || stat?.mtimeMs || 0
    const { status, reason } = deriveTaskStatus({
      lastActivityMs: lastLogAt,
      alive: alive.count > 0,
      stallMs: Number(config?.stallSeconds ?? 600) * 1000,
    })
    const tasks = lastLogAt > 0
      ? [{
          key: 'local-exec',
          title: 'Grok Bot · local exec',
          workspace: '',
          status: alive.count > 0 ? status : 'idle',
          statusReason: alive.count > 0 ? reason : 'idle',
          lastActivity: iso(lastLogAt),
          startedAt: null,
          sessionRef: 'local-exec-daemon',
          events: this.events.slice(-30),
          meta: { log: this.logFile, pid: alive.pid },
        }]
      : []
    const rollup = rollupProvider(tasks, {
      alive: alive.count > 0,
      note: 'Grok Bot has no CLI here: observation only',
    })
    return { id: this.id, label: this.label, status: rollup.status, note: rollup.note, alive: alive.count > 0, tasks }
  }
}
