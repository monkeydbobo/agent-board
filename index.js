/**
 * Agent Board — Host half.
 *
 * Registers the board service (adapters + reconciler), its HTTP/SSE surface,
 * and three read-only `fleet_*` tools. The browser half renders the panel.
 */

import { Board } from './src/host/board.js'
import { CollabRunner } from './src/host/collab.js'
import { registerCollabCommand } from './src/host/command.js'
import { registerRoutes } from './src/host/routes.js'
import { registerTools } from './src/host/tools.js'

/** Loader row id. */
export const name = 'agent-board'

/** The board needs the browser carrier; every other service is optional. */
export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const board = new Board({ ctx, config })
  const collab = new CollabRunner({ board, config: config.collab ?? {} })
  board.stopCollab = (id) => collab.stop(id)

  ctx.effect(() => board.start(), 'agent-board: monitor')
  ctx.effect(() => () => collab.stopAll(), 'agent-board: collaboration cleanup')

  ctx.effect(() => {
    try {
      return registerRoutes(ctx, board)
    } catch (error) {
      console.warn('[agent-board] route registration failed:', error?.message ?? error)
      return () => {}
    }
  }, 'agent-board: routes')

  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  if (commands && typeof commands.register === 'function') {
    try {
      ctx.effect(() => registerCollabCommand(commands, collab), 'agent-board: /collab command')
    } catch (error) {
      console.warn('[agent-board] command registration failed:', error?.message ?? error)
    }
  }

  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools && typeof tools.register === 'function') {
    try {
      ctx.effect(() => registerTools(tools, board, collab), 'agent-board: tools')
    } catch (error) {
      console.warn('[agent-board] tool service registration failed:', error?.message ?? error)
    }
  }
}
