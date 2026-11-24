import test from 'node:test'
import assert from 'node:assert/strict'

import { ICON_FILES, readIcon } from '../src/host/icons.js'

test('icons: every provider has a bundled SVG', async () => {
  assert.deepEqual(
    Object.keys(ICON_FILES).sort(),
    ['antigravity', 'claude', 'codex', 'cursor', 'dsh', 'grokbot', 'localagent'],
  )
  for (const provider of Object.keys(ICON_FILES)) {
    const data = await readIcon(provider)
    assert.ok(data, `${provider} icon is missing`)
    assert.ok(data.length > 100, `${provider} icon is suspiciously small`)
    assert.match(data.toString('utf8'), /<svg[\s>]/)
  }
})

test('icons: unknown providers have no icon', async () => {
  assert.equal(await readIcon('nope'), undefined)
})
