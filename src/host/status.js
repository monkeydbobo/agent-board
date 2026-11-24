/**
 * One status ladder shared by every adapter.
 *
 * The board deliberately keeps the vocabulary small — running, attention,
 * idle, done — because it must mean the same thing for a Claude JSONL tail, a
 * Cursor metadata file, and a live DSH agent. Reasons stay separate so the UI
 * can explain *why* a task needs attention.
 */

export const ACTIVE_WINDOW_MS = 3 * 60 * 1000
export const DONE_AFTER_MS = 6 * 60 * 60 * 1000
export const ERROR_WINDOW_MS = 30 * 60 * 1000

/**
 * @param {object} input
 * @param {number} input.lastActivityMs last observed activity
 * @param {boolean} [input.open] turn started but not finished
 * @param {boolean} [input.error] last meaningful event was an error
 * @param {boolean} [input.ended] provider reported a clean end
 * @param {boolean} [input.alive] provider process is currently running
 * @param {number} [input.stallMs]
 * @returns {{status: 'running'|'attention'|'idle'|'done', reason: string}}
 */
export function deriveTaskStatus({ lastActivityMs = 0, open = false, error = false, ended = false, alive = false, stallMs = 10 * 60 * 1000 }) {
  const now = Date.now()
  const age = lastActivityMs > 0 ? now - lastActivityMs : Number.POSITIVE_INFINITY
  if (open) {
    if (age >= DONE_AFTER_MS) return { status: 'done', reason: 'quiet' }
    if (age >= stallMs) return { status: 'attention', reason: 'stalled' }
    if (error) return { status: 'attention', reason: 'error' }
    return { status: 'running', reason: 'active-turn' }
  }
  if (error && age <= ERROR_WINDOW_MS) return { status: 'attention', reason: 'error' }
  if (ended && age > ACTIVE_WINDOW_MS) return { status: 'done', reason: 'ended' }
  if (age <= ACTIVE_WINDOW_MS) return { status: 'running', reason: 'recent-activity' }
  if (age >= DONE_AFTER_MS) return { status: 'done', reason: 'quiet' }
  return { status: 'idle', reason: alive ? 'quiet' : 'idle' }
}

/** Provider-level rollup from its tasks. */
export function rollupProvider(tasks, { alive = false, note = '' } = {}) {
  if (tasks.some((task) => task.status === 'running')) return { status: 'running', note }
  if (tasks.some((task) => task.status === 'attention')) return { status: 'attention', note }
  if (alive) return { status: 'idle', note }
  if (tasks.length > 0) return { status: 'offline', note }
  return { status: 'offline', note }
}

/** Status display order used by both the lanes and the agent strip. */
export const STATUS_ORDER = ['attention', 'running', 'idle', 'done']
