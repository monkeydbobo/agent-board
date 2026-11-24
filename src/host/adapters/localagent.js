/**
 * LocalAgent adapter.
 *
 * LocalAgent stores one append-only session transcript per session:
 *
 *   ~/.localagent/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Records are typed (`config`, `session-favorite`, `snapshot`, `message`).
 * `message` records carry `role` (`user` / `assistant` / `tool` / `synthetic`),
 * timestamps, model, usage, and Claude-style content blocks (`text`,
 * `tool_use`, `tool-result`, `reasoning`). The project directory name encodes
 * the working directory; `~/.localagent/data.json` maps known paths back.
 *
 * `control/<session>.jsonl` holds backend binding and history coverage, not
 * conversation content, and is ignored here.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { expandHome, listFiles, readJsonSafe } from '../util/fsx.js'
import { TailReader } from '../util/tail.js'
import { deriveTaskStatus, rollupProvider } from '../status.js'
import { contentText, iso, parseTime, summarize } from '../util/text.js'
import { countProcesses, PROCESS_PATTERNS } from '../util/proc.js'

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const HEAD_BYTES = 64 * 1024

/** Encode an absolute path the way LocalAgent names a project directory. */
export function encodeProjectPath(value) {
  return String(value).toLowerCase().replace(/^\//, '').replace(/\./g, '').replace(/\//g, '-')
}

/** Strip LocalAgent's prompt boilerplate for a display title. */
export function localagentTitle(text) {
  const cleaned = String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, ' ')
    .replace(/^\s*用户要求[:：]\s*/u, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '' || /^system[- ]?reminder\b/i.test(cleaned)) return ''
  return cleaned
}

function durationLabel(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return ''
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

function toolDetail(block) {
  const input = block?.input ?? {}
  return input.command ?? input.description ?? input.path ?? input.query ?? ''
}

function resultFailed(block) {
  const result = block?.result
  const text = typeof result === 'string'
    ? result
    : typeof result?.llmContent === 'string'
      ? result.llmContent
      : JSON.stringify(result ?? '')
  return /Exit code: [1-9]/i.test(text) || /\b(error|failed|denied|exception)\b/i.test(text.slice(0, 500))
}

/**
 * Map one raw LocalAgent record to board events.
 * @param {any} record
 */
export function normalizeLocalAgentRecord(record) {
  if (record?.type !== 'message') return { at: 0, events: [], open: undefined }
  const at = parseTime(record.timestamp) || parseTime(record.occurredAt)
  const result = { at, events: [], open: undefined, model: '', usage: undefined, durationMs: 0, prompt: '' }
  const role = record.role
  const content = record.content

  if (role === 'user') {
    const text = contentText(content)
    result.prompt = text
    result.open = true
    result.events.push({ kind: 'run.turn', severity: 'info', summary: `user: ${summarize(localagentTitle(text), 200)}` })
    return result
  }

  if (role === 'assistant') {
    if (typeof record.model === 'string') result.model = record.model
    if (record.usage) result.usage = record.usage
    const blocks = Array.isArray(content) ? content : []
    let sawTool = false
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        result.events.push({ kind: 'run.message', severity: 'info', summary: `assistant: ${summarize(block.text, 220)}` })
        result.open = false
      } else if (block?.type === 'tool_use') {
        sawTool = true
        result.events.push({
          kind: 'run.tool',
          severity: 'info',
          summary: summarize(`${block.name ?? 'tool'}: ${toolDetail(block)}`, 180),
        })
      }
    }
    if (sawTool) result.open = true
    return result
  }

  if (role === 'tool') {
    const blocks = Array.isArray(content) ? content : []
    for (const block of blocks) {
      if (block?.type !== 'tool-result') continue
      result.open = true
      result.events.push({
        kind: 'run.tool',
        severity: resultFailed(block) ? 'warn' : 'info',
        summary: summarize(`${block.toolName ?? 'tool'} finished${resultFailed(block) ? ' with errors' : ''}`, 120),
      })
    }
    return result
  }

  if (role === 'synthetic') {
    if (record.metadata?.type === 'turn_duration') {
      result.durationMs = Number(record.metadata.durationMs) || 0
      result.open = false
      const label = durationLabel(result.durationMs)
      result.events.push({
        kind: 'run.idle',
        severity: 'info',
        summary: label === '' ? 'turn completed' : `turn completed in ${label}`,
      })
    }
    return result
  }

  return result
}

function extractDirectory(record) {
  const content = record?.content
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block?.type !== 'tool-result') continue
    const result = block.result
    const text = typeof result?.llmContent === 'string' ? result.llmContent : ''
    const match = text.match(/^Directory:\s*(\/.+)$/m)
    if (match) return match[1].trim()
  }
  return ''
}

export class LocalAgentAdapter {
  constructor(config = {}) {
    this.id = 'localagent'
    this.label = 'LocalAgent'
    this.root = expandHome(config.root ?? '~/.localagent')
    this.projects = path.join(this.root, 'projects')
    this.dataFile = path.join(this.root, 'data.json')
    this.tail = new TailReader()
    /** @type {Map<string, any>} file path -> state */
    this.sessions = new Map()
    /** @type {Map<string, string>} encoded project dir -> absolute path */
    this.projectMap = new Map()
    this.projectMapAt = 0
    /** @type {Map<string, {title: string, startedAt: number}>} files whose head was read */
    this.headInfo = new Map()
  }

  async loadProjectMap() {
    if (Date.now() - this.projectMapAt < 15000) return this.projectMap
    this.projectMapAt = Date.now()
    const data = await readJsonSafe(this.dataFile)
    const map = new Map()
    for (const cwd of Object.keys(data?.projects ?? {})) {
      map.set(encodeProjectPath(cwd), cwd)
    }
    this.projectMap = map
    return map
  }

  async readHeadInfo(file) {
    const cached = this.headInfo.get(file)
    if (cached) return cached
    let info = { title: '', startedAt: 0 }
    let handle
    try {
      const stat = await fs.stat(file)
      const length = Math.min(stat.size, HEAD_BYTES)
      const buffer = Buffer.alloc(length)
      handle = await fs.open(file, 'r')
      await handle.read(buffer, 0, length, 0)
      for (const line of buffer.toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (record?.type !== 'message') continue
        if (info.startedAt === 0) {
          const at = parseTime(record.timestamp) || parseTime(record.occurredAt)
          if (at > 0) info.startedAt = at
        }
        if (info.title === '' && record.role === 'user') {
          const title = localagentTitle(contentText(record.content))
          if (title !== '') info.title = summarize(title, 90)
        }
        if (info.title !== '' && info.startedAt !== 0) break
      }
    } catch {
      /* head stays empty */
    } finally {
      await handle?.close().catch(() => {})
    }
    this.headInfo.set(file, info)
    return info
  }

  async poll({ config }) {
    const alive = await countProcesses(PROCESS_PATTERNS.localagent)
    const projectMap = await this.loadProjectMap()
    const limit = Math.max(10, Number(config?.maxTasksPerProvider ?? 40))
    const processInfo = await readJsonSafe(path.join(this.root, 'local-store/daemon-host/process.json'))
    const stallMs = Number(config?.stallSeconds ?? 600) * 1000

    const files = await listFiles(this.projects, {
      match: (name) => name.endsWith('.jsonl'),
      limit: limit * 2,
      depth: 1,
      maxAgeMs: MAX_AGE_MS,
    })

    for (const file of files) {
      let state = this.sessions.get(file.path)
      if (!state) {
        state = {
          file: file.path,
          sessionId: '',
          projectDir: path.basename(path.dirname(file.path)),
          cwd: '',
          title: '',
          model: '',
          startedAt: 0,
          lastActivity: 0,
          open: false,
          error: false,
          errorAt: 0,
          events: [],
          eventKeys: new Set(),
          turns: 0,
          tokens: undefined,
          lastDurationMs: 0,
          entrypoint: '',
          version: '',
        }
        this.sessions.set(file.path, state)
      }
      const { lines } = await this.tail.read(file.path, { initialBytes: 512 * 1024 })
      for (const line of lines) {
        const text = line.trim()
        if (text === '') continue
        let record
        try {
          record = JSON.parse(text)
        } catch {
          continue
        }
        if (record?.type !== 'message') continue
        if (typeof record.sessionId === 'string' && record.sessionId !== '') state.sessionId = record.sessionId
        if (typeof record.entrypoint === 'string') state.entrypoint = record.entrypoint
        if (typeof record.version === 'string') state.version = record.version
        const normalized = normalizeLocalAgentRecord(record)
        if (normalized.prompt && state.title === '') {
          const title = localagentTitle(normalized.prompt)
          if (title !== '') state.title = summarize(title, 90)
        }
        if (normalized.model) state.model = normalized.model
        if (normalized.usage) state.tokens = normalized.usage
        if (normalized.durationMs) state.lastDurationMs = normalized.durationMs
        if (normalized.open === true) {
          if (!state.open) state.turns += 1
          state.open = true
        }
        if (normalized.open === false) state.open = false
        if (normalized.at > 0) {
          if (normalized.at > state.lastActivity) state.lastActivity = normalized.at
          if (state.startedAt === 0) state.startedAt = normalized.at
          for (const event of normalized.events) {
            const key = `${normalized.at}|${event.kind}|${event.summary}`
            if (state.eventKeys.has(key)) continue
            state.eventKeys.add(key)
            if (state.eventKeys.size > 600) state.eventKeys.delete(state.eventKeys.values().next().value)
            state.events.push({ at: iso(normalized.at), kind: event.kind, severity: event.severity, summary: event.summary })
            if (state.events.length > 120) state.events.splice(0, state.events.length - 120)
          }
        }
        if (record.role === 'tool' && state.cwd === '') {
          const directory = extractDirectory(record)
          if (directory !== '') state.cwd = directory
        }
      }

      const head = await this.readHeadInfo(file.path)
      if (head.title !== '') state.title = head.title
      if (head.startedAt > 0 && (state.startedAt === 0 || head.startedAt < state.startedAt)) {
        state.startedAt = head.startedAt
      }
      if (state.cwd === '') state.cwd = projectMap.get(state.projectDir) ?? ''
      const lastActivity = state.lastActivity || file.mtimeMs
      const { status, reason } = deriveTaskStatus({
        lastActivityMs: lastActivity,
        open: state.open,
        error: state.error,
        alive: alive.count > 0,
        stallMs,
      })
      state.status = status
      state.statusReason = reason
      state.lastActivityMs = lastActivity
    }

    const tasks = []
    for (const state of this.sessions.values()) {
      if (state.lastActivityMs === 0 || Date.now() - state.lastActivityMs > MAX_AGE_MS) continue
      const fallback = path.basename(state.file).replace(/\.jsonl$/, '')
      const key = state.sessionId || fallback
      const usage = state.tokens
      tasks.push({
        key: `session/${key}`,
        title: state.title || `LocalAgent ${key.slice(0, 8)}`,
        workspace: state.cwd,
        status: state.status,
        statusReason: state.statusReason,
        lastActivity: iso(state.lastActivityMs),
        startedAt: state.startedAt ? iso(state.startedAt) : null,
        sessionRef: key,
        events: state.events.slice(-30),
        meta: {
          sessionId: key,
          project: state.cwd || projectMap.get(state.projectDir) || state.projectDir,
          projectDir: state.projectDir,
          model: state.model || undefined,
          tokens: usage
            ? {
                input: Number(usage.input_tokens ?? usage.input ?? 0) || 0,
                output: Number(usage.output_tokens ?? usage.output ?? 0) || 0,
              }
            : undefined,
          turns: state.turns,
          lastDurationMs: state.lastDurationMs || undefined,
          entrypoint: state.entrypoint || undefined,
          version: state.version || undefined,
          file: state.file,
        },
      })
    }

    tasks.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))
    const limited = tasks.slice(0, limit)
    const noteParts = [`${limited.length} session(s)`]
    if (processInfo?.pid) noteParts.push(`daemon ${processInfo.pid}`)
    if (!alive.count) noteParts.push('not running')
    const rollup = rollupProvider(limited, { alive: alive.count > 0, note: noteParts.join(' · ') })
    return { id: this.id, label: this.label, status: rollup.status, note: rollup.note, alive: alive.count > 0, tasks: limited }
  }
}
