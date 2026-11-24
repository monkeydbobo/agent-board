/**
 * Codex adapter.
 *
 * Codex writes one append-only rollout JSONL per thread under
 * `~/.codex/sessions/YYYY/MM/DD/`. The adapter tails the newest files, folds
 * `session_meta` / `turn_context` / `response_item` / `event_msg` records into a
 * per-thread state, and exposes one board task per thread. Titles prefer
 * `~/.codex/session_index.jsonl`, which Codex keeps for the session picker.
 */

import path from 'node:path'
import fs from 'node:fs/promises'

import { expandHome, listFiles } from '../util/fsx.js'
import { TailReader } from '../util/tail.js'
import { deriveTaskStatus, rollupProvider } from '../status.js'
import { contentText, isBoilerplatePrompt, iso, parseTime, summarize } from '../util/text.js'
import { countProcesses, PROCESS_PATTERNS } from '../util/proc.js'

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Map one raw Codex rollout record to the board vocabulary.
 * Pure and side-effect free so the parser tests can exercise it directly.
 *
 * @param {any} record
 * @returns {{
 *   at: number,
 *   event: {kind: string, severity: 'info'|'warn'|'error', summary: string} | null,
 *   open?: boolean,
 *   error?: boolean,
 *   ended?: boolean,
 *   sessionId?: string,
 *   cwd?: string,
 *   model?: string,
 *   title?: string,
 *   prompt?: string,
 *   approval?: string,
 *   tokens?: {input: number, output: number},
 * }}
 */
export function normalizeCodexRecord(record) {
  const type = record?.type
  const payload = record?.payload ?? {}
  const at = parseTime(record?.timestamp) || parseTime(payload?.timestamp)
  const result = { at, event: null }

  if (type === 'session_meta') {
    result.sessionId = payload.id ?? payload.session_id
    result.cwd = payload.cwd
    result.model = payload.model_provider ?? payload.model
    result.title = payload.thread_name
    result.event = { kind: 'session.meta', severity: 'info', summary: 'session started' }
    return result
  }

  if (type === 'turn_context') {
    result.cwd = payload.cwd
    result.model = payload.model ?? undefined
    result.approval = payload.approval_policy ?? undefined
    return result
  }

  if (type === 'response_item') {
    const item = payload.type
    if (item === 'message') {
      const text = contentText(payload.content)
      const role = payload.role === 'user' ? 'user' : 'assistant'
      if (role === 'user') {
        result.prompt = text
        result.event = { kind: 'run.turn', severity: 'info', summary: `user: ${summarize(text)}` }
      } else {
        result.open = false
        result.event = { kind: 'run.message', severity: 'info', summary: `assistant: ${summarize(text)}` }
      }
      return result
    }
    if (item === 'function_call' || item === 'custom_tool_call') {
      const detail = typeof payload.arguments === 'string' ? payload.arguments : ''
      result.event = { kind: 'run.tool', severity: 'info', summary: summarize(`${payload.name ?? 'tool'} ${detail}`, 160) }
      result.open = true
      return result
    }
    if (item === 'function_call_output' || item === 'custom_tool_call_output') {
      result.event = { kind: 'run.tool', severity: 'info', summary: 'tool finished' }
      return result
    }
    if (item === 'token_count') {
      const usage = payload.info?.total_token_usage ?? payload.info?.last_token_usage
      if (usage) {
        result.tokens = {
          input: Number(usage.input_tokens ?? usage.input ?? 0) || 0,
          output: Number(usage.output_tokens ?? usage.output ?? 0) || 0,
        }
      }
    }
    return result
  }

  if (type === 'event_msg') {
    const item = payload.type
    if (item === 'task_started') {
      result.open = true
      result.event = { kind: 'run.started', severity: 'info', summary: 'turn started' }
      return result
    }
    if (item === 'task_complete') {
      result.open = false
      result.event = { kind: 'run.idle', severity: 'info', summary: 'turn complete' }
      return result
    }
    if (item === 'turn_aborted') {
      result.open = false
      result.error = true
      result.event = { kind: 'run.error', severity: 'warn', summary: 'turn aborted' }
      return result
    }
    if (item === 'error') {
      result.error = true
      result.event = { kind: 'run.error', severity: 'error', summary: summarize(payload.message ?? 'codex error') }
      return result
    }
    if (item === 'token_count') {
      const usage = payload.info?.total_token_usage ?? payload.info?.last_token_usage
      if (usage) {
        result.tokens = {
          input: Number(usage.input_tokens ?? usage.input ?? 0) || 0,
          output: Number(usage.output_tokens ?? usage.output ?? 0) || 0,
        }
      }
    }
    return result
  }

  return result
}

/** Read Codex's thread-name index, tolerating missing/oversized files. */
async function readSessionIndex(file) {
  const map = new Map()
  let text
  try {
    const st = await fs.stat(file)
    const handle = await fs.open(file, 'r')
    try {
      const length = Math.min(st.size, 2 * 1024 * 1024)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, st.size - length)
      text = buffer.toString('utf8')
    } finally {
      await handle.close().catch(() => {})
    }
  } catch {
    return map
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line)
      if (entry && entry.id) map.set(String(entry.id), String(entry.thread_name ?? ''))
    } catch {
      /* skip malformed */
    }
  }
  return map
}

function sessionIdFromFile(file) {
  const name = path.basename(file)
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)
  return match ? match[1] : ''
}

function pushEvent(state, event) {
  if (!event || event.kind === 'run.heartbeat') return
  const key = `${event.kind}\u0000${event.summary}\u0000${state.lastActivity}`
  if (state.eventKeys.has(key)) return
  state.eventKeys.add(key)
  if (state.eventKeys.size > 500) state.eventKeys.delete(state.eventKeys.values().next().value)
  state.events.push({ at: iso(state.lastActivity), kind: event.kind, severity: event.severity, summary: event.summary })
  if (state.events.length > 120) state.events.splice(0, state.events.length - 120)
}

export class CodexAdapter {
  constructor(config = {}) {
    this.id = 'codex'
    this.label = 'Codex'
    this.root = expandHome(config.root ?? '~/.codex/sessions')
    this.indexFile = expandHome(config.indexFile ?? '~/.codex/session_index.jsonl')
    this.tail = new TailReader()
    /** @type {Map<string, any>} file path -> state */
    this.sessions = new Map()
    this.index = { at: 0, map: new Map() }
  }

  async titles() {
    if (Date.now() - this.index.at < 60 * 1000) return this.index.map
    this.index = { at: Date.now(), map: await readSessionIndex(this.indexFile) }
    return this.index.map
  }

  async poll({ config }) {
    const alive = await countProcesses(PROCESS_PATTERNS.codex)
    const titles = await this.titles()
    const limit = Math.max(10, Number(config?.maxTasksPerProvider ?? 40))
    const files = await listFiles(this.root, {
      match: (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
      limit: limit * 2,
      depth: 6,
      maxAgeMs: MAX_AGE_MS,
    })

    for (const file of files) {
      let state = this.sessions.get(file.path)
      if (!state) {
        state = {
          file: file.path,
          sessionId: sessionIdFromFile(file.path),
          cwd: '',
          model: '',
          title: '',
          approval: '',
          startedAt: 0,
          lastActivity: 0,
          open: false,
          error: false,
          errorAt: 0,
          events: [],
          eventKeys: new Set(),
          turns: 0,
          tokens: { input: 0, output: 0 },
        }
        this.sessions.set(file.path, state)
      }
      const { lines } = await this.tail.read(file.path, { initialBytes: 96 * 1024 })
      for (const line of lines) {
        const text = line.trim()
        if (text === '') continue
        let record
        try {
          record = JSON.parse(text)
        } catch {
          continue
        }
        const normalized = normalizeCodexRecord(record)
        if (normalized.sessionId) state.sessionId = normalized.sessionId
        if (normalized.cwd) state.cwd = normalized.cwd
        if (normalized.model) state.model = normalized.model
        if (normalized.title) state.title = normalized.title
        if (normalized.approval) state.approval = normalized.approval
        if (normalized.prompt && state.title === '' && !isBoilerplatePrompt(normalized.prompt)) {
          state.title = summarize(normalized.prompt, 90)
        }
        if (normalized.tokens) state.tokens = normalized.tokens
        if (normalized.open === true) {
          if (!state.open) state.turns += 1
          state.open = true
        }
        if (normalized.open === false) state.open = false
        if (normalized.at > 0) {
          if (normalized.at > state.lastActivity) state.lastActivity = normalized.at
          if (state.startedAt === 0) state.startedAt = normalized.at
          if (normalized.error) {
            state.error = true
            state.errorAt = normalized.at
          } else if (normalized.event && state.error && normalized.at > state.errorAt) {
            state.error = false
          }
          pushEvent(state, normalized.event)
        }
      }
    }

    const now = Date.now()
    const tasks = []
    for (const state of this.sessions.values()) {
      if (state.lastActivity === 0 || now - state.lastActivity > MAX_AGE_MS) continue
      const { status, reason } = deriveTaskStatus({
        lastActivityMs: state.lastActivity,
        open: state.open,
        error: state.error,
        alive: alive.count > 0,
        stallMs: Number(config?.stallSeconds ?? 600) * 1000,
      })
      const key = state.sessionId || path.basename(state.file).replace(/^rollout-/, '').replace(/\.jsonl$/, '')
      const indexed = titles.get(state.sessionId)
      tasks.push({
        key,
        title: indexed || state.title || `Codex ${key.slice(0, 8)}`,
        workspace: state.cwd,
        status,
        statusReason: reason,
        lastActivity: iso(state.lastActivity),
        startedAt: iso(state.startedAt),
        sessionRef: state.sessionId || key,
        events: state.events.slice(-30),
        meta: {
          model: state.model || undefined,
          approval: state.approval || undefined,
          turns: state.turns,
          tokens: state.tokens,
          file: state.file,
        },
      })
    }
    tasks.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))
    const limited = tasks.slice(0, limit)
    const rollup = rollupProvider(limited, { alive: alive.count > 0, note: alive.count > 0 ? '' : 'Codex is not running' })
    return { id: this.id, label: this.label, status: rollup.status, note: rollup.note, alive: alive.count > 0, tasks: limited }
  }
}
