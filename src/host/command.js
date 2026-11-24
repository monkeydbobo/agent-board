/**
 * `/collab` chat command.
 *
 * The tool path is natural-language ("let Codex and Claude do X"); this command
 * is the explicit chat entry that never involves the model:
 *
 *   /collab --agents=codex,claude --rounds=2 add a hello() helper and a test
 *
 * It runs in the current session's working directory when that directory is
 * inside a git repository, otherwise in a scratch repository.
 */

const FLAGS = new Set(['agents', 'rounds', 'scratch'])

/**
 * Parse the raw input after `/collab`.
 * @param {string} rawInput
 * @returns {{task: string, participants: string[]|undefined, rounds: number|undefined, scratch: boolean}}
 */
export function parseCollabCommand(rawInput) {
  let text = String(rawInput ?? '').trim()
  let participants
  let rounds
  let scratch = false
  const flagPattern = /^--([a-z-]+)(?:=(\S+))?\s*/
  for (;;) {
    const match = text.match(flagPattern)
    if (!match) break
    const name = match[1]
    if (!FLAGS.has(name)) break
    let value = match[2]
    text = text.slice(match[0].length)
    if (value === undefined && (name === 'agents' || name === 'rounds')) {
      const parts = text.match(/^(\S+)\s*/)
      if (parts) {
        value = parts[1]
        text = text.slice(parts[0].length)
      }
    }
    if (name === 'agents' && value) participants = value.split(',').map((item) => item.trim()).filter(Boolean)
    if (name === 'rounds' && value) rounds = Number(value)
    if (name === 'scratch') scratch = true
  }
  return { task: text.trim(), participants, rounds, scratch }
}

function sessionRepo(agent) {
  try {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' ? cwd : ''
  } catch {
    return ''
  }
}

/**
 * Register `/collab` on the host command registry.
 * @param {object} commands
 * @param {{start: Function}} collab
 * @returns {() => void}
 */
export function registerCollabCommand(commands, collab) {
  return commands.register({
    name: 'collab',
    description: 'Start a multi-agent collaboration in this session’s repository',
    input: { hint: '[--agents=codex,claude] [--rounds=2] [--scratch] <task>' },
    async handler({ agent, rawInput }) {
      const parsed = parseCollabCommand(rawInput)
      if (parsed.task === '') {
        return {
          kind: 'error',
          text: '用法：/collab [--agents=codex,claude] [--rounds=2] [--scratch] <任务>\n例如：/collab --agents=codex,claude 给 add() 补一个测试并运行 node --test',
        }
      }
      const repo = parsed.scratch ? '' : sessionRepo(agent)
      let result = await collab.start({
        task: parsed.task,
        participants: parsed.participants,
        maxRounds: parsed.rounds,
        repo,
      })
      let usedScratch = parsed.scratch
      if (!result.ok && !parsed.scratch && /not a git repository|repo not found|git worktree failed/i.test(result.error ?? '')) {
        result = await collab.start({
          task: parsed.task,
          participants: parsed.participants,
          maxRounds: parsed.rounds,
          repo: '',
        })
        usedScratch = true
      }
      if (!result.ok) {
        const active = result.active?.length ? `\n运行中：${result.active.join(', ')}` : ''
        return { kind: 'error', text: `协作启动失败：${result.error}${active}` }
      }
      const run = collab.get(result.id)
      return {
        kind: 'success',
        text: [
          `协作已启动 ${result.id}${usedScratch ? '（临时仓库，当前目录不是 git 仓库）' : ''}`,
          `参与者：${run.participants.join(' → ')}`,
          `工作区：${run.workspace}`,
          `进度：/collab 看板「协作」条，或让 Agent 调用 collab_status({ id: "${result.id}" })`,
        ].join('\n'),
      }
    },
  })
}
