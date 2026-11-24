/**
 * Grok Bot adapter.
 *
 * Grok Bot is a cloud chat app, but its Electron client mirrors conversations
 * locally under
 *
 *   ~/Library/Application Support/Grok Bot/sand-client-persistence/*.blob
 *
 * Each blob is JSON: `{ schemaVersion, value }`. Conversation blobs carry
 * `value.entries`, an ordered list of user messages, streamed assistant
 * `send-message` records, widgets, attachments, and `event` records. Agent
 * profile blobs carry `value.rows` (id, name, description, repository path).
 *
 * The adapter folds those entries into board tasks. The local-exec daemon in
 * `~/.grokbot` is reported as metadata, not as a fake task.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { expandHome, listFiles, readJsonSafe } from '../util/fsx.js'
import { deriveTaskStatus, rollupProvider } from '../status.js'
import { iso, summarize, stableId } from '../util/text.js'
import { countProcesses, PROCESS_PATTERNS } from '../util/proc.js'

const STALL_MS = 10 * 60 * 1000
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_BLOBS = 80
const CACHE_LIMIT = 120

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function workspaceOf(text) {
  const match = String(text ?? '').match(/(\/Users\/[^\s，。；：:()（）"'`]+)/)
  return match ? match[1] : ''
}

function userTitle(text) {
  const cleaned = String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return summarize(cleaned, 90)
}

/**
 * Fold one Grok conversation blob into a board-shaped conversation.
 * Pure; exported for tests.
 *
 * @param {any} value blob `value`
 * @param {Map<string, any>} agents agent profiles by id
 */
export function parseGrokConversation(value, agents = new Map()) {
  const entries = Array.isArray(value?.entries) ? value.entries.filter(object) : []
  if (entries.length === 0) return undefined
  const events = []
  let firstUser = ''
  let firstAssistant = ''
  let firstAt = 0
  let lastAt = 0
  let lastKind = ''
  let lastRole = ''
  let agent = undefined
  let users = 0
  let assistant = 0
  let widgets = 0
  let attachments = 0
  let workspace = ''

  for (const entry of entries) {
    const at = Number(entry.timestampMs) || 0
    if (at > 0) {
      firstAt = firstAt === 0 ? at : Math.min(firstAt, at)
      lastAt = Math.max(lastAt, at)
    }
    if (entry.author && typeof entry.author.id === 'string') {
      agent = agents.get(entry.author.id) ?? entry.author
    }
    lastKind = String(entry.kind ?? '')
    lastRole = String(entry.role ?? '')

    if (entry.kind === 'message' && entry.role === 'user') {
      const text = String(entry.content ?? '')
      if (firstUser === '') firstUser = text
      users += 1
      if (workspace === '') workspace = workspaceOf(text)
      events.push({ at, kind: 'run.turn', severity: 'info', summary: `user: ${summarize(text, 200)}` })
      continue
    }

    if (entry.kind === 'send-message') {
      const message = object(entry.message)
      if (message?.type === 'text' && typeof message.content === 'string') {
        if (firstAssistant === '') firstAssistant = message.content
        assistant += 1
        events.push({ at, kind: 'run.message', severity: 'info', summary: `assistant: ${summarize(message.content, 220)}` })
      } else if (message?.type === 'widget') {
        widgets += 1
        const prompt = object(message.widget)?.prompt
        if (typeof prompt === 'string' && prompt !== '') {
          events.push({ at, kind: 'run.message', severity: 'info', summary: `assistant: ${summarize(prompt, 180)}` })
        }
      }
      continue
    }

    if (entry.kind === 'message' && entry.role === 'assistant') {
      const text = String(entry.content ?? '')
      if (firstAssistant === '') firstAssistant = text
      assistant += 1
      events.push({ at, kind: 'run.message', severity: 'info', summary: `assistant: ${summarize(text, 220)}` })
      continue
    }

    if (entry.kind === 'user-attachment') {
      attachments += 1
      lastKind = 'message'
      lastRole = 'user'
      events.push({ at, kind: 'run.tool', severity: 'info', summary: `attachment: ${summarize(entry.file_name ?? entry.kind, 100)}` })
      continue
    }

    if (entry.kind === 'event') {
      const event = object(entry.event) ?? {}
      const type = String(event.type ?? 'event')
      const action = event.action ? ` ${event.action}` : ''
      events.push({ at, kind: 'session.meta', severity: 'info', summary: `event: ${type}${action}` })
    }
  }

  const agentName = typeof agent?.name === 'string' ? agent.name : ''
  const agentDescription = typeof agent?.description === 'string' ? agent.description : ''
  if (workspace === '') workspace = workspaceOf(agentDescription)
  const title = firstUser !== ''
    ? userTitle(firstUser)
    : agentName !== ''
      ? agentName
      : userTitle(firstAssistant) || 'Grok conversation'

  const open = lastKind === 'message' && lastRole === 'user'
  return {
    title,
    agentName,
    agentId: typeof agent?.id === 'string' ? agent.id : '',
    agentDescription: summarize(agentDescription, 200),
    workspace,
    events: events.slice(-120),
    firstAt,
    lastAt,
    lastKind,
    lastRole,
    open,
    users,
    assistant,
    widgets,
    attachments,
    entries: entries.length,
  }
}

export class GrokBotAdapter {
  constructor(config = {}) {
    this.id = 'grokbot'
    this.label = 'Grok Bot'
    this.root = expandHome(config.root ?? '~/.grokbot')
    this.persistence = expandHome(config.persistence ?? '~/Library/Application Support/Grok Bot/sand-client-persistence')
    this.statusFile = path.join(path.dirname(this.persistence), 'desktop-status.json')
    this.supervisorFile = path.join(this.root, 'local-exec-supervisor.json')
    /** @type {Map<string, {mtimeMs: number, size: number, value: any}>} */
    this.cache = new Map()
    /** @type {Map<string, any>} */
    this.agents = new Map()
  }

  async readBlob(file) {
    const cached = this.cache.get(file.path)
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) return cached.value
    let value = { ok: false }
    try {
      const raw = await fs.readFile(file.path)
      value = { ok: true, data: JSON.parse(raw.toString('utf8')) }
    } catch {
      value = { ok: false }
    }
    this.cache.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, value })
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    return value
  }

  async poll({ config }) {
    const alive = await countProcesses(PROCESS_PATTERNS.grokbot)
    const limit = Math.max(10, Number(config?.maxTasksPerProvider ?? 40))
    const stallMs = Number(config?.stallSeconds ?? 600) * 1000 || STALL_MS
    const status = await readJsonSafe(this.statusFile)
    const supervisor = await readJsonSafe(this.supervisorFile)

    const blobs = await listFiles(this.persistence, {
      match: (name) => name.endsWith('.blob'),
      limit: MAX_BLOBS,
      depth: 1,
    })

    // Agent profile blobs are independent of a conversation's recency; read all
    // small ones every poll through the same mtime cache so renaming an agent
    // reaches the board without a restart.
    for (const file of blobs) {
      const parsed = await this.readBlob(file)
      if (!parsed.ok) continue
      const rows = Array.isArray(parsed.data?.value?.rows) ? parsed.data.value.rows : []
      for (const row of rows) {
        if (row && typeof row.id === 'string') this.agents.set(row.id, row)
      }
    }

    const conversations = []
    for (const file of blobs) {
      const parsed = await this.readBlob(file)
      if (!parsed.ok) continue
      const conversation = parseGrokConversation(parsed.data?.value, this.agents)
      if (conversation === undefined) continue
      conversations.push({
        ...conversation,
        key: stableId('grok', file.path),
        file: file.path,
        mtimeMs: file.mtimeMs,
        size: file.size,
      })
    }
    conversations.sort((a, b) => b.lastAt - a.lastAt)

    const tasks = []
    for (const conversation of conversations.slice(0, limit)) {
      // Persistence blobs are rewritten on app launch, so mtime is not an
      // activity signal; the entry timestamps are.
      const lastActivityMs = conversation.lastAt || conversation.firstAt || conversation.mtimeMs
      if (Date.now() - lastActivityMs > MAX_AGE_MS) continue
      const { status: taskStatus, reason } = deriveTaskStatus({
        lastActivityMs,
        open: conversation.open,
        alive: alive.count > 0,
        stallMs,
      })
      tasks.push({
        key: conversation.key,
        title: conversation.title,
        workspace: conversation.workspace,
        status: taskStatus,
        statusReason: reason,
        lastActivity: iso(lastActivityMs),
        startedAt: conversation.firstAt ? iso(conversation.firstAt) : null,
        sessionRef: conversation.key,
        events: conversation.events.slice(-30).map((event) => ({
          at: iso(event.at || conversation.lastAt),
          kind: event.kind,
          severity: event.severity,
          summary: event.summary,
        })),
        meta: {
          agent: conversation.agentName || undefined,
          agentId: conversation.agentId || undefined,
          description: conversation.agentDescription || undefined,
          appVersion: status?.appVersion,
          signedIn: typeof status?.signedIn === 'boolean' ? status.signedIn : undefined,
          entries: conversation.entries,
          users: conversation.users,
          assistant: conversation.assistant,
          widgets: conversation.widgets,
          attachments: conversation.attachments,
          file: conversation.file,
        },
      })
    }

    const noteParts = [`${tasks.length} conversation(s)`]
    if (status?.appVersion) noteParts.push(`v${status.appVersion}`)
    if (status?.signedIn === true) noteParts.push('signed in')
    if (supervisor?.pid) noteParts.push(`exec ${supervisor.pid}`)
    if (alive.count === 0) noteParts.push('not running')
    const rollup = rollupProvider(tasks, { alive: alive.count > 0, note: noteParts.join(' · ') })
    return { id: this.id, label: this.label, status: rollup.status, note: rollup.note, alive: alive.count > 0, tasks }
  }
}
