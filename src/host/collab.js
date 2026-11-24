/**
 * Multi-agent collaboration runner.
 *
 * The board observes agents; this runner makes them work together. It is a
 * supervisor/blackboard pattern rather than a peer-to-peer protocol: one agent
 * implements in a shared git worktree, the next reviews the diff, and the loop
 * repeats with the review as feedback. Every step is a headless CLI call, so
 * the participants keep their own auth, models, and session logs — and the
 * board keeps observing them as ordinary sessions on top.
 *
 * Roles:
 *   participants[0] = implementer (workspace-write)
 *   participants[1] = reviewer (read-only; receives the diff in its prompt)
 *   participants[2..] = reserved for follow-up rounds (v1 appends them to the
 *                       reviewer context instead of summoning another process)
 */

import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { ensureDir, expandHome, readJsonSafe, statSafe, writeJsonAtomic } from './util/fsx.js'
import { iso, summarize } from './util/text.js'

const PARTICIPANTS = ['codex', 'claude', 'localagent']
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_PHASE_OUTPUT = 200 * 1024

function clamp(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function normalizeConfig(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    workspaceRoot: expandHome(raw.workspaceRoot ?? '~/agent-workspaces'),
    maxConcurrent: clamp(raw.maxConcurrent, 1, 1, 3),
    maxRounds: clamp(raw.maxRounds, 2, 1, 5),
    stepTimeoutSeconds: clamp(raw.stepTimeoutSeconds, 900, 60, 3600),
    maxDiffBytes: clamp(raw.maxDiffBytes, 60000, 10000, 200000),
    defaultParticipants: Array.isArray(raw.defaultParticipants) && raw.defaultParticipants.length > 0
      ? raw.defaultParticipants
      : ['codex', 'claude'],
  }
}

function newId() {
  return `clb_${crypto.randomBytes(5).toString('hex')}`
}

function cappedAppend(current, chunk) {
  const next = current + String(chunk)
  return next.length > MAX_OUTPUT_BYTES ? next.slice(0, MAX_OUTPUT_BYTES) : next
}

/**
 * Run one CLI step to completion.
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function spawnStep(spec, deps = {}) {
  const { command, args = [], cwd, stdin = '', env = {}, timeoutMs = 900000, onChild } = spec
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false })
      return
    }
    onChild?.(child)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, 3000).unref?.()
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => { stdout = cappedAppend(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = cappedAppend(stderr, chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: cappedAppend(stderr, error?.message ?? error), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
    try {
      child.stdin.end(stdin)
    } catch {
      /* the process may have exited already */
    }
  })
}

/** Parse Codex `exec --json` output. */
export function parseCodexOutput(stdout) {
  const messages = []
  const tools = []
  for (const line of String(stdout ?? '').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    let record
    try {
      record = JSON.parse(text)
    } catch {
      continue
    }
    if (record?.type === 'item.completed' && record.item) {
      if (record.item.type === 'agent_message' && typeof record.item.text === 'string') messages.push(record.item.text)
      if (record.item.type === 'command_execution') tools.push(summarize(record.item.command ?? 'command', 120))
    }
  }
  return { text: messages.join('\n').trim(), tools }
}

/** Parse Claude Code `stream-json` output. */
export function parseClaudeOutput(stdout) {
  const texts = []
  const tools = []
  let result = ''
  for (const line of String(stdout ?? '').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    let record
    try {
      record = JSON.parse(text)
    } catch {
      continue
    }
    if (record?.type === 'result' && typeof record.result === 'string') result = record.result
    if (record?.type === 'assistant' && Array.isArray(record.message?.content)) {
      for (const block of record.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        if (block?.type === 'tool_use') tools.push(String(block.name ?? 'tool'))
      }
    }
  }
  return { text: (result || texts.join('\n')).trim(), tools }
}

/** Parse LocalAgent `--output-format json|stream-json` output. */
export function parseLocalAgentOutput(stdout) {
  const texts = []
  let result = ''
  const consume = (record) => {
    if (!record || typeof record !== 'object') return
    if (record.type === 'result' && typeof record.content === 'string') result = record.content
    if (record.type === 'message' && typeof record.text === 'string') texts.push(record.text)
  }
  const raw = String(stdout ?? '').trim()
  if (raw.startsWith('[')) {
    try {
      const list = JSON.parse(raw)
      if (Array.isArray(list)) for (const item of list) consume(item)
      return { text: (result || texts.join('\n')).trim(), tools: [] }
    } catch {
      /* fall through to line parsing */
    }
  }
  for (const line of raw.split('\n')) {
    try {
      consume(JSON.parse(line))
    } catch {
      /* skip */
    }
  }
  return { text: (result || texts.join('\n')).trim(), tools: [] }
}

/** Parse provider-specific stdout into the text the next phase consumes. */
export function parseProviderOutput(participant, stdout) {
  if (participant === 'codex') return parseCodexOutput(stdout)
  if (participant === 'claude') return parseClaudeOutput(stdout)
  if (participant === 'localagent') return parseLocalAgentOutput(stdout)
  return { text: String(stdout ?? '').trim(), tools: [] }
}

/**
 * Extract the review JSON object from a reviewer's prose.
 * The reviewer is asked for one JSON line; models sometimes wrap it in a
 * fence or add commentary, so search every `"verdict"` anchor.
 */
export function parseReview(text) {
  const source = String(text ?? '')
  const verdicts = []
  let index = source.indexOf('"verdict"')
  while (index !== -1) {
    const start = source.lastIndexOf('{', index)
    if (start !== -1) {
      let depth = 0
      let inString = false
      let escape = false
      for (let cursor = start; cursor < source.length; cursor += 1) {
        const char = source[cursor]
        if (inString) {
          if (escape) escape = false
          else if (char === '\\') escape = true
          else if (char === '"') inString = false
          continue
        }
        if (char === '"') inString = true
        else if (char === '{') depth += 1
        else if (char === '}') {
          depth -= 1
          if (depth === 0) {
            const candidate = source.slice(start, cursor + 1)
            try {
              const parsed = JSON.parse(candidate)
              if (parsed && typeof parsed.verdict === 'string') verdicts.push(parsed)
            } catch {
              /* not JSON */
            }
            break
          }
        }
      }
    }
    index = source.indexOf('"verdict"', index + 1)
  }
  const parsed = verdicts.at(-1)
  if (!parsed) {
    const lower = source.toLowerCase()
    const approve = /\bapprove[ds]?\b/.test(lower) && !/\brevise[ds]?\b/.test(lower)
    return {
      verdict: approve ? 'approve' : 'revise',
      summary: summarize(source, 240) || 'reviewer did not return JSON',
      issues: [],
      tests: '',
      parsed: false,
    }
  }
  const verdict = /approve|lgtm|pass|accepted|ok/i.test(parsed.verdict) ? 'approve' : 'revise'
  return {
    verdict,
    summary: summarize(parsed.summary ?? '', 300) || (verdict === 'approve' ? 'approved' : 'changes requested'),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map((issue) => summarize(issue, 300)).slice(0, 12) : [],
    tests: summarize(parsed.tests ?? '', 300),
    parsed: true,
  }
}

/** Prompt for the implementer. */
export function buildImplementPrompt(run, previousReview) {
  const reviewer = run.participants[1] ?? '另一名评审 Agent'
  const feedback = previousReview
    ? `\n## 上一轮评审（必须逐条处理）\n${previousReview.slice(0, 6000)}\n`
    : ''
  return `# 多 Agent 协作 · 实现阶段（第 ${run.round} 轮）

## 任务
${run.task}

## 环境
- 工作目录：${run.workspace}
- Git 分支：${run.branch || '(scratch)'}
- 你是实现者：${run.participants[0]}
- 评审者：${reviewer}
${feedback}
## 规则
1. 只修改当前工作目录内的文件；不要 \`git commit\`、\`git push\`、切换分支。
2. 先读 \`.agent-board/task.md\`，再实现任务。
3. 完成后把实现说明写到 \`.agent-board/implementation-round-${run.round}.md\`，包含：改了哪些文件、跑了哪些测试、结果如何、遗留问题。
4. 如果任务无法完成，在实现说明里写清阻塞原因；不要假装完成。
5. 不要修改 \`.agent-board/\` 之外的无关文件。
6. 不要修改或删除 \`.agent-board/\` 下的任务文件。

只关注任务本身，完成后停止。`
}

/** Prompt for the reviewer. */
export function buildReviewPrompt(run, diff, implementation) {
  return `# 多 Agent 协作 · 评审阶段（第 ${run.round} 轮）

## 任务
${run.task}

## 实现者说明
${implementation || '(实现者没有写说明文件)'}

## 变更（git diff，可能被截断）
\`\`\`diff
${diff}
\`\`\`

## 评审要求
1. 只读评审，不要修改任何文件。
2. 检查：是否满足任务、是否有明显 bug 或安全问题、测试是否可信、是否有越界改动。
3. 如果 diff 为空或无法验证，判为 revise。
4. 在最后单独输出一个 JSON 对象（不要省略字段）：
{"verdict":"approve","summary":"一句话结论","issues":["具体问题"],"tests":"你对测试的判断"}
verdict 只能是 approve 或 revise。

只输出评审与最后的 JSON。`
}

/**
 * The collaboration runner.
 *
 * `exec` and `git` are injectable so tests can drive the state machine without
 * spawning real agents.
 */
export class CollabRunner {
  constructor({ board, config = {}, exec, git } = {}) {
    this.board = board
    this.config = normalizeConfig(config)
    this.runs = new Map()
    this.children = new Set()
    this.exec = exec ?? ((spec) => spawnStep(spec, { onChild: (child) => this.children.add(child) }))
    this.git = git ?? ((args, cwd) => gitExec(args, cwd))
    this.dataDir = path.join(board?.config?.dataDir ?? expandHome('~/.dsh/agent-board'), 'collabs')
    this.persistTimers = new Map()
    this.loadPersisted().catch((error) => {
      console.warn('[agent-board] collaboration history load failed:', error?.message ?? error)
    })
  }

  /** Restore recent runs so the board keeps its collaboration history. */
  async loadPersisted() {
    let files
    try {
      files = await fs.readdir(this.dataDir)
    } catch {
      return
    }
    const recent = files.filter((name) => name.endsWith('.json')).sort().slice(-30)
    for (const name of recent) {
      const stored = await readJsonSafe(path.join(this.dataDir, name))
      if (!stored?.id || this.runs.has(stored.id)) continue
      if (stored.status === 'running' || stored.status === 'queued') {
        stored.status = 'stopped'
        stored.error = stored.error || 'interrupted by plugin reload'
        stored.currentPhase = 'stopped'
      }
      this.runs.set(stored.id, stored)
      this.board?.upsertCollab(stored)
    }
  }

  /** Debounced per-run persistence under the board data directory. */
  persist(run) {
    if (this.persistTimers.has(run.id)) return
    const timer = setTimeout(() => {
      this.persistTimers.delete(run.id)
      writeJsonAtomic(path.join(this.dataDir, `${run.id}.json`), this.publicRun(run)).catch(() => {})
    }, 700)
    this.persistTimers.set(run.id, timer)
    timer.unref?.()
  }

  get activeCount() {
    return [...this.runs.values()].filter((run) => run.status === 'running' || run.status === 'queued').length
  }

  /**
   * Start one collaboration. Resolves after the workspace exists; the agents
   * run in the background.
   */
  async start(input = {}) {
    if (!this.config.enabled) return { ok: false, error: 'collab-disabled' }
    const task = String(input.task ?? '').trim()
    if (task === '') return { ok: false, error: 'task-required' }
    if (task.length > 12000) return { ok: false, error: 'task-too-long' }
    if (this.activeCount >= this.config.maxConcurrent) {
      const active = [...this.runs.values()].filter((run) => run.status === 'running').map((run) => run.id)
      return { ok: false, error: 'busy', active }
    }

    const participants = normalizeParticipants(input.participants ?? this.config.defaultParticipants)
    if (participants.length === 0) return { ok: false, error: 'participant-required' }
    if (participants.length > 2) return { ok: false, error: 'v1-supports-two-participants' }

    // Validate the repository before creating a run, so a /collab command can
    // fall back to a scratch workspace without leaving a failed record behind.
    if (input.repo) {
      const repoPath = expandHome(String(input.repo))
      const stat = await statSafe(repoPath)
      if (!stat?.isDirectory()) return { ok: false, error: `repo not found: ${repoPath}` }
      const top = await this.git(['-C', repoPath, 'rev-parse', '--show-toplevel'])
      if (!top.ok) return { ok: false, error: `not a git repository: ${repoPath}` }
    }

    const run = {
      id: newId(),
      task,
      title: summarize(task, 80),
      repo: input.repo ? expandHome(String(input.repo)) : '',
      base: input.base ? String(input.base) : '',
      workspace: '',
      branch: '',
      participants,
      status: 'running',
      round: 1,
      maxRounds: clamp(input.maxRounds ?? this.config.maxRounds, 2, 1, 5),
      phases: [],
      log: [],
      currentPhase: 'preparing',
      verdict: '',
      review: null,
      error: '',
      stopped: false,
      createdAt: iso(Date.now()),
      updatedAt: iso(Date.now()),
      endedAt: null,
    }
    this.runs.set(run.id, run)
    this.log(run, `collaboration created: ${participants.join(' → ')}`)

    try {
      await this.prepareWorkspace(run)
    } catch (error) {
      run.status = 'failed'
      run.error = `workspace: ${error?.message ?? error}`
      run.endedAt = iso(Date.now())
      this.log(run, run.error, { severity: 'error' })
      this.sync(run)
      return { ok: false, error: run.error, id: run.id }
    }

    this.sync(run)
    this.loop(run)
    return {
      ok: true,
      id: run.id,
      status: run.status,
      workspace: run.workspace,
      branch: run.branch,
      participants: run.participants,
      maxRounds: run.maxRounds,
    }
  }

  async prepareWorkspace(run) {
    await ensureDir(this.config.workspaceRoot)
    const workspace = path.join(this.config.workspaceRoot, run.id)
    await fs.rm(workspace, { recursive: true, force: true })
    await ensureDir(workspace)
    run.workspace = workspace

    let repoRoot = ''
    if (run.repo) {
      const stat = await statSafe(run.repo)
      if (!stat?.isDirectory()) throw new Error(`repo not found: ${run.repo}`)
      const top = await this.git(['-C', run.repo, 'rev-parse', '--show-toplevel'])
      if (!top.ok) throw new Error(`not a git repository: ${run.repo}`)
      repoRoot = top.stdout.trim()
    }

    if (repoRoot) {
      const base = run.base || 'HEAD'
      const resolved = await this.git(['-C', repoRoot, 'rev-parse', '--verify', `${base}^{commit}`])
      if (!resolved.ok) throw new Error(`base revision not found: ${base}`)
      run.base = resolved.stdout.trim()
      const branch = `collab/${run.id.slice(4)}`
      const created = await this.git(['-C', repoRoot, 'worktree', 'add', '-b', branch, workspace, run.base])
      if (!created.ok) throw new Error(`git worktree failed: ${created.stderr.trim() || created.stdout.trim()}`)
      run.repo = repoRoot
      run.branch = branch
    } else {
      const initialized = await this.git(['init', '-q'], workspace)
      if (!initialized.ok) throw new Error(`git init failed: ${initialized.stderr}`)
      await fs.writeFile(path.join(workspace, 'README.md'), `# Collaboration ${run.id}\n\n${run.task}\n`, 'utf8')
      await this.git(['add', '-A'], workspace)
      await this.git(['-c', 'user.name=agent-board', '-c', 'user.email=agent-board@local', 'commit', '-q', '-m', 'collaboration baseline'], workspace)
      run.branch = '(scratch)'
    }

    const gitDir = await this.git(['rev-parse', '--git-dir'], workspace)
    if (gitDir.ok) {
      const excludePath = path.isAbsolute(gitDir.stdout.trim())
        ? path.join(gitDir.stdout.trim(), 'info', 'exclude')
        : path.join(workspace, gitDir.stdout.trim(), 'info', 'exclude')
      await ensureDir(path.dirname(excludePath))
      await fs.appendFile(excludePath, '\n.agent-board/\n', 'utf8').catch(() => {})
    }

    const boardDir = path.join(workspace, '.agent-board')
    await ensureDir(boardDir)
    await fs.writeFile(path.join(boardDir, 'task.md'), `# ${run.title}\n\n## 任务\n\n${run.task}\n\n## 参与者\n\n${run.participants.join(' → ')}\n`, 'utf8')
    await fs.writeFile(path.join(boardDir, 'protocol.md'), [
      '# Collaboration protocol',
      '',
      '- 实现者只改工作区文件，不 commit/push。',
      '- 每轮实现后写 implementation-round-N.md。',
      '- 评审者只读，输出 verdict JSON。',
      '- 评审提出 revise 时，下一轮实现者逐条处理。',
      '',
    ].join('\n'), 'utf8')
    this.log(run, `workspace ready: ${workspace}`)
  }

  async loop(run) {
    try {
      const implementer = run.participants[0]
      const reviewer = run.participants[1]
      let previousReview = ''
      for (let round = 1; round <= run.maxRounds; round += 1) {
        run.round = round
        await this.phase(run, implementer, round === 1 ? 'implement' : 'revise', buildImplementPrompt(run, previousReview))
        if (!reviewer) {
          run.verdict = 'no-review'
          break
        }
        const diff = await this.captureDiff(run)
        const implementation = await this.readImplementation(run, round)
        await this.phase(run, reviewer, 'review', buildReviewPrompt(run, diff, implementation))
        const phase = run.phases[run.phases.length - 1]
        const review = parseReview(phase.output)
        run.review = review
        run.verdict = review.verdict
        this.log(run, `review round ${round}: ${review.verdict} — ${review.summary}`, {
          severity: review.verdict === 'approve' ? 'info' : 'warn',
        })
        if (review.verdict === 'approve') break
        previousReview = [
          review.summary,
          ...review.issues.map((issue, index) => `${index + 1}. ${issue}`),
          review.tests ? `tests: ${review.tests}` : '',
        ].filter(Boolean).join('\n')
        if (round === run.maxRounds) break
      }
      if (run.stopped) {
        run.status = 'stopped'
      } else {
        run.status = 'done'
      }
    } catch (error) {
      if (run.stopped || error?.name === 'CollabStopped') {
        run.status = 'stopped'
      } else {
        run.status = 'failed'
        run.error = String(error?.message ?? error)
        this.log(run, `collaboration failed: ${run.error}`, { severity: 'error' })
      }
    } finally {
      run.currentPhase = run.status === 'stopped' ? 'stopped' : 'finished'
      run.endedAt = iso(Date.now())
      await this.writeResult(run).catch(() => {})
      this.sync(run)
    }
  }

  async phase(run, participant, role, prompt) {
    if (run.stopped) throw new CollabStopped()
    const index = run.phases.length + 1
    const phase = {
      index,
      actor: participant,
      role,
      status: 'running',
      startedAt: iso(Date.now()),
      endedAt: null,
      summary: '',
      exitCode: null,
      timedOut: false,
      output: '',
    }
    run.phases.push(phase)
    run.currentPhase = `${role}:${participant}`
    this.log(run, `phase ${index} ${role} → ${participant}`, { actor: participant })
    this.sync(run)

    const spec = buildStepCommand(participant, role, prompt, run)
    spec.timeoutMs = this.config.stepTimeoutSeconds * 1000
    const result = await this.exec(spec)
    phase.exitCode = result.code
    phase.timedOut = Boolean(result.timedOut)
    phase.endedAt = iso(Date.now())
    const parsed = parseProviderOutput(participant, result.stdout)
    // Review parsing needs the provider's final text, not the raw stream-json
    // envelope (where the review JSON is escaped inside a `result` field).
    phase.output = String(parsed.text || result.stdout || '').slice(0, MAX_PHASE_OUTPUT)
    phase.summary = summarize(parsed.text || result.stderr || `${participant} exited ${result.code}`, 240)

    if (run.stopped) {
      phase.status = 'stopped'
      phase.summary = 'stopped by user'
      this.log(run, `phase ${index} stopped`, { severity: 'warn', actor: participant })
      this.sync(run)
      throw new CollabStopped()
    }
    if (result.timedOut || result.code !== 0) {
      phase.status = 'failed'
      phase.summary = result.timedOut
        ? `${participant} timed out after ${this.config.stepTimeoutSeconds}s`
        : phase.summary || `${participant} exited ${result.code}`
      this.log(run, `phase ${index} failed: ${phase.summary}`, { severity: 'error', actor: participant })
      this.sync(run)
      throw new Error(`phase ${role} (${participant}) failed: ${phase.summary}`)
    }

    phase.status = 'done'
    this.log(run, `phase ${index} ${role} done: ${phase.summary}`, { actor: participant })
    await this.persistPhase(run, phase).catch(() => {})
    this.sync(run)
    return phase
  }

  async persistPhase(run, phase) {
    const file = path.join(run.workspace, '.agent-board', `phase-${String(phase.index).padStart(2, '0')}-${phase.role}.txt`)
    await fs.writeFile(file, `${phase.summary}\n\n---\n\n${phase.output}`, 'utf8')
  }

  async readImplementation(run, round) {
    try {
      return await fs.readFile(path.join(run.workspace, '.agent-board', `implementation-round-${round}.md`), 'utf8')
    } catch {
      return ''
    }
  }

  async captureDiff(run) {
    const maxBytes = this.config.maxDiffBytes
    await this.git(['add', '-N', '.'], run.workspace)
    const diff = await this.git(['diff', '--no-color', '--', '.'], run.workspace)
    const status = await this.git(['status', '--porcelain'], run.workspace)
    let text = diff.stdout || ''
    if (status.stdout.trim() !== '') text = `${text}\n\n## git status\n${status.stdout}`
    if (text.trim() === '') return '(no changes detected)'
    if (text.length > maxBytes) {
      return `${text.slice(0, maxBytes)}\n\n… (diff truncated at ${maxBytes} bytes)`
    }
    return text
  }

  async writeResult(run) {
    if (!run.workspace) return
    const value = {
      id: run.id,
      task: run.task,
      status: run.status,
      participants: run.participants,
      branch: run.branch,
      workspace: run.workspace,
      repo: run.repo,
      rounds: run.round,
      verdict: run.verdict,
      review: run.review,
      error: run.error,
      phases: run.phases.map((phase) => ({
        index: phase.index,
        actor: phase.actor,
        role: phase.role,
        status: phase.status,
        startedAt: phase.startedAt,
        endedAt: phase.endedAt,
        summary: phase.summary,
        exitCode: phase.exitCode,
        timedOut: phase.timedOut,
      })),
      endedAt: run.endedAt,
    }
    await fs.writeFile(path.join(run.workspace, '.agent-board', 'result.json'), JSON.stringify(value, null, 2), 'utf8')
  }

  log(run, text, options = {}) {
    const entry = {
      at: iso(Date.now()),
      actor: options.actor ?? 'system',
      severity: options.severity ?? 'info',
      text: summarize(text, 400),
    }
    run.log.push(entry)
    if (run.log.length > 200) run.log.splice(0, run.log.length - 200)
    run.updatedAt = entry.at
    this.board?.upsertCollab?.(this.publicRun(run))
    this.persist(run)
    if (entry.severity === 'error' || options.announce === true) {
      this.board?.addCollabEvent?.(run.id, entry.text, entry.severity, run.title)
    }
  }

  sync(run) {
    run.updatedAt = iso(Date.now())
    this.board?.upsertCollab?.(this.publicRun(run))
    this.persist(run)
  }

  publicRun(run) {
    return {
      id: run.id,
      title: run.title,
      task: run.task.slice(0, 4000),
      repo: run.repo,
      workspace: run.workspace,
      branch: run.branch,
      participants: run.participants,
      status: run.status,
      round: run.round,
      maxRounds: run.maxRounds,
      currentPhase: run.currentPhase,
      verdict: run.verdict,
      review: run.review,
      error: run.error,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      endedAt: run.endedAt,
      phases: run.phases.map((phase) => ({
        index: phase.index,
        actor: phase.actor,
        role: phase.role,
        status: phase.status,
        startedAt: phase.startedAt,
        endedAt: phase.endedAt,
        summary: phase.summary,
        exitCode: phase.exitCode,
        timedOut: phase.timedOut,
      })),
      log: run.log.slice(-40),
    }
  }

  get(id) {
    return this.runs.get(String(id ?? ''))
  }

  list(limit = 10) {
    return [...this.runs.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
  }

  async stop(id) {
    const run = this.get(id)
    if (!run) return { ok: false, error: 'not-found' }
    if (run.status !== 'running' && run.status !== 'queued') return { ok: false, error: 'not-running' }
    run.stopped = true
    run.status = 'stopped'
    run.currentPhase = 'stopped'
    this.killChildren()
    this.log(run, 'stopped by user', { severity: 'warn' })
    this.sync(run)
    return { ok: true, id: run.id }
  }

  stopAll() {
    for (const run of this.runs.values()) {
      if (run.status === 'running') {
        run.stopped = true
        run.status = 'stopped'
      }
    }
    this.killChildren(0)
    this.children.clear()
  }

  /** Terminate tracked CLI processes, escalating to SIGKILL when needed. */
  killChildren(graceMs = 2000) {
    const children = [...this.children]
    for (const child of children) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    if (graceMs === 0) {
      for (const child of children) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
      return
    }
    const timer = setTimeout(() => {
      for (const child of children) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }, graceMs)
    timer.unref?.()
  }
}

class CollabStopped extends Error {
  constructor() {
    super('collaboration stopped')
    this.name = 'CollabStopped'
  }
}

function normalizeParticipants(value) {
  const list = Array.isArray(value) ? value : [value]
  const participants = []
  for (const item of list) {
    const id = String(item ?? '').trim().toLowerCase()
    if (id === '') continue
    if (!PARTICIPANTS.includes(id)) return []
    if (!participants.includes(id)) participants.push(id)
  }
  return participants
}

/** Build the headless CLI invocation for one participant/phase. */
export function buildStepCommand(participant, role, prompt, run) {
  const reviewer = role === 'review'
  if (participant === 'codex') {
    return {
      command: process.env.AGENT_BOARD_CODEX_BIN || 'codex',
      args: [
        'exec', '--json', '--skip-git-repo-check',
        '-s', reviewer ? 'read-only' : 'workspace-write',
        '-C', run.workspace, '-',
      ],
      cwd: run.workspace,
      stdin: prompt,
    }
  }
  if (participant === 'claude') {
    return {
      command: process.env.AGENT_BOARD_CLAUDE_BIN || 'claude',
      args: [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', reviewer ? 'plan' : 'acceptEdits',
        '--max-turns', '20',
      ],
      cwd: run.workspace,
    }
  }
  if (participant === 'localagent') {
    return {
      command: process.env.AGENT_BOARD_LOCALAGENT_BIN || 'localagent',
      args: [
        '-q', prompt,
        '--cwd', run.workspace,
        '--output-format', 'stream-json',
        '--approval-mode', reviewer ? 'plan' : 'auto',
      ],
      cwd: run.workspace,
    }
  }
  if (participant === 'cursor') {
    return {
      command: process.env.AGENT_BOARD_CURSOR_BIN || 'agent',
      args: ['-p', prompt, '--output-format', 'stream-json'],
      cwd: run.workspace,
    }
  }
  throw new Error(`unsupported participant: ${participant}`)
}

function gitExec(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? error?.message ?? ''),
      })
    })
  })
}

/** One-line summary used by the tool output. */
export function formatRun(run, detail = false) {
  if (!run) return 'collaboration not found'
  const lines = [
    `${run.id} — ${run.title}`,
    `status: ${run.status}${run.verdict ? ` · verdict: ${run.verdict}` : ''} · round ${run.round}/${run.maxRounds}`,
    `participants: ${run.participants.join(' → ')}`,
    `phase: ${run.currentPhase}`,
    `workspace: ${run.workspace || '-'}`,
    `branch: ${run.branch || '-'}`,
  ]
  if (run.error) lines.push(`error: ${run.error}`)
  if (detail) {
    lines.push('phases:')
    for (const phase of run.phases) {
      lines.push(`- ${phase.index}. ${phase.role} ${phase.actor} [${phase.status}] ${phase.summary || ''}`)
    }
    lines.push('log:')
    for (const entry of run.log.slice(-15)) lines.push(`- ${entry.at} [${entry.actor}] ${entry.text}`)
  } else {
    const last = run.log[run.log.length - 1]
    if (last) lines.push(`last: ${last.text}`)
  }
  return lines.join('\n')
}
