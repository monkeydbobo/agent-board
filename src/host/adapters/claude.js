/**
 * Claude Code adapter.
 *
 * Claude Code stores one JSONL transcript per session under
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. Records are typed
 * (`user`, `assistant`, `system`, `cost-state`, `queue-operation`, ...), which
 * gives the board a fairly precise turn boundary: a user message opens a turn,
 * an assistant text-only message closes it, and a `tool_use` block keeps it
 * open.
 */

import path from 'node:path'

import { expandHome, listFiles } from '../util/fsx.js'
import { TailReader } from '../util/tail.js'
import { deriveTaskStatus, rollupProvider } from '../status.js'
import { contentText, isBoilerplatePrompt, iso, parseTime, summarize } from '../util/text.js'
import { countProcesses, PROCESS_PATTERNS } from '../util/proc.js'

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Map one raw Claude Code transcript record to the board vocabulary.
 * @param {any} record
 */
export function normalizeClaudeRecord(record) {
  const type = record?.type
  const at = parseTime(record?.timestamp) || parseTime(record?.message?.timestamp)
  const result = { at, event: null }
  const message = record?.message ?? {}
  const content = message.content ?? record?.content

  if (type === 'user') {
    const blocks = Array.isArray(content) ? content : []
    const toolResult = blocks.some((block) => block?.type === 'tool_result')
    const text = contentText(content)
    if (toolResult) {
      result.event = { kind: 'run.tool', severity: 'info', summary: 'tool result' }
      return result
    }
    result.open = true
    result.prompt = text
    result.event = { kind: 'run.turn', severity: 'info', summary: `user: ${summarize(text)}` }
    return result
  }

  if (type === 'assistant') {
    const blocks = Array.isArray(content) ? content : []
    const tool = blocks.find((block) => block?.type === 'tool_use')
    const text = contentText(blocks)
    if (message.model && message.model !== '<synthetic>') result.model = message.model
    const usage = message.usage
    if (usage && (Number.isFinite(usage.input_tokens) || Number.isFinite(usage.output_tokens))) {
      result.tokens = {
        input: Number(usage.input_tokens ?? 0) || 0,
        output: Number(usage.output_tokens ?? 0) || 0,
      }
    }
    if (tool) {
      result.open = true
      const input = tool.input === undefined ? '' : JSON.stringify(tool.input)
      result.event = { kind: 'run.tool', severity: 'info', summary: summarize(`${tool.name ?? 'tool'} ${input}`, 160) }
    } else if (text !== '') {
      result.open = false
      result.event = { kind: 'run.message', severity: 'info', summary: `assistant: ${summarize(text)}` }
    }
    return result
  }

  if (type === 'system') {
    if (record.isApiErrorMessage === true || record.subtype === 'error') {
      result.error = true
      result.event = { kind: 'run.error', severity: 'error', summary: summarize(contentText(content) || 'Claude error') }
      return result
    }
    result.event = { kind: 'session.meta', severity: 'info', summary: summarize(contentText(content) || 'system event', 120) }
    return result
  }

  if (type === 'permission-mode') {
    result.approval = record.permissionMode
    return result
  }

  if (type === 'queue-operation') {
    if (record.operation === 'enqueue') {
      result.open = true
      result.event = { kind: 'run.turn', severity: 'info', summary: 'prompt queued' }
    }
    return result
  }

  if (type === 'cost-state') {
    const cost = record.cost ?? record.state ?? {}
    const tokens = cost.tokens ?? cost
    if (Number.isFinite(tokens?.input) || Number.isFinite(tokens?.output)) {
      result.tokens = { input: Number(tokens.input ?? 0) || 0, output: Number(tokens.output ?? 0) || 0 }
    }
    return result
  }

  return result
}

function pushEvent(state, event) {
  if (!event) return
  const key = `${event.kind}\u0000${event.summary}\u0000${state.lastActivity}`
  if (state.eventKeys.has(key)) return
  state.eventKeys.add(key)
  if (state.eventKeys.size > 500) state.eventKeys.delete(state.eventKeys.values().next().value)
  state.events.push({ at: iso(state.lastActivity), kind: event.kind, severity: event.severity, summary: event.summary })
  if (state.events.length > 120) state.events.splice(0, state.events.length - 120)
}

export class ClaudeAdapter {
  constructor(config = {}) {
    this.id = 'claude'
    this.label = 'Claude Code'
    this.root = expandHome(config.root ?? '~/.claude/projects')
    this.tail = new TailReader()
    /** @type {Map<string, any>} file path -> state */
    this.sessions = new Map()
  }

  async poll({ config }) {
    const alive = await countProcesses(PROCESS_PATTERNS.claude)
    const limit = Math.max(10, Number(config?.maxTasksPerProvider ?? 40))
    const files = await listFiles(this.root, {
      match: (name) => name.endsWith('.jsonl'),
      limit: limit * 2,
      depth: 3,
      maxAgeMs: MAX_AGE_MS,
    })

    for (const file of files) {
      let state = this.sessions.get(file.path)
      if (!state) {
        state = {
          file: file.path,
          sessionId: '',
          cwd: '',
          branch: '',
          model: '',
          approval: '',
          title: '',
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
        const normalized = normalizeClaudeRecord(record)
        if (record.sessionId) state.sessionId = String(record.sessionId)
        if (record.cwd) state.cwd = String(record.cwd)
        if (record.gitBranch) state.branch = String(record.gitBranch)
        if (normalized.model) state.model = normalized.model
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
      const fallback = path.basename(state.file).replace(/\.jsonl$/, '')
      const key = state.sessionId || fallback
      const project = path.basename(path.dirname(state.file))
      tasks.push({
        key,
        title: state.title || `Claude ${key.slice(0, 8)}`,
        workspace: state.cwd || project.replace(/^-/, '/').replace(/-/g, '/'),
        status,
        statusReason: reason,
        lastActivity: iso(state.lastActivity),
        startedAt: iso(state.startedAt),
        sessionRef: key,
        events: state.events.slice(-30),
        meta: {
          model: state.model || undefined,
          branch: state.branch || undefined,
          approval: state.approval || undefined,
          turns: state.turns,
          tokens: state.tokens,
          file: state.file,
        },
      })
    }
    tasks.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))
    const limited = tasks.slice(0, limit)
    const rollup = rollupProvider(limited, { alive: alive.count > 0, note: alive.count > 0 ? '' : 'Claude Code is not running' })
    return { id: this.id, label: this.label, status: rollup.status, note: rollup.note, alive: alive.count > 0, tasks: limited }
  }
}
