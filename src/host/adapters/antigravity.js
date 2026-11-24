/**
 * Antigravity adapter (observation only).
 *
 * Antigravity and Antigravity IDE expose no CLI here. The board watches their
 * Electron workspace-storage directories for recency and their processes for
 * liveness; it does not read the IDE conversation database.
 */

import os from 'node:os'
import path from 'node:path'

import { listDirs } from '../util/fsx.js'
import { deriveTaskStatus, rollupProvider } from '../status.js'
import { iso } from '../util/text.js'
import { countProcesses } from '../util/proc.js'

const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support')

const VARIANTS = [
  {
    key: 'antigravity',
    label: 'Antigravity',
    storage: path.join(SUPPORT, 'Antigravity', 'User', 'workspaceStorage'),
    process: /Antigravity\.app\/Contents\/MacOS\//,
  },
  {
    key: 'antigravity-ide',
    label: 'Antigravity IDE',
    storage: path.join(SUPPORT, 'Antigravity IDE', 'User', 'workspaceStorage'),
    process: /Antigravity IDE\.app\/Contents\/MacOS\//,
  },
]

export class AntigravityAdapter {
  constructor() {
    this.id = 'antigravity'
    this.label = 'Antigravity'
  }

  async poll({ config }) {
    const tasks = []
    let anyAlive = false
    for (const variant of VARIANTS) {
      const alive = await countProcesses([variant.process])
      anyAlive = anyAlive || alive.count > 0
      const workspaces = await listDirs(variant.storage, 40)
      const lastActivity = workspaces[0]?.mtimeMs ?? 0
      if (lastActivity === 0 && alive.count === 0) continue
      const { status, reason } = deriveTaskStatus({
        lastActivityMs: lastActivity,
        alive: alive.count > 0,
        stallMs: Number(config?.stallSeconds ?? 600) * 1000,
      })
      tasks.push({
        key: variant.key,
        title: variant.label,
        workspace: workspaces[0]?.name ?? '',
        status: alive.count > 0 ? status : 'idle',
        statusReason: alive.count > 0 ? reason : 'idle',
        lastActivity: iso(lastActivity),
        startedAt: null,
        sessionRef: variant.key,
        events: [{
          at: iso(lastActivity),
          kind: 'session.meta',
          severity: 'info',
          summary: `${workspaces.length} workspace(s) in storage`,
        }],
        meta: { workspaces: workspaces.length, storage: variant.storage, pid: alive.pid },
      })
    }
    const rollup = rollupProvider(tasks, {
      alive: anyAlive,
      note: 'Antigravity has no CLI here: observation only',
    })
    return { id: this.id, label: this.label, status: rollup.status, note: rollup.note, alive: anyAlive, tasks }
  }
}
