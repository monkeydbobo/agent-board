import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  CollabRunner,
  buildReviewPrompt,
  buildStepCommand,
  parseClaudeOutput,
  parseReview,
} from '../src/host/collab.js'
import { parseCollabCommand, registerCollabCommand } from '../src/host/command.js'

test('parseReview: accepts a fenced JSON block with commentary', () => {
  const text = 'Here is my review.\n\n```json\n{"verdict":"approve","summary":"looks good","issues":[],"tests":"credible"}\n```\n'
  const review = parseReview(text)
  assert.equal(review.verdict, 'approve')
  assert.equal(review.summary, 'looks good')
  assert.equal(review.tests, 'credible')
})

test('parseReview: revise verdict and issues', () => {
  const text = '{"verdict":"revise","summary":"missing test","issues":["no test for empty input"],"tests":"weak"}'
  const review = parseReview(text)
  assert.equal(review.verdict, 'revise')
  assert.deepEqual(review.issues, ['no test for empty input'])
})

test('parseReview: no JSON falls back to revise', () => {
  const review = parseReview('I could not evaluate the diff.')
  assert.equal(review.verdict, 'revise')
  assert.equal(review.parsed, false)
})

test('parsed Claude result text yields the review JSON', () => {
  const stdout = [
    '{"type":"system","subtype":"init","session_id":"s1"}',
    JSON.stringify({ type: 'result', subtype: 'success', result: '评审完成\n\n```json\n{"verdict":"approve","summary":"ok","issues":[],"tests":"present"}\n```' }),
  ].join('\n')
  const review = parseReview(parseClaudeOutput(stdout).text)
  assert.equal(review.verdict, 'approve')
  assert.equal(review.summary, 'ok')
  assert.equal(review.parsed, true)
})

test('buildStepCommand: reviewer uses a read-only posture', () => {
  const run = { workspace: '/tmp/ws', branch: 'collab/demo' }
  const codex = buildStepCommand('codex', 'review', 'prompt', run)
  assert.ok(codex.args.includes('read-only'))
  const claude = buildStepCommand('claude', 'review', 'prompt', run)
  assert.ok(claude.args.includes('plan'))
  const implement = buildStepCommand('codex', 'implement', 'prompt', run)
  assert.ok(implement.args.includes('workspace-write'))
})

test('buildReviewPrompt: carries the diff and asks for verdict JSON', () => {
  const prompt = buildReviewPrompt({ task: 'do a thing', round: 1 }, '+++ b/a.js', 'implementation note')
  assert.match(prompt, /do a thing/)
  assert.match(prompt, /b\/a\.js/)
  assert.match(prompt, /"verdict"/)
})

const execFileAsync = promisify(execFile)

test('parseCollabCommand: flags, agents, rounds, and task text', () => {
  const parsed = parseCollabCommand('--agents=codex,claude --rounds=2 add a hello() helper')
  assert.deepEqual(parsed.participants, ['codex', 'claude'])
  assert.equal(parsed.rounds, 2)
  assert.equal(parsed.task, 'add a hello() helper')
  assert.equal(parsed.scratch, false)

  const spaced = parseCollabCommand('--agents claude,codex --scratch fix the test')
  assert.deepEqual(spaced.participants, ['claude', 'codex'])
  assert.equal(spaced.scratch, true)
  assert.equal(spaced.task, 'fix the test')

  const plain = parseCollabCommand('只做一件事')
  assert.equal(plain.task, '只做一件事')
  assert.equal(plain.participants, undefined)
})

test('/collab handler uses the session repository and starts a run', async () => {
  let definition
  const commands = { register: (value) => { definition = value; return () => {} } }
  const calls = []
  const collab = {
    start: async (input) => {
      calls.push(input)
      return { ok: true, id: 'clb_test' }
    },
    get: () => ({ participants: ['codex', 'claude'], workspace: '/tmp/ws' }),
  }
  registerCollabCommand(commands, collab)
  assert.equal(definition.name, 'collab')
  const result = await definition.handler({
    agent: { session: { header: { cwd: '/tmp/repo' } } },
    rawInput: '--agents=codex,claude --rounds=2 add a test',
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /clb_test/)
  assert.equal(calls[0].repo, '/tmp/repo')
  assert.deepEqual(calls[0].participants, ['codex', 'claude'])
  assert.equal(calls[0].maxRounds, 2)
})

test('CollabRunner: a supplied repository becomes a worktree on a collab branch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-repo-'))
  const repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  await execFileAsync('git', ['init', '-q'], { cwd: repo })
  await fs.writeFile(path.join(repo, 'README.md'), '# demo\n', 'utf8')
  await execFileAsync('git', ['add', '-A'], { cwd: repo })
  await execFileAsync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-q', '-m', 'base'], { cwd: repo })

  const board = { config: { dataDir: path.join(root, 'data') }, upsertCollab: () => {}, addCollabEvent: () => {} }
  const exec = async (spec) => {
    await fs.writeFile(path.join(spec.cwd, 'feature.js'), 'export const feature = true\n', 'utf8')
    if (spec.args.includes('plan')) {
      return { code: 0, timedOut: false, stderr: '', stdout: '{"type":"result","result":"{\"verdict\":\"approve\",\"summary\":\"ok\"}"}' }
    }
    return { code: 0, timedOut: false, stderr: '', stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"implemented"}}' }
  }
  const runner = new CollabRunner({ board, config: { workspaceRoot: path.join(root, 'ws'), maxRounds: 1 }, exec })
  const started = await runner.start({ task: 'add feature', repo, participants: ['codex', 'claude'], maxRounds: 1 })
  assert.equal(started.ok, true)
  for (let index = 0; index < 100; index += 1) {
    if (runner.get(started.id).status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const run = runner.get(started.id)
  assert.equal(run.status, 'done')
  assert.match(run.branch, /^collab\//)
  const branch = await execFileAsync('git', ['-C', repo, 'branch', '--list', run.branch])
  assert.match(branch.stdout, /collab\//)
  assert.ok(await fs.stat(path.join(run.workspace, 'feature.js')))
  await execFileAsync('git', ['-C', repo, 'worktree', 'remove', '--force', run.workspace]).catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

test('CollabRunner: implement → review approve finishes in a scratch worktree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-run-'))
  const updates = []
  const board = {
    config: { dataDir: root },
    upsertCollab: (value) => updates.push(value),
    addCollabEvent: () => {},
  }
  const exec = async (spec) => {
    if (spec.command.includes('codex') || spec.args.includes('workspace-write')) {
      await fs.writeFile(path.join(spec.cwd, 'hello.js'), 'export const hello = (name) => `Hello, ${name}!`\n', 'utf8')
      await fs.writeFile(
        path.join(spec.cwd, '.agent-board', 'implementation-round-1.md'),
        '# implementation\n\nAdded hello.js and a test.\n',
        'utf8',
      )
      return {
        code: 0,
        timedOut: false,
        stderr: '',
        stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"implemented"}}\n',
      }
    }
    return {
      code: 0,
      timedOut: false,
      stderr: '',
      stdout: '{"type":"result","subtype":"success","result":"{\\"verdict\\":\\"approve\\",\\"summary\\":\\"ok\\",\\"issues\\":[],\\"tests\\":\\"present\\"}"}\n',
    }
  }
  const runner = new CollabRunner({
    board,
    config: { workspaceRoot: root, maxRounds: 1 },
    exec,
  })
  const started = await runner.start({
    task: 'add a hello() helper with a test',
    participants: ['codex', 'claude'],
    maxRounds: 1,
  })
  assert.equal(started.ok, true)

  for (let index = 0; index < 100; index += 1) {
    const run = runner.get(started.id)
    if (run.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const run = runner.get(started.id)
  assert.equal(run.status, 'done')
  assert.equal(run.verdict, 'approve')
  assert.equal(run.phases.length, 2)
  assert.equal(run.phases[0].role, 'implement')
  assert.equal(run.phases[1].role, 'review')
  assert.ok(await fs.stat(path.join(run.workspace, 'hello.js')))
  assert.ok(await fs.stat(path.join(run.workspace, '.agent-board', 'result.json')))
  assert.ok(updates.some((value) => value.status === 'done'))
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.ok(await fs.stat(path.join(root, 'collabs', `${run.id}.json`)))

  await fs.rm(root, { recursive: true, force: true })
})
