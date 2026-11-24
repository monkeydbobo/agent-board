/**
 * Model-facing tools over the board.
 *
 * `fleet_*` are read-only inspection tools. `collab_*` start and observe a
 * supervised multi-agent collaboration (implement → review → revise) in a
 * shared git worktree; they are the chat entry point for "have Codex and Claude
 * work on this together".
 */

import { formatRun } from './collab.js'

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
  const collabs = snapshot.collabs ?? []
  if (collabs.length > 0) {
    lines.push('Collaborations:')
    for (const run of collabs.slice(0, 6)) {
      lines.push(`- ${run.id} [${run.status}] ${run.title} · ${run.participants.join(' → ')} · ${run.currentPhase}`)
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
export function registerTools(tools, board, collab) {
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
      'collab_start',
      'Start a supervised multi-agent collaboration in the background. The first participant implements in a shared git worktree, the second reviews the diff, and revisions loop until approved or maxRounds. Use when the user asks two or more local agents (Codex, Claude Code, LocalAgent, Cursor) to work on one task together. Returns immediately with a run id; poll with collab_status.',
      {
        task: { type: 'string', required: true, description: 'The work item, with acceptance criteria and constraints. 1–12000 chars.' },
        repo: { type: 'string', required: false, description: 'Absolute path to a git repository. Omit to create a scratch repository under ~/agent-workspaces.' },
        participants: {
          type: 'array',
          required: false,
          items: { type: 'string', enum: ['codex', 'claude', 'localagent', 'cursor'] },
          description: 'Ordered participants: the first implements, the second reviews. Default is codex then claude.',
        },
        maxRounds: { type: 'integer', required: false, description: 'Implementation/review rounds, 1–5 (default 2).' },
        base: { type: 'string', required: false, description: 'Git revision to branch from; defaults to HEAD.' },
      },
      async (args) => {
        const result = await collab.start(args)
        if (!result.ok) {
          const active = result.active?.length ? ` (active: ${result.active.join(', ')})` : ''
          return `Collaboration not started: ${result.error}${active}`
        }
        const run = collab.get(result.id)
        return `Collaboration started.\n${formatRun(run, true)}\n\nPoll with collab_status({ id: "${result.id}" }); open the Agent board panel to watch it.`
      },
    ),
    textTool(
      'collab_status',
      'Read one collaboration run: status, rounds, phases, per-step summaries, and the latest log lines. Read-only.',
      {
        id: { type: 'string', required: false, description: 'Collaboration id. Omit to read the most recent run.' },
        limit: { type: 'integer', required: false, description: 'Log lines to return (default 15).' },
      },
      async (args) => {
        const run = args.id ? collab.get(args.id) : collab.list(1)[0]
        if (!run) return 'No collaboration runs yet.'
        return formatRun(run, true)
      },
    ),
    textTool(
      'collab_list',
      'List recent collaboration runs with status, participants, phase, and verdict. Read-only.',
      {},
      async () => {
        const runs = collab.list(10)
        if (runs.length === 0) return 'No collaboration runs yet. Start one with collab_start.'
        return runs.map((run) => formatRun(run, false)).join('\n\n')
      },
    ),
    textTool(
      'collab_stop',
      'Stop a running collaboration and terminate its current agent process. The shared worktree is kept for inspection.',
      {
        id: { type: 'string', required: true, description: 'Collaboration id.' },
      },
      async (args) => {
        const result = await collab.stop(args.id)
        if (!result.ok) return `Collaboration not stopped: ${result.error}`
        return `Stopped ${result.id}. The worktree is kept for inspection.`
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
