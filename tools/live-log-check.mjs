/**
 * Pre-flight check against real session logs (read-only).
 *
 * The offline suite uses synthetic events. This one takes a few real
 * `session.<version>.jsonl.zstd` artifacts from `<DSH_HOME>/sessions`, decodes
 * them the same way the persistence layer does, and drives the plugin's own
 * route with them — so the fold runs against the event shapes this machine
 * actually writes, before the bundle is loaded into the app.
 *
 * Run: node tools/live-log-check.mjs [count]
 */

import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const home = mkdtempSync(join(tmpdir(), 'local-savings-live-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

const DSH_HOME = process.env.DSH_HOME_REAL || join(process.env.HOME || '', '.dsh')
const wanted = Number(process.argv[2] || 3)

/* ------------------------------------------------------------------------- */
/* Real logs                                                                  */
/* ------------------------------------------------------------------------- */

function sessionLogs() {
  const root = join(DSH_HOME, 'sessions')
  const found = []
  let groups
  try {
    groups = readdirSync(root)
  } catch {
    return found
  }
  for (const group of groups) {
    const dir = join(root, group)
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const sessionDir = join(dir, entry)
      let files
      try {
        files = readdirSync(sessionDir)
      } catch {
        continue
      }
      for (const file of files) {
        if (/^session(\.[A-Za-z0-9_-]+)*\.jsonl\.zstd$/.test(file) !== true) continue
        const path = join(sessionDir, file)
        const info = statSync(path)
        found.push({ path, size: info.size, mtime: info.mtimeMs, id: entry })
      }
    }
  }
  // Most recent activity first: the plugin itself only books sessions with
  // activity inside its 32-day window, so the biggest logs may be out of scope.
  found.sort((left, right) => right.mtime - left.mtime)
  return found
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Concatenated zstd frames, the way the JSONL backend appends them. */
function decodeFrames(buffer) {
  const offsets = []
  let index = 0
  for (;;) {
    const found = buffer.indexOf(MAGIC, index)
    if (found < 0) break
    offsets.push(found)
    index = found + 1
  }
  const parts = []
  for (let frame = 0; frame < offsets.length; frame += 1) {
    const start = offsets[frame]
    const end = frame + 1 < offsets.length ? offsets[frame + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      /* a false magic hit inside compressed data: skip it */
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

function eventsOf(log) {
  const text = decodeFrames(readFileSync(log.path))
  const records = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    records.push(JSON.parse(line))
  }
  const header = records.length > 0 && records[0].type === 'session' ? records.shift() : null
  return { header, events: records }
}

/* ------------------------------------------------------------------------- */
/* Drive the plugin's route with the real events                              */
/* ------------------------------------------------------------------------- */

const handlers = new Map()
const services = {}
const ctx = {
  logger: { warn() {}, info() {}, debug() {} },
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

apply(ctx)
const route = handlers.get('/plugins/local-savings/api')

const logs = sessionLogs().slice(0, wanted)
if (logs.length === 0) {
  console.log('no session logs found under ' + join(DSH_HOME, 'sessions'))
  process.exit(1)
}

const snapshots = new Map()
const records = []
for (const log of logs) {
  const { header: stored, events } = eventsOf(log)
  const header = stored !== null && typeof stored.id === 'string'
    ? stored
    : { id: log.id, createdAt: events.length > 0 ? events[0].time : log.mtime, isSeeded: false }
  const id = header.id
  snapshots.set(id, { session: header, inheritedEventCount: 0, events })
  records.push({ header, live: false, persisted: true })
  console.log(`log ${id} · v${String(header.version)} · ${(log.size / 1e6).toFixed(2)} MB · ${events.length} events`)
}

services.sessionQuery = {
  async listSessions() {
    return records
  },
  async readSession(id) {
    const snapshot = snapshots.get(id)
    if (snapshot === undefined) throw new Error('missing ' + id)
    return snapshot
  },
}

services.sessionPersistence = {
  async list() {
    return records.map((record, index) => ({
      header: record.header,
      revision: `real:${index}`,
      sizeBytes: logs[index] !== undefined ? logs[index].size : 1,
      location: { kind: 'jsonl', path: logs[index] !== undefined ? logs[index].path : '' },
    }))
  },
}

function request(url) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const req = { method: 'GET', url, on() {}, once() {}, async *[Symbol.asyncIterator]() {} }
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

const answer = await request('/plugins/local-savings/api?op=facts')
if (answer.json.ok !== true) {
  console.log('route failed:', JSON.stringify(answer.json))
  process.exit(1)
}

const facts = answer.json
console.log('\nrows:', facts.rows.length, '· sessions:', facts.sessions.length, '· stats:', JSON.stringify(facts.stats))

const totals = new Map()
for (const row of facts.rows) {
  const key = row[3] + ' / ' + row[4]
  const buckets = totals.get(key) || { calls: 0, tokens: 0 }
  buckets.calls += 1
  buckets.tokens += row[5] + row[6] + row[7] + row[8]
  totals.set(key, buckets)
}
for (const [key, value] of [...totals.entries()].sort((a, b) => b[1].tokens - a[1].tokens)) {
  console.log(`  ${key}: ${value.calls} calls, ${value.tokens} tokens`)
}

const problems = []
if (facts.rows.length === 0) problems.push('no rows were folded from real logs')
if (facts.rows.some((row) => row[4] === '')) problems.push('a row has no model id')
if (facts.rows.some((row) => row[3] === '')) problems.push('a row has no provider id')
if (facts.rows.some((row) => row[0] <= 0)) problems.push('a row has no timestamp')
if (totals.size === 0) problems.push('no provider/model attribution')

for (const problem of problems) console.log('PROBLEM: ' + problem)
console.log(problems.length === 0 ? '\nreal-log check passed' : `\n${problems.length} problem(s)`)
process.exit(problems.length === 0 ? 0 : 1)
