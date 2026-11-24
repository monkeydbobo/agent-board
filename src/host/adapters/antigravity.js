/**
 * Antigravity adapter (observation only).
 *
 * Two app variants are monitored: the Antigravity desktop shell and the
 * Antigravity IDE (a VS Code fork). Neither exposes an agent CLI: the bundled
 * `antigravity-ide` binary is the ordinary VS Code file/folder opener, and
 * `agy-desktop-helper` is a computer-use helper. The local `state.vscdb` keeps
 * UI preferences and an empty `trajectorySummaries` item, so there is no
 * transcript to parse on this machine.
 *
 * The board therefore reports the real local facts: process presence, app
 * version, workspace count, and any trajectory summaries a future build starts
 * persisting. It never invents a conversation.
 */

import os from 'node:os'
import path from 'node:path'

import { listDirs, statSafe } from '../util/fsx.js'
import { deriveTaskStatus, rollupProvider } from '../status.js'
import { iso } from '../util/text.js'
import { countProcesses } from '../util/proc.js'
import { readAntigravityState } from './antigravity-state.js'

const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support')

const VARIANTS = [
  {
    key: 'antigravity',
    label: 'Antigravity',
    storage: path.join(SUPPORT, 'Antigravity', 'User', 'workspaceStorage'),
    stateDb: path.join(SUPPORT, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
    process: /Antigravity\.app\/Contents\/MacOS\//,
  },
  {
    key: 'antigravity-ide',
    label: 'Antigravity IDE',
    storage: path.join(SUPPORT, 'Antigravity IDE', 'User', 'workspaceStorage'),
    stateDb: path.join(SUPPORT, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
    process: /Antigravity IDE\.app\/Contents\/MacOS\//,
  },
]

export class AntigravityAdapter {
  constructor() {
    this.id = 'antigravity'
    this.label = 'Antigravity'
    /** @type {Map<string, {mtimeMs: number, size: number, value: any}>} */
    this.stateCache = new Map()
  }

  async readState(variant) {
    const stat = await statSafe(variant.stateDb)
    if (!stat) return { version: '', trajectories: [] }
    const cached = this.stateCache.get(variant.stateDb)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value
    let value
    try {
      value = await readAntigravityState(variant.stateDb)
    } catch {
      value = { version: '', trajectories: [] }
    }
    this.stateCache.set(variant.stateDb, { mtimeMs: stat.mtimeMs, size: stat.size, value })
    return value
  }

  async poll() {
    const tasks = []
    const versions = []
    const workspaceCounts = []
    let anyAlive = false

    for (const variant of VARIANTS) {
      const alive = await countProcesses([variant.process])
      anyAlive = anyAlive || alive.count > 0
      const workspaces = await listDirs(variant.storage, 40)
      const state = await this.readState(variant)
      const stateStat = await statSafe(variant.stateDb)
      const lastWorkspaceAt = workspaces[0]?.mtimeMs ?? 0
      const lastActivityMs = Math.max(lastWorkspaceAt, stateStat?.mtimeMs ?? 0)
      if (state.version) versions.push(`${variant.label} ${state.version}`)
      workspaceCounts.push(`${variant.label} ${workspaces.length} ws`)

      if (state.trajectories.length > 0) {
        for (const trajectory of state.trajectories.slice(0, 10)) {
          const activity = trajectory.updatedAt || lastActivityMs
          const { status, reason } = deriveTaskStatus({
            lastActivityMs: activity,
            alive: alive.count > 0,
          })
          tasks.push({
            key: `${variant.key}/trajectory/${trajectory.id}`,
            title: trajectory.title,
            workspace: '',
            status,
            statusReason: reason,
            lastActivity: iso(activity),
            startedAt: trajectory.updatedAt ? iso(trajectory.updatedAt) : null,
            sessionRef: trajectory.id,
            events: [{
              at: iso(activity),
              kind: 'session.meta',
              severity: 'info',
              summary: 'Antigravity trajectory summary updated',
            }],
            meta: {
              source: 'trajectory',
              app: variant.label,
              version: state.version,
              stateDb: variant.stateDb,
              cli: 'antigravity-ide (file opener only)',
            },
          })
        }
        continue
      }

      tasks.push({
        key: variant.key,
        title: variant.label,
        workspace: '',
        status: alive.count > 0 ? 'idle' : 'done',
        statusReason: alive.count > 0 ? 'quiet' : 'ended',
        lastActivity: iso(lastActivityMs),
        startedAt: null,
        sessionRef: variant.key,
        events: [{
          at: iso(lastActivityMs),
          kind: 'session.meta',
          severity: 'info',
          summary: `${workspaces.length} workspace(s) · no local transcript store`,
        }],
        meta: {
          source: 'app',
          app: variant.label,
          version: state.version || undefined,
          workspaces: workspaces.length,
          stateDb: variant.stateDb,
          cli: 'antigravity-ide (file opener only)',
          transcripts: 0,
        },
      })
    }

    const noteParts = []
    if (versions.length > 0) noteParts.push(versions.join(' / '))
    noteParts.push(...workspaceCounts)
    noteParts.push('no local transcript')
    const rollup = rollupProvider(tasks, {
      alive: anyAlive,
      note: noteParts.join(' · '),
    })
    return { id: this.id, label: this.label, status: rollup.status, note: rollup.note, alive: anyAlive, tasks }
  }
}
