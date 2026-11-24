/**
 * Board service: merges adapter snapshots, keeps a small in-memory event ring,
 * applies manual overrides, and publishes revisioned snapshots to the web UI.
 *
 * The board is intentionally a derived cache. Durable truth stays in each
 * agent's own store; the only persisted board state is user intent (manual
 * status overrides, hidden tasks, monitoring paused).
 */

import crypto from 'node:crypto'
import path from 'node:path'

import { createAdapters } from './adapters/index.js'
import { expandHome, readJsonSafe, writeJsonAtomic } from './util/fsx.js'
import { iso, stableId, summarize } from './util/text.js'

const STATUS_ORDER = { attention: 0, running: 1, idle: 2, done: 3 }
const MAX_EVENTS = 400
const ADAPTER_TIMEOUT_MS = 5000

function normalizeConfig(raw = {}) {
  const number = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  return {
    dataDir: expandHome(raw.dataDir ?? '~/.dsh/agent-board'),
    pollMs: number(raw.pollMs, 3000, 1000, 60000),
    stallSeconds: number(raw.stallSeconds, 600, 60, 86400),
    maxTasksPerProvider: number(raw.maxTasksPerProvider, 40, 5, 200),
    providers: { ...(raw.providers ?? {}) },
    roots: { ...(raw.roots ?? {}) },
  }
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class Board {
  constructor({ ctx, config }) {
    this.ctx = ctx
    this.config = normalizeConfig(config)
    this.services = {
      agents: typeof ctx?.get === 'function' ? ctx.get('agents') : undefined,
    }
    this.adapters = createAdapters(this.config)
    /** @type {Map<string, any>} */
    this.tasks = new Map()
    this.providers = []
    this.events = []
    this.seen = new Set()
    this.overrides = {}
    this.monitoring = true
    this.revision = 0
    this.signature = ''
    this.subscribers = new Set()
    this.timers = new Set()
    this.persistTimer = null
    this.publishTimer = null
    this.ticking = null
    this.stopped = false
    this.today = new Date().toISOString().slice(0, 10)
    this.todayCount = 0
    /** @type {Map<string, any>} collaboration runs published by the collab runner */
    this.collabs = new Map()
    this.stopCollab = null
    this.token = crypto.randomBytes(24).toString('hex')
    this.encoder = new TextEncoder()
  }

  /** Load the small persisted user-intent state. */
  async init() {
    const state = await readJsonSafe(path.join(this.config.dataDir, 'state.json'))
    if (state && typeof state === 'object') {
      if (state.overrides && typeof state.overrides === 'object') this.overrides = state.overrides
      if (typeof state.monitoring === 'boolean') this.monitoring = state.monitoring
    }
  }

  /** Start polling and heartbeats; returns the disposer. */
  start() {
    this.init()
      .catch((error) => console.warn('[agent-board] state load failed:', error?.message ?? error))
      .then(() => {
        if (this.stopped) return
        this.tick().catch((error) => console.warn('[agent-board] first tick failed:', error?.message ?? error))
        const poll = setInterval(() => {
          this.tick().catch((error) => console.warn('[agent-board] tick failed:', error?.message ?? error))
        }, this.config.pollMs)
        const heartbeat = setInterval(() => this.heartbeat(), 20000)
        this.timers.add(poll)
        this.timers.add(heartbeat)
      })
    return () => this.stop()
  }

  stop() {
    this.stopped = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
    if (this.publishTimer) clearTimeout(this.publishTimer)
    if (this.persistTimer) clearTimeout(this.persistTimer)
    for (const subscriber of this.subscribers) {
      try {
        subscriber.controller.close()
      } catch {
        /* already closed */
      }
    }
    this.subscribers.clear()
  }

  /** Coalesce concurrent ticks; force ignores the paused state. */
  tick(force = false) {
    if (!this.monitoring && !force) return Promise.resolve()
    if (this.ticking) return this.ticking
    this.ticking = this.runTick(force)
      .catch((error) => console.warn('[agent-board] tick error:', error?.message ?? error))
      .finally(() => {
        this.ticking = null
      })
    return this.ticking
  }

  async runTick() {
    const results = await Promise.all(this.adapters.map(async (adapter) => {
      try {
        const result = await withTimeout(
          adapter.poll({ config: this.config, services: this.services }),
          ADAPTER_TIMEOUT_MS,
          adapter.id,
        )
        return result
      } catch (error) {
        return {
          id: adapter.id,
          label: adapter.label,
          status: 'offline',
          note: `adapter failed: ${error?.message ?? error}`,
          alive: false,
          tasks: [],
        }
      }
    }))

    const nextTasks = new Map()
    const providers = []
    const observedAt = iso(Date.now())

    for (const result of results) {
      const data = result ?? { id: 'unknown', label: 'Unknown', status: 'offline', tasks: [] }
      let running = 0
      for (const task of data.tasks ?? []) {
        const id = `${data.id}:${task.key}`
        const override = this.overrides[id]
        const lastActivityMs = Date.parse(task.lastActivity ?? '') || 0
        if (override?.hiddenAt && lastActivityMs <= override.hiddenAt) continue
        let status = task.status
        let reason = task.statusReason
        if (override?.status && STATUS_ORDER[override.status] !== undefined) {
          status = override.status
          reason = 'manual'
        }
        if (STATUS_ORDER[status] === undefined) status = 'idle'
        nextTasks.set(id, {
          id,
          provider: data.id,
          providerLabel: data.label,
          title: task.title || `${data.label} session`,
          workspace: task.workspace || '',
          status,
          statusReason: reason || 'observed',
          lastActivity: task.lastActivity || null,
          startedAt: task.startedAt || null,
          sessionRef: task.sessionRef || '',
          events: Array.isArray(task.events) ? task.events.slice(-24) : [],
          meta: task.meta ?? {},
          firstSeenAt: this.tasks.get(id)?.firstSeenAt ?? observedAt,
          updatedAt: observedAt,
          manual: Boolean(override?.status),
        })
        if (status === 'running') running += 1
        this.ingestEvents(id, data.id, task.events)
      }
      providers.push({
        id: data.id,
        label: data.label,
        status: data.status,
        note: data.note ?? '',
        alive: Boolean(data.alive),
        taskCount: data.tasks?.length ?? 0,
        runningCount: running,
      })
    }

    this.tasks = nextTasks
    this.providers = providers
    this.pruneEvents()
    this.commit()
  }

  ingestEvents(taskId, provider, events) {
    if (!Array.isArray(events)) return
    for (const event of events) {
      if (!event || typeof event.summary !== 'string') continue
      const at = event.at || null
      const key = `${taskId}|${at}|${event.kind}|${event.summary}`
      if (this.seen.has(key)) continue
      this.seen.add(key)
      const record = {
        id: stableId(key),
        taskId,
        provider,
        at,
        kind: event.kind ?? 'run.heartbeat',
        severity: event.severity ?? 'info',
        summary: event.summary,
      }
      this.events.push(record)
      const day = (at ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10)
      if (day === this.today) this.todayCount += 1
    }
  }

  pruneEvents() {
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    // Keep a generous key window: adapters resend their recent events every
    // tick, so a small window would re-ingest and inflate the counters.
    if (this.seen.size > 40000) {
      const drop = this.seen.size - 30000
      let removed = 0
      for (const key of this.seen) {
        this.seen.delete(key)
        if (++removed >= drop) break
      }
    }
  }

  /** Compare the externally visible projection and publish only on change. */
  commit() {
    const projection = {
      monitoring: this.monitoring,
      providers: this.providers.map((p) => [p.id, p.status, p.taskCount, p.runningCount, p.note]),
      tasks: [...this.tasks.values()].map((t) => [t.id, t.status, t.title, t.lastActivity, t.events.length, t.manual]),
      collabs: [...this.collabs.values()].map((c) => [c.id, c.status, c.round, c.currentPhase, c.log?.length ?? 0]),
      events: this.events.length,
    }
    const signature = stableId(JSON.stringify(projection))
    if (signature === this.signature) return
    this.signature = signature
    this.revision += 1
    this.schedulePublish()
  }

  snapshot() {
    const tasks = [...this.tasks.values()].sort((a, b) => {
      const byStatus = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
      if (byStatus !== 0) return byStatus
      return String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? ''))
    })
    const stats = { total: tasks.length, running: 0, attention: 0, idle: 0, done: 0 }
    for (const task of tasks) {
      if (stats[task.status] !== undefined) stats[task.status] += 1
    }
    return {
      revision: this.revision,
      generatedAt: iso(Date.now()),
      monitoring: this.monitoring,
      providers: this.providers,
      tasks,
      collabs: [...this.collabs.values()]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 12),
      stats: { ...stats, eventsToday: this.todayCount },
      events: this.events.slice(-60).reverse(),
      config: {
        pollMs: this.config.pollMs,
        stallSeconds: this.config.stallSeconds,
        dataDir: this.config.dataDir,
      },
    }
  }

  schedulePublish() {
    if (this.publishTimer) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      this.broadcast()
    }, 200)
  }

  broadcast() {
    if (this.subscribers.size === 0) return
    const payload = `data: ${JSON.stringify({ type: 'snapshot', data: this.snapshot() })}\n\n`
    for (const subscriber of this.subscribers) {
      try {
        subscriber.controller.enqueue(this.encoder.encode(payload))
      } catch {
        this.subscribers.delete(subscriber)
      }
    }
  }

  heartbeat() {
    for (const subscriber of this.subscribers) {
      try {
        subscriber.controller.enqueue(this.encoder.encode(': ping\n\n'))
      } catch {
        this.subscribers.delete(subscriber)
      }
    }
  }

  /**
   * Attach one SSE response stream.
   * @param {ReadableStreamDefaultController<Uint8Array>} controller
   * @returns {() => void} unsubscribe
   */
  subscribe(controller) {
    const subscriber = { controller }
    this.subscribers.add(subscriber)
    try {
      controller.enqueue(this.encoder.encode('retry: 3000\n\n'))
      controller.enqueue(this.encoder.encode(`data: ${JSON.stringify({ type: 'snapshot', data: this.snapshot() })}\n\n`))
    } catch {
      this.subscribers.delete(subscriber)
    }
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  getTask(id) {
    return this.tasks.get(id)
  }

  /** Publish a collaboration snapshot (called by the collab runner). */
  upsertCollab(value) {
    if (!value || typeof value.id !== 'string') return
    this.collabs.set(value.id, value)
    this.commit()
  }

  removeCollab(id) {
    this.collabs.delete(String(id ?? ''))
    this.commit()
  }

  /** Append a collaboration event to the shared event ring and UI stream. */
  addCollabEvent(runId, text, severity = 'info', title = '') {
    const at = iso(Date.now())
    const key = `collab|${runId}|${at}|${text}`
    this.events.push({
      id: stableId(key),
      taskId: `collab:${runId}`,
      provider: 'collab',
      at,
      kind: 'run.heartbeat',
      severity,
      summary: summarize(text, 200),
      title: summarize(title, 100),
    })
    this.pruneEvents()
    this.commit()
  }

  getCollab(id) {
    return this.collabs.get(String(id ?? ''))
  }

  /** User-intent persistence, debounced. */
  persist() {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      writeJsonAtomic(path.join(this.config.dataDir, 'state.json'), {
        overrides: this.overrides,
        monitoring: this.monitoring,
        updatedAt: iso(Date.now()),
      }).catch((error) => console.warn('[agent-board] state write failed:', error?.message ?? error))
    }, 400)
  }

  /**
   * Apply one UI/tool action. Only an explicit allow-list is accepted.
   * @param {string} name
   * @param {any} payload
   */
  async action(name, payload = {}) {
    if (name === 'refresh') {
      await this.tick(true)
      return { ok: true, revision: this.revision }
    }
    if (name === 'setMonitoring') {
      this.monitoring = Boolean(payload.enabled)
      this.persist()
      await this.tick(true)
      return { ok: true, monitoring: this.monitoring }
    }
    if (name === 'setTaskStatus') {
      const taskId = String(payload.taskId ?? '')
      const status = String(payload.status ?? '')
      if (!this.tasks.has(taskId)) return { ok: false, error: 'task-not-found' }
      if (STATUS_ORDER[status] === undefined) return { ok: false, error: 'invalid-status' }
      this.overrides[taskId] = { ...(this.overrides[taskId] ?? {}), status, at: Date.now() }
      this.persist()
      await this.tick(true)
      return { ok: true }
    }
    if (name === 'clearTaskOverride') {
      const taskId = String(payload.taskId ?? '')
      delete this.overrides[taskId]
      this.persist()
      await this.tick(true)
      return { ok: true }
    }
    if (name === 'stopCollab') {
      const id = String(payload.id ?? '')
      if (typeof this.stopCollab !== 'function') return { ok: false, error: 'collab-unavailable' }
      return await this.stopCollab(id)
    }
    if (name === 'hideTask') {
      const taskId = String(payload.taskId ?? '')
      const task = this.tasks.get(taskId)
      if (!task) return { ok: false, error: 'task-not-found' }
      const hiddenAt = Date.parse(task.lastActivity ?? '') || Date.now()
      this.overrides[taskId] = { ...(this.overrides[taskId] ?? {}), hiddenAt }
      this.persist()
      await this.tick(true)
      return { ok: true }
    }
    return { ok: false, error: 'unknown-action' }
  }
}
