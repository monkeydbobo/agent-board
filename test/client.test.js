import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

/**
 * Evaluate the browser module in a VM with the DSH module-loader shim. This
 * catches syntax/runtime errors in the module body and verifies that the two
 * shell slots are registered, without needing a browser.
 */
test('client module: loads, exposes the factory, registers both slots', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { registration = value } } },
    console,
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  assert.ok(registration, 'the module did not call __ModuleLoader__.load')
  assert.equal(registration.id, '@local/agent-board')

  const React = {
    createElement: () => null,
    useState: () => [null, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: (factory) => factory(),
    useCallback: (factory) => factory,
  }
  const mod = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${specifier})`)
  })

  assert.deepEqual(Array.from(mod.inject), ['slots', 'locale'])

  const slots = []
  const locales = []
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (namespace, dictionaries) => locales.push([namespace, Object.keys(dictionaries)]),
      bind: () => (key) => key,
      subscribe: () => () => {},
    },
    slots: {
      inject: (_key, callback) => callback(),
      register: (definition) => {
        slots.push(`${definition.name}:${definition.key ?? definition.id}`)
        return () => {}
      },
    },
  }

  mod.apply(ctx)

  assert.equal(locales.length, 1)
  assert.equal(locales[0][0], 'agent-board')
  assert.deepEqual(locales[0][1], ['zh', 'en'])
  assert.deepEqual(slots, ['main:agent-board', 'sidebar.panellist:agent-board'])
})
