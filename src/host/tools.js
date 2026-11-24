/**
 * Model-facing read tools over the board.
 *
 * The dashboard is the primary surface; these tools let the "chief of staff"
 * agent (or any DSH session) ask the same questions without opening the page.
 * They are read-only: dispatch and interrupt stay out of this version.
 */

function age(isoValue) {
  const ms = Date.parse(isoValue ?? '')
  if (!Number.isFinite(ms)) return 'unknown'
  const delta = Math.max(0, Date.now() - ms)
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`
  return `${Math.round(delta / 86_400_000)}d ago`
}

function statusLine(snapshot) {
  const { stats, providers } = snapshot
  const lines = [
    `Agent Board — ${snapshot.generatedAt} (revision ${snapshot.revision}${snapshot.monitoring ? '' : ', monitoring paused'})`,
    `Tasks: ${stats.total} total · ${stats.running} running · ${stats.attention} need attention · ${stats.idle} idle · ${stats.done} done`,
    'Providers:',
  ]
  for (const provider of providers) {
    const note = provider.note ? ` — ${provider.note}` : ''
    lines.push(`- ${provider.label} [${provider.status}] ${provider.runningCount}/${provider.taskCount} task(s)${note}`)
  }
  const attention = snapshot.tasks.filter((task) => task.status === 'attention').slice(0, 10)
  if (attention.length > 0) {
    lines.push('Needs attention:')
    for (const task of attention) {
      const last = task.events[task.events.length - 1]?.summary ?? task.statusReason
      lines.push(`- ${task.id} · ${task.title} · ${task.statusReason} · ${age(task.lastActivity)} · ${last}`)
    }
  }
  const running = snapshot.tasks.filter((task) => task.status === 'running').slice(0, 10)
  if (running.length > 0) {
    lines.push('Running:')
    for (const task of running) {
      lines.push(`- ${task.id} · ${task.title} · ${age(task.lastActivity)}`)
    }
  }
  if (snapshot.tasks.length === 0) lines.push('No agent sessions were discovered yet.')
  return lines.join('\n')
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

function textTool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: TEXT_OUTPUT,
    async execute(args) {
      return { text: await run(args ?? {}) }
    },
  }
}

/**
 * Register `fleet_status`, `fleet_task`, and `fleet_refresh`.
 * @returns {() => void} disposer over every accepted registration
 */
export function registerTools(tools, board) {
  const disposers = []
  const definitions = [
    textTool(
      'fleet_status',
      'Summarize every local coding-agent session the Agent Board monitors: counts, each provider, what needs attention, and what is running. Read-only.',
      {
        provider: { type: 'string', required: false, description: 'Optional provider id filter: dsh, codex, claude, cursor, localagent, grokbot, antigravity.' },
        limit: { type: 'integer', required: false, description: 'Maximum tasks listed per section (default 10).' },
      },
      async (args) => {
        const snapshot = board.snapshot()
        if (args.provider) {
          snapshot.tasks = snapshot.tasks.filter((task) => task.provider === args.provider)
          snapshot.providers = snapshot.providers.filter((provider) => provider.id === args.provider)
        }
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 10))
        snapshot.tasks = snapshot.tasks.slice(0, limit)
        return statusLine(snapshot)
      },
    ),
    textTool(
      'fleet_task',
      'Read one monitored agent task: status, workspace, timing, metadata, and its most recent events. Read-only.',
      {
        taskId: { type: 'string', required: true, description: 'Board task id, for example codex:019e8c17-f889....' },
        limit: { type: 'integer', required: false, description: 'Maximum events returned (default 20).' },
      },
      async (args) => {
        const task = board.getTask(String(args.taskId ?? ''))
        if (!task) return `Task not found: ${args.taskId}\nKnown ids:\n${[...board.tasks.keys()].slice(0, 30).join('\n')}`
        const limit = Math.max(1, Math.min(80, Number(args.limit) || 20))
        const lines = [
          `${task.id} — ${task.title}`,
          `provider: ${task.providerLabel} · status: ${task.status} (${task.statusReason})${task.manual ? ' · manual override' : ''}`,
          `workspace: ${task.workspace || '-'}`,
          `session: ${task.sessionRef || '-'}`,
          `started: ${task.startedAt || '-'} · last activity: ${task.lastActivity || '-'} (${age(task.lastActivity)})`,
          `meta: ${JSON.stringify(task.meta)}`,
          'events:',
        ]
        for (const event of task.events.slice(-limit)) {
          lines.push(`- ${event.at ?? '-'} [${event.kind}] ${event.summary}`)
        }
        if (task.events.length === 0) lines.push('- no events observed yet')
        return lines.join('\n')
      },
    ),
    textTool(
      'fleet_refresh',
      'Force the Agent Board to poll every adapter now and return the refreshed summary. Read-only.',
      {},
      async () => {
        await board.tick(true)
        return statusLine(board.snapshot())
      },
    ),
  ]

  for (const definition of definitions) {
    try {
      const dispose = tools.register(definition)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      console.warn(`[agent-board] tool registration failed for ${definition.name}:`, error?.message ?? error)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
  }
}
