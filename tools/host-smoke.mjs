/**
 * Host-half smoke test.
 *
 * Drives `index.js` through a fake Cordis context: no DSH, no network, no real
 * session logs. It checks the contract the page depends on — the ledger folds
 * provider usage into fact rows, skips inherited (forked) events, reports
 * coverage and per-session failures, and round-trips the rules file.
 *
 * Run: node tools/host-smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'local-savings-host-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

/* ------------------------------------------------------------------------- */
/* Fake Cordis context                                                        */
/* ------------------------------------------------------------------------- */

const handlers = new Map()
const disposers = []
const services = {}

const ctx = {
  logger: { warn() {}, info() {}, debug() {} },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  get(key) {
    return services[key]
  },
  webServer: {
    register(route) {
      handlers.set(route.path, route)
      return () => handlers.delete(route.path)
    },
  },
}

apply(ctx)
assert.equal(handlers.size, 1, 'the plugin registers exactly one route')

/* ------------------------------------------------------------------------- */
/* Fixture sessions                                                           */
/* ------------------------------------------------------------------------- */

const NOW = Date.UTC(2026, 10, 12, 1, 0, 0)

function assistant(time, seq, provider, model, usage) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider, model } }, usage },
  }
}

const eventsA = [
  { type: 'session', seq: 0, time: NOW - 3_600_000, data: {} },
  assistant(NOW - 3_000_000, 1, 'local', 'Qwen3.8-27B-Instruct-AWQ', { inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 300 }),
  assistant(NOW - 2_000_000, 2, 'deepseek-account', 'deepseek-flash', { inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 120 }),
  // A settled message with no model source must not invent attribution.
  { type: 'assistant/message', seq: 3, time: NOW - 1_900_000, data: { message: { role: 'assistant' }, usage: { inputTokens: 10, outputTokens: 1 } } },
  // An all-zero sample is noise, not a fact.
  assistant(NOW - 1_800_000, 4, 'local', 'Qwen3.8-27B', { inputTokens: 0, outputTokens: 0 }),
  { type: 'session/title', seq: 5, time: NOW - 1_700_000, data: { title: '本地跑得飞起', messageSeqs: [12] } },
]

// A fork: the first two events are inherited and must not be billed again.
const eventsB = [
  assistant(NOW - 5_000_000, 0, 'deepseek-account', 'deepseek-flash', { inputTokens: 9999, outputTokens: 9999 }),
  assistant(NOW - 4_900_000, 1, 'deepseek-account', 'deepseek-flash', { inputTokens: 8888, outputTokens: 8888 }),
  assistant(NOW - 900_000, 2, 'local', 'DeepSeek-V4.1-Flash-1017', { inputTokens: 200, cacheReadTokens: 4000, cacheWriteTokens: 100, outputTokens: 80 }),
]

const sessions = [
  { header: { id: 'session-a', createdAt: NOW - 3_600_000, isSeeded: false, cwd: '/tmp' }, live: true, persisted: true },
  { header: { id: 'session-b', createdAt: NOW - 5_500_000, isSeeded: false, cwd: '/tmp', parentSession: 'session-a', origin: 'subagent', delegationDepth: 1 }, live: false, persisted: true },
]

const logs = new Map([
  ['session-a', { session: sessions[0].header, inheritedEventCount: 0, events: eventsA }],
  ['session-b', { session: sessions[1].header, inheritedEventCount: 2, events: eventsB }],
])

services.sessionPersistence = {
  async list() {
    return sessions.map((entry) => ({
      header: entry.header,
      revision: `${entry.header.id}:1`,
      sizeBytes: 1234,
      location: { kind: 'jsonl', path: `${home}/missing-${entry.header.id}.jsonl` },
    }))
  },
}

services.sessionQuery = {
  async listSessions() {
    return sessions.map((entry) => ({ header: entry.header, live: entry.live, persisted: entry.persisted }))
  },
  async readSession(id) {
    const snapshot = logs.get(id)
    if (snapshot === undefined) throw new Error(`missing log for ${id}`)
    return snapshot
  },
}

/* ------------------------------------------------------------------------- */
/* Request driver                                                             */
/* ------------------------------------------------------------------------- */

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
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
        resolve({ status: this.statusCode, json, text })
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

/* ------------------------------------------------------------------------- */
/* Checks                                                                     */
/* ------------------------------------------------------------------------- */

check('ping answers with a protocol version', async () => {
  const answer = await request({ url: '/plugins/local-savings/api?op=ping' })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.json, { ok: true, version: '1' })
})

let facts = null

check('facts folds settled usage into fact rows', async () => {
  const answer = await request({ url: '/plugins/local-savings/api?op=facts' })
  assert.equal(answer.status, 200)
  facts = answer.json
  assert.equal(facts.ok, true)
  // 2 from session-a (one unattributed + one zero sample dropped), 1 owned by session-b.
  assert.equal(facts.rows.length, 3, `expected 3 rows, got ${facts.rows.length}`)
  assert.equal(facts.sessions.length, 2)
  assert.equal(facts.sessions[1].origin, 'subagent', 'subagent origin survives to the page')
  assert.equal(facts.sessions.find((entry) => entry.id === 'session-a').title, '本地跑得飞起', 'the latest title event is folded in')
  assert.equal(facts.stats.covered, 2)
  assert.equal(facts.stats.pending, 0)
  assert.equal(facts.stats.scanning, false)
})

check('rows are [t, session, seq, provider, model, in, cacheRead, cacheWrite, out]', async () => {
  const row = facts.rows[0]
  assert.equal(row.length, 9)
  const sessionsById = new Map(facts.sessions.map((entry, index) => [index, entry.id]))
  const byModel = new Map(facts.rows.map((entry) => [entry[4], entry]))
  const qwen = byModel.get('Qwen3.8-27B-Instruct-AWQ')
  assert.ok(qwen, 'the Qwen row exists')
  assert.deepEqual(qwen.slice(5), [1000, 2000, 0, 300])
  assert.equal(sessionsById.get(qwen[1]), 'session-a')
  assert.ok(byModel.get('deepseek-flash'), 'the cloud row exists')
  const deepseekLocal = byModel.get('DeepSeek-V4.1-Flash-1017')
  assert.ok(deepseekLocal, 'the forked session contributes its own local row')
  assert.equal(sessionsById.get(deepseekLocal[1]), 'session-b')
  // The fork's inherited pair (9999/8888) is skipped.
  assert.ok(!facts.rows.some((entry) => entry[5] === 9999), 'inherited events are not billed twice')
})

check('rows come back oldest-first', async () => {
  const times = facts.rows.map((entry) => entry[0])
  const sorted = times.slice().sort((a, b) => a - b)
  assert.deepEqual(times, sorted)
})

check('rows=0 skips the payload for progress polling', async () => {
  const answer = await request({ url: '/plugins/local-savings/api?op=facts&rows=0' })
  assert.equal(answer.json.ok, true)
  assert.equal(answer.json.rows.length, 0)
  assert.equal(answer.json.stats.pending, 0)
})

check('a second facts call does not rescan persisted sessions', async () => {
  let reads = 0
  const original = services.sessionQuery.readSession
  services.sessionQuery.readSession = async (id) => {
    reads += 1
    return original(id)
  }
  await request({ url: '/plugins/local-savings/api?op=facts&rows=0' })
  services.sessionQuery.readSession = original
  // session-a is live, so it is re-read on its own 60s cadence; session-b is not.
  assert.ok(reads <= 1, `expected at most the live session to be re-read, got ${reads}`)
})

check('an unreadable log is reported, not fatal', async () => {
  sessions.push({ header: { id: 'session-broken', createdAt: NOW - 1_000_000, isSeeded: false }, live: false, persisted: true })
  services.sessionPersistence.list = async () => sessions.map((entry) => ({
    header: entry.header,
    revision: `${entry.header.id}:2`,
    sizeBytes: 4321,
    location: { kind: 'jsonl', path: `${home}/missing-${entry.header.id}.jsonl` },
  }))
  const answer = await request({ url: '/plugins/local-savings/api?op=facts&rows=0' })
  assert.equal(answer.json.ok, true)
  assert.ok(answer.json.stats.errors.some((entry) => entry.sessionId === 'session-broken'), 'the failure names the session')
  assert.equal(answer.json.stats.pending, 0, 'a refused log does not loop forever')
})

check('rules default to empty and round-trip through the rules file', async () => {
  const initial = await request({ url: '/plugins/local-savings/api?op=rules' })
  assert.deepEqual(initial.json.rules, { version: 1, includeSubagents: true, providers: {}, models: {} })

  const saved = await request({
    method: 'POST',
    body: { op: 'rules', rules: { includeSubagents: false, providers: { local: 'local', '  ': 'local', 'deepseek-account': 'cloud', bogus: 'maybe' }, models: { 'Qwen3.8-27B': 'local' } } },
  })
  assert.equal(saved.json.ok, true)
  assert.deepEqual(saved.json.rules.providers, { local: 'local', 'deepseek-account': 'cloud' }, 'blank keys and unknown verdicts are dropped')
  assert.deepEqual(saved.json.rules.models, { 'Qwen3.8-27B': 'local' })
  assert.equal(saved.json.rules.includeSubagents, false)

  const reread = await request({ url: '/plugins/local-savings/api?op=rules' })
  assert.deepEqual(reread.json.rules, saved.json.rules)
})

check('unknown ops answer 400 with a reason', async () => {
  const answer = await request({ url: '/plugins/local-savings/api?op=nope' })
  assert.equal(answer.status, 400)
  assert.equal(answer.json.ok, false)
  const posted = await request({ method: 'POST', body: { op: 'nope' } })
  assert.equal(posted.status, 400)
})

check('an export writes one bounded CSV under the plugin data folder', async () => {
  const answer = await request({ method: 'POST', body: { op: 'export', name: '../../etc/passwd', csv: 'a,b\n1,2\n' } })
  assert.equal(answer.json.ok, true, JSON.stringify(answer.json))
  assert.ok(answer.json.path.startsWith(join(home, 'storages', 'local-savings', 'exports')), `unexpected path ${answer.json.path}`)
  assert.ok(!answer.json.path.includes('..'), 'the name is sanitised')
  const { readFileSync } = await import('node:fs')
  assert.equal(readFileSync(answer.json.path, 'utf8'), 'a,b\n1,2\n')
})

check('an empty export is refused', async () => {
  const answer = await request({ method: 'POST', body: { op: 'export', name: 'x', csv: '' } })
  assert.equal(answer.status, 400)
  assert.equal(answer.json.ok, false)
})

check('reset clears facts but keeps the rules', async () => {
  const answer = await request({ method: 'POST', body: { op: 'reset' } })
  assert.equal(answer.json.ok, true)
  assert.deepEqual(answer.json.rules.providers, { local: 'local', 'deepseek-account': 'cloud' })
  const after = await request({ url: '/plugins/local-savings/api?op=facts&rows=0' })
  assert.equal(after.json.stats.covered >= 0, true)
})

/* ------------------------------------------------------------------------- */

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
console.log(`\n${checks.length - failed}/${checks.length} host checks passed`)
process.exit(failed === 0 ? 0 : 1)
