/**
 * Development probe: run every adapter once and print what it found.
 *
 *   node scripts/probe.js [provider]
 *
 * Useful before installing the plugin and when an adapter needs a real-data
 * check after a provider changes its log format.
 */

import { createAdapters } from '../src/host/adapters/index.js'

const only = process.argv[2]
const config = {
  maxTasksPerProvider: 8,
  stallSeconds: 600,
  providers: {},
  roots: {},
}

const adapters = createAdapters(config).filter((adapter) => !only || adapter.id === only)
if (adapters.length === 0) {
  console.error(`No adapter matched "${only}".`)
  process.exitCode = 1
}

for (const adapter of adapters) {
  const started = Date.now()
  try {
    const result = await adapter.poll({ config, services: {} })
    const elapsed = Date.now() - started
    console.log(`\n=== ${result.label} (${result.id}) — ${result.status}${result.note ? ` — ${result.note}` : ''} — ${elapsed}ms`)
    for (const task of result.tasks.slice(0, 8)) {
      console.log(`  [${task.status}] ${task.title} — ${task.lastActivity} — ${task.workspace || '-'}`)
      const last = task.events[task.events.length - 1]
      if (last) console.log(`      ${last.at} ${last.kind}: ${last.summary}`)
    }
    if (result.tasks.length > 8) console.log(`  … ${result.tasks.length - 8} more`)
  } catch (error) {
    console.error(`\n=== ${adapter.id} FAILED:`, error)
    process.exitCode = 1
  }
}
