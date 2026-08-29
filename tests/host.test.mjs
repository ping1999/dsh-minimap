// Host smoke: import the built Node-side root entry (lib/host.js) exactly as
// the profile loader does, and verify the module shape — a no-op Cordis
// function plugin with no default export. This is the regression guard for
// the boot failure where the package root pointed at the browser bundle
// (window is not defined at loader import time).
// Run: node --test tests/host.test.mjs
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const mod = await import('../lib/host.js')

assert.equal(mod.name, 'dsh-minimap')
assert.deepEqual(mod.inject, [])
assert.equal(typeof mod.apply, 'function')
assert.equal(mod.default, undefined)
assert.equal(pkg.main, 'lib/host.js')
assert.equal(pkg.exports['.'], './lib/host.js')
assert.equal(pkg.exports['./client'], './lib/client.js')
assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
console.log('PASS host module shape (Node-safe root entry, client on ./client export)')
