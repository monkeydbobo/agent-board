/**
 * DSH adapter: the live agents owned by this Harness process.
 *
 * DSH already has the session log as its source of truth, so the board does not
 * scan its files. It reads `ctx.agents` and derives task activity from the
 * agent's public lifecycle status plus the session header. Live events are
 * limited to status transitions observed by the board itself, which keeps the
 * adapter cheap and free of session-log replay.
 */

import { deriveTaskStatus, rollupProvider } from '../status.js'
import { iso, summarize } from '../util/text.js'
import { countProcesses, PROCESS_PATTERNS } from '../util/proc.js'

function sessionOf(agent) {
  try {
    return agent?.session
  } catch {
    return undefined
  }
}

export class DshAdapter {
  constructor() {
    this.id = 'dsh'
    this.label = 'DSH'
    /** @type {Map<string, any>} */
    this.agents = new Map()
  }

  async poll({ config, services }) {
    const agentsService = services?.agents
    if (!agentsService || typeof agentsService.list !== 'function') {
      return {
        id: this.id,
        label: this.label,
        status: 'offline',
        note: 'The agents service is not available in this profile',
        alive: false,
        tasks: [],
      }
    }

    const alive = await countProcesses(PROCESS_PATTERNS.dsh)
    const now = Date.now()
    let list = []
    try {
      list = agentsService.list()
    } catch {
      list = []
    }

    for (const agent of list) {
      const id = String(agent?.id ?? '')
      if (id === '') continue
      const session = sessionOf(agent)
      const header = session?.header
      const status = agent?.status === 'running' ? 'running' : 'idle'
      let state = this.agents.get(id)
      if (!state) {
        state = {
          id,
          key: id,
          cwd: typeof header?.cwd === 'string' ? header.cwd : '',
          createdAt: Number(header?.createdAt) || now,
          lastActivity: now,
          lastStatus: status,
          events: [{
            at: iso(now),
            kind: 'session.meta',
            severity: 'info',
            summary: 'session discovered',
          }],
        }
        this.agents.set(id, state)
      }
      const previous = state.lastStatus
      state.lastStatus = status
      if (status === 'running') state.lastActivity = now
      if (status !== previous) {
        state.events.push({
          at: iso(now),
          kind: status === 'running' ? 'run.started' : 'run.idle',
          severity: 'info',
          summary: status === 'running' ? 'agent started working' : 'agent went idle',
        })
        if (state.events.length > 60) state.events.splice(0, state.events.length - 60)
      }
      if (typeof header?.cwd === 'string') state.cwd = header.cwd
    }

    const tasks = []
    for (const state of this.agents.values()) {
      const { status, reason } = deriveTaskStatus({
        lastActivityMs: state.lastActivity,
        open: state.lastStatus === 'running',
        alive: true,
        stallMs: Number(config?.stallSeconds ?? 600) * 1000,
      })
      const shortId = state.key.replace(/^session-/, '').slice(0, 8)
      tasks.push({
        key: state.key,
        title: `DSH · ${shortId}`,
        workspace: state.cwd,
        status,
        statusReason: reason,
        lastActivity: iso(state.lastActivity),
        startedAt: iso(state.createdAt),
        sessionRef: state.key,
        events: state.events.slice(-20),
        meta: { agentStatus: state.lastStatus },
      })
    }
    tasks.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))
    const rollup = rollupProvider(tasks, {
      alive: alive.count > 0 || tasks.length > 0,
      note: summarize(`${tasks.length} live agent(s)`, 80),
    })
    return { id: this.id, label: this.label, status: rollup.status, note: rollup.note, alive: true, tasks }
  }
}
