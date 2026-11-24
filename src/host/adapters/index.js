/**
 * Adapter table.
 *
 * Each provider is optional and isolated: a failing adapter reports an offline
 * provider instead of taking the board down, and a provider switched off in the
 * plugin config is simply not constructed.
 */

import { DshAdapter } from './dsh.js'
import { CodexAdapter } from './codex.js'
import { ClaudeAdapter } from './claude.js'
import { CursorAdapter } from './cursor.js'
import { LocalAgentAdapter } from './localagent.js'
import { GrokBotAdapter } from './grokbot.js'
import { AntigravityAdapter } from './antigravity.js'

export function createAdapters(config = {}) {
  const enabled = config.providers ?? {}
  const roots = config.roots ?? {}
  const adapters = []
  if (enabled.dsh !== false) adapters.push(new DshAdapter())
  if (enabled.codex !== false) adapters.push(new CodexAdapter({ root: roots.codex }))
  if (enabled.claude !== false) adapters.push(new ClaudeAdapter({ root: roots.claude }))
  if (enabled.cursor !== false) adapters.push(new CursorAdapter({ root: roots.cursor }))
  if (enabled.localagent !== false) adapters.push(new LocalAgentAdapter({ root: roots.localagent }))
  if (enabled.grokbot !== false) adapters.push(new GrokBotAdapter({ root: roots.grokbot }))
  if (enabled.antigravity !== false) adapters.push(new AntigravityAdapter())
  return adapters
}
