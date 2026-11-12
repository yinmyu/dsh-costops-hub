/**
 * Config-backed rules smoke test.
 *
 * The plugin's route rules live in the row config (the profile patch), not in a
 * side file. This suite mounts a second, isolated copy of index.js with a fake
 * Loader entry and a recording config editor, then drives the same route the
 * page uses:
 *
 *   - config seeds the rules on load,
 *   - a save goes through configEditor.edit (never the file),
 *   - a missing editor falls back to the file and still answers ok.
 *
 * Run: node tools/host-config-smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'local-savings-config-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

const handlers = new Map()
const services = {}
const edits = []

const ctx = {
  logger: { warn() {}, info() {}, debug() {} },
  fiber: { entry: { options: { id: 'local-savings', config: {} } } },
  effect(fn) {
    fn()
  },
  get(key) {
    return services[key]
  },
  webServer: {
    register(route) {
      handlers.set(route.path, route)
      return () => {}
    },
  },
}

let rejectEdit = false
services.configEditor = {
  async edit(entry, change) {
    const before = { includeSubagents: true, providers: {}, models: {} }
    const next = change(before)
    if (rejectEdit) throw new Error('profile is read-only')
    edits.push({ entry, next })
    return next
  },
}

// The row config is the settings home for a profile that declares it.
apply(ctx, {
  includeSubagents: false,
  providers: { local: 'cloud' },
  models: { 'qwen3.8-27b': 'local' },
})

const route = handlers.get('/plugins/local-savings/api')

function request({ method = 'GET', url = '/plugins/local-savings/api', body } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const req = {
      method,
      url,
      on() {},
      once() {},
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      statusCode: 0,
      headers: {},
      writableEnded: false,
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(payload) {
        this.writableEnded = true
        if (payload !== undefined) chunks.push(Buffer.from(payload))
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: this.statusCode, json: text === '' ? null : JSON.parse(text) })
      },
      once() {},
    }
    route.handler(req, res).catch(reject)
  })
}

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

check('the row config seeds the rules', async () => {
  const answer = await request({ url: '/plugins/local-savings/api?op=rules' })
  assert.equal(answer.json.ok, true)
  assert.equal(answer.json.source, 'config')
  assert.deepEqual(answer.json.rules.providers, { local: 'cloud' })
  assert.deepEqual(answer.json.rules.models, { 'qwen3.8-27b': 'local' })
  assert.equal(answer.json.rules.includeSubagents, false)
})

check('a save goes through the config editor, not the file', async () => {
  const answer = await request({
    method: 'POST',
    body: { op: 'rules', rules: { includeSubagents: true, providers: { 'deepseek-official': 'cloud' }, models: { glm: 'local' } } },
  })
  assert.equal(answer.json.ok, true, JSON.stringify(answer.json))
  assert.equal(answer.json.source, 'config')
  assert.equal(edits.length, 1, 'exactly one editor call')
  const written = edits[0].next
  assert.deepEqual(written.providers, { 'deepseek-official': 'cloud' })
  assert.deepEqual(written.models, { glm: 'local' })
  assert.equal(written.includeSubagents, true)
  assert.equal(written.version, 1, 'the schema version is carried into the row config')
})

check('the saved rules are what the next read returns', async () => {
  const answer = await request({ url: '/plugins/local-savings/api?op=rules' })
  assert.deepEqual(answer.json.rules.providers, { 'deepseek-official': 'cloud' })
  assert.equal(answer.json.source, 'config')
})

check('a profile without an editor falls back to the side file', async () => {
  rejectEdit = true
  const answer = await request({
    method: 'POST',
    body: { op: 'rules', rules: { includeSubagents: true, providers: {}, models: { 'qwen3.8-27b': 'local' } } },
  })
  rejectEdit = false
  assert.equal(answer.json.ok, true, JSON.stringify(answer.json))
  assert.equal(answer.json.source, 'file')
  assert.ok(typeof answer.json.note === 'string' && answer.json.note.length > 0, 'the refusal is reported')
  const reread = await request({ url: '/plugins/local-savings/api?op=rules' })
  assert.equal(reread.json.source, 'file')
  assert.deepEqual(reread.json.rules.models, { 'qwen3.8-27b': 'local' })
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} config checks passed`)
process.exit(failed === 0 ? 0 : 1)
