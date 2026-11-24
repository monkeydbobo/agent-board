/**
 * LocalAgent adapter.
 *
 * LocalAgent (CodeFlicker) keeps a daemon, per-task directories, and structured
 * JSON logs under `~/.localagent`. The adapter reports task directories as board
 * tasks, the daemon as its own task, and recent daemon log lines as events.
 */

import path from 'node:path'
import { expandHome, listDirs, listFiles, readJsonSafe } from '../util/fsx.js'
import { TailReader } from '../util/tail.js'
import { deriveTaskStatus, rollupProvider } from '../status.js'
import { iso, parseTime, summarize, oneLine } from '../util/text.js'
import { countProcesses, PROCESS_PATTERNS } from '../util/proc.js'

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

function severityOf(level) {
  const value = String(level ?? '').toUpperCase()
  if (value === 'ERROR' || value === 'FATAL') return 'error'
  if (value === 'WARN' || value === 'WARNING') return 'warn'
  return 'info'
}

export class LocalAgentAdapter {
  constructor(config = {}) {
    this.id = 'localagent'
    this.label = 'LocalAgent'
    this.root = expandHome(config.root ?? '~/.localagent')
    this.tail = new TailReader()
    this.maxLogAt = 0
  }

  async poll({ config }) {
    const alive = await countProcesses(PROCESS_PATTERNS.localagent)
    const limit = Math.max(10, Number(config?.maxTasksPerProvider ?? 40))
    const now = Date.now()

    const processInfo = await readJsonSafe(path.join(this.root, 'local-store/daemon-host/process.json'))
    const taskDirs = await listDirs(path.join(this.root, 'tasks'), limit)
    const workshopDirs = await listDirs(path.join(this.root, 'workshop'), limit)

    const events = []
    const logFiles = await listFiles(path.join(this.root, 'logs/runtime-daemon'), {
      match: (name) => name.endsWith('.log'),
      limit: 2,
      depth: 1,
      maxAgeMs: 2 * 24 * 60 * 60 * 1000,
    })
    for (const file of logFiles) {
      const { lines } = await this.tail.read(file.path, { initialBytes: 64 * 1024 })
      for (const line of lines) {
        const text = line.trim()
        if (text === '') continue
        let record
        try {
          record = JSON.parse(text)
        } catch {
          record = { message: text }
        }
        const at = parseTime(record.timestamp) || file.mtimeMs
        if (at <= this.maxLogAt) continue
        this.maxLogAt = at
        events.push({
          at: iso(at),
          kind: 'run.heartbeat',
          severity: severityOf(record.level),
          summary: summarize(`${record.component ? `${record.component}: ` : ''}${oneLine(record.message ?? '')}`, 150),
        })
      }
    }
    const recentEvents = events.slice(-20)
    const logAt = recentEvents.length > 0 ? parseTime(recentEvents[recentEvents.length - 1].at) : 0

    const tasks = []
    for (const dir of taskDirs) {
      if (now - dir.mtimeMs > MAX_AGE_MS) continue
      const { status, reason } = deriveTaskStatus({
        lastActivityMs: dir.mtimeMs,
        alive: alive.count > 0,
        stallMs: Number(config?.stallSeconds ?? 600) * 1000,
      })
      tasks.push({
        key: `task/${dir.name}`,
        title: `Task ${dir.name.slice(0, 8)}`,
        workspace: '',
        status,
        statusReason: reason,
        lastActivity: iso(dir.mtimeMs),
        startedAt: null,
        sessionRef: dir.name,
        events: [],
        meta: { dir: dir.path },
      })
    }

    if (alive.count > 0 || processInfo?.pid) {
      const startedAt = parseTime(processInfo?.startedAt)
      const lastActivity = logAt || startedAt || now
      const { status, reason } = deriveTaskStatus({
        lastActivityMs: lastActivity,
        open: recentEvents.some((event) => event.severity === 'error'),
        alive: alive.count > 0,
        stallMs: Number(config?.stallSeconds ?? 600) * 1000,
      })
      tasks.push({
        key: 'daemon',
        title: 'LocalAgent daemon',
        workspace: '',
        status: alive.count > 0 ? status : 'idle',
        statusReason: alive.count > 0 ? reason : 'idle',
        lastActivity: iso(lastActivity),
        startedAt: iso(startedAt),
        sessionRef: processInfo?.processInstanceId ?? 'daemon',
        events: recentEvents,
        meta: {
          pid: processInfo?.pid,
          command: processInfo?.command,
          modules: processInfo?.modules,
          workshops: workshopDirs.length,
          logs: logFiles[0]?.path,
        },
      })
    }

    tasks.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))
    const limited = tasks.slice(0, limit)
    const rollup = rollupProvider(limited, {
      alive: alive.count > 0,
      note: alive.count > 0 ? '' : 'LocalAgent is not running',
    })
    return { id: this.id, label: this.label, status: rollup.status, note: rollup.note, alive: alive.count > 0, tasks: limited }
  }
}
