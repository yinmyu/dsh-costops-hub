/**
 * Host half of the local-savings bundle (省流中台 / CostOps Hub).
 *
 * The browser half needs two things the Client cannot compute on its own:
 *
 *   1. a cross-session ledger of token usage facts, and
 *   2. a place to keep the "which route counts as local" rules.
 *
 * Both are served to the page over one same-origin route. A plain-JS bundle
 * client has no `host.call` RPC (that is the dynamic-package path), so the
 * route is the transport — the same choice the sibling session-manager bundle
 * documents and verifies.
 *
 * The ledger stores FACTS only: when a provider usage sample settled, which
 * provider/model produced it, and the four token buckets. It never stores money,
 * never stores a local/cloud verdict and never stores a time-of-day price.
 * Prices and the local/cloud judgement are views: the page recomputes them from
 * the same facts, so editing a price table or a rule changes past bills without
 * rescanning a single log.
 *
 * Reading history goes through `ctx.sessionQuery`, which owns zstd decoding,
 * format migration, replay validation and live-preferred reads. Sessions are
 * scanned newest-first under a per-request time/byte budget; a scan that hits
 * the budget leaves the remaining sessions for the next request, and the page
 * shows that progress instead of a spinner.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The route is the plugin's whole host surface, so its carrier is a hard inject. */
export const inject = ['webServer']

const ROUTE_PATH = '/plugins/local-savings/api'
// 2 added the folded session title (and folder) to each session entry.
const LEDGER_VERSION = 2
const RULES_VERSION = 1
const DAY_MS = 86_400_000
/** Widest bill window (30 days) plus two days of slack for time-zone edges. */
const WINDOW_DAYS = 32
const RETENTION_MS = (WINDOW_DAYS + 2) * DAY_MS
/** One request may spend this long scanning logs before it answers with progress.
 *  The scan yields between sessions, so the longest block on the event loop is
 *  one log, not the whole budget. */
const BUDGET_MS = 1_200
/** ... and this many compressed bytes, whichever limit is hit first. */
const MAX_SCAN_BYTES = 24 * 1024 * 1024
const MAX_SESSIONS_PER_SCAN = 400
/** A live session is re-read at this cadence even when its stored revision is quiet. */
const LIVE_REREAD_MS = 60_000
const MAX_BODY_BYTES = 512 * 1024
/** An export is the user's own data, but it is still a bounded write. */
const MAX_EXPORT_BYTES = 8 * 1024 * 1024
const MAX_RULE_ENTRIES = 400
const MAX_RULE_KEY = 120
const ROUTE_VALUES = new Set(['local', 'cloud'])

/* ------------------------------------------------------------------------- */
/* Locations                                                                  */
/* ------------------------------------------------------------------------- */

/** `<DSH_HOME>`: a non-empty `$DSH_HOME`, else `~/.dsh`. */
function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (configured !== '') return configured
  try {
    return join(homedir(), '.dsh')
  } catch {
    return '.dsh'
  }
}

function dataDir() {
  return join(dshHome(), 'storages', 'local-savings')
}

function ledgerPath() {
  return join(dataDir(), 'facts.v1.json')
}

function rulesPath() {
  return join(dataDir(), 'rules.v1.json')
}

function exportsDir() {
  return join(dataDir(), 'exports')
}

/** File-name-safe local timestamp: 20261112-095812. */
function exportStamp(now) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/* ------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* ------------------------------------------------------------------------- */

function messageOf(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 300 ? text.slice(0, 297) + '...' : text
}

function warn(logger, message) {
  try {
    logger?.warn?.(message)
  } catch {
    /* logging is best-effort */
  }
}

function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

/** Hand the event loop back: a scan must never freeze the app window. */
function yieldTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Rename a legacy side file out of the way; absence is success. */
async function renameIfPresent(path) {
  try {
    await stat(path)
  } catch {
    return
  }
  try {
    await rename(path, `${path}.migrated`)
  } catch {
    /* a locked file only means the migration is retried next save */
  }
}

/** Write through a sibling temp file so a crash never leaves half a ledger. */
async function writeTextAtomic(path, text) {
  await mkdir(dataDir(), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}

/* ------------------------------------------------------------------------- */
/* Ledger                                                                     */
/* ------------------------------------------------------------------------- */

function emptyLedger() {
  return { version: LEDGER_VERSION, updatedAt: 0, sessions: {} }
}

/** Accept only the row shape this module writes; drop anything else. */
function normalizeRow(value) {
  if (Array.isArray(value) !== true || value.length < 8) return null
  const [time, seq, provider, model, input, cacheRead, cacheWrite, output] = value
  if (typeof time !== 'number' || Number.isFinite(time) !== true || time <= 0) return null
  if (typeof seq !== 'number' || Number.isFinite(seq) !== true || seq < 0) return null
  if (typeof provider !== 'string' || typeof model !== 'string') return null
  const row = [Math.round(time), Math.round(seq), provider, model, numberOf(input), numberOf(cacheRead), numberOf(cacheWrite), numberOf(output)]
  return row[4] + row[5] + row[6] + row[7] > 0 ? row : null
}

function normalizeLedger(raw) {
  const ledger = emptyLedger()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ledger
  if (raw.version !== LEDGER_VERSION) return ledger
  if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) ledger.updatedAt = raw.updatedAt
  const sessions = raw.sessions
  if (sessions === null || typeof sessions !== 'object' || Array.isArray(sessions)) return ledger
  for (const id of Object.keys(sessions)) {
    const entry = sessions[id]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (Array.isArray(entry.rows) !== true) continue
    const rows = []
    for (const value of entry.rows) {
      const row = normalizeRow(value)
      if (row !== null) rows.push(row)
    }
    ledger.sessions[id] = {
      rev: typeof entry.rev === 'string' ? entry.rev : '',
      size: typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : -1,
      at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
      createdAt: typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
      title: typeof entry.title === 'string' ? entry.title : '',
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      origin: entry.origin === 'subagent' ? 'subagent' : '',
      live: entry.live === true,
      rows,
    }
  }
  return ledger
}

const store = {
  ledger: null,
  rules: null,
  rulesSource: '',
  config: null,
  inflight: null,
  lastScan: null,
}

async function loadLedger() {
  if (store.ledger !== null) return store.ledger
  let raw = null
  try {
    raw = JSON.parse((await readText(ledgerPath())) ?? 'null')
  } catch {
    raw = null
  }
  store.ledger = normalizeLedger(raw)
  return store.ledger
}

let ledgerDirty = false

async function saveLedger() {
  const ledger = store.ledger
  if (ledger === null || ledgerDirty !== true) return
  ledgerDirty = false
  try {
    await writeTextAtomic(ledgerPath(), JSON.stringify(ledger))
  } catch (error) {
    warn(store.logger, `local-savings: could not persist the ledger: ${messageOf(error)}`)
  }
}

/* ------------------------------------------------------------------------- */
/* Rules                                                                      */
/* ------------------------------------------------------------------------- */

function emptyRules() {
  return { version: RULES_VERSION, includeSubagents: true, providers: {}, models: {} }
}

function normalizeRuleMap(value) {
  const map = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return map
  let count = 0
  for (const key of Object.keys(value)) {
    if (count >= MAX_RULE_ENTRIES) break
    const verdict = value[key]
    if (typeof verdict !== 'string' || ROUTE_VALUES.has(verdict) !== true) continue
    const trimmed = key.trim()
    if (trimmed === '' || trimmed.length > MAX_RULE_KEY) continue
    map[trimmed] = verdict
    count += 1
  }
  return map
}

function normalizeRules(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyRules()
  return {
    version: RULES_VERSION,
    includeSubagents: raw.includeSubagents !== false,
    providers: normalizeRuleMap(raw.providers),
    models: normalizeRuleMap(raw.models),
  }
}

/**
 * The row config is the settings home: whatever the profile's patch declares
 * for this plugin wins over the legacy side file. Returns null when the row
 * carries no rule field at all, so the file can still seed a fresh install.
 */
function rulesFromConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null
  const providers = config.providers !== null && typeof config.providers === 'object'
  const models = config.models !== null && typeof config.models === 'object'
  if (providers !== true && models !== true && config.includeSubagents === undefined) return null
  return normalizeRules(config)
}

async function loadRules() {
  if (store.rules !== null) return store.rules
  const fromConfig = rulesFromConfig(store.config)
  if (fromConfig !== null) {
    store.rules = fromConfig
    store.rulesSource = 'config'
    return store.rules
  }
  let raw = null
  try {
    raw = JSON.parse((await readText(rulesPath())) ?? 'null')
  } catch {
    raw = null
  }
  store.rules = normalizeRules(raw)
  store.rulesSource = 'file'
  return store.rules
}

/**
 * Persist rules through the profile's config editor, which writes the row into
 * the user's patch and lets the Loader restart this plugin with the new config.
 * Returns a failure reason instead of throwing when the profile has no editor.
 */
async function persistRules(ctx, rules) {
  const entry = ctx.fiber === undefined ? undefined : ctx.fiber.entry
  const editor = serviceOf(ctx, 'configEditor')
  if (entry === undefined || editor === undefined || typeof editor.edit !== 'function') {
    return { saved: false, reason: 'this profile has no configuration editor' }
  }
  try {
    await editor.edit(entry, (current) => {
      const base = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {}
      return {
        ...base,
        version: RULES_VERSION,
        includeSubagents: rules.includeSubagents !== false,
        providers: rules.providers,
        models: rules.models,
      }
    })
    return { saved: true }
  } catch (error) {
    return { saved: false, reason: messageOf(error) }
  }
}

async function saveRules(rules) {
  store.rules = rules
  await writeTextAtomic(rulesPath(), JSON.stringify(rules, null, 2))
}

/* ------------------------------------------------------------------------- */
/* Reading one session log into rows                                          */
/* ------------------------------------------------------------------------- */

/**
 * Fold one session's raw event log into usage facts.
 *
 * Attribution comes from the event itself: every settled `assistant/message`
 * carries `data.usage` (the provider's reported buckets) and
 * `data.message.source = {kind: 'model', provider, model}`. Both were verified
 * against a real log before this module was written; the schema is defensive
 * because a different adapter may omit a bucket or the source.
 *
 * Inherited events (a fork copies its source's log) are skipped so one call is
 * never billed twice.
 */
function factsFromSession(snapshot) {
  const events = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.events) ? snapshot.events : []
  const inherited = numberOf(snapshot?.inheritedEventCount)
  const rows = []
  let title = ''
  for (let index = inherited; index < events.length; index += 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object') continue
    // The latest title event is the one this session shows today; folding it
    // here costs no extra read, because the log is already in hand.
    if (event.type === 'session/title') {
      const value = event.data !== null && typeof event.data === 'object' ? event.data.title : undefined
      if (typeof value === 'string' && value.trim() !== '') title = value.trim().slice(0, 160)
      continue
    }
    if (event.type !== 'assistant/message') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const usage = data.usage
    if (usage === null || typeof usage !== 'object') continue
    const message = data.message
    const source = message !== null && typeof message === 'object' ? message.source : null
    if (source === null || typeof source !== 'object' || source.kind !== 'model') continue
    const provider = typeof source.provider === 'string' ? source.provider : ''
    const model = typeof source.model === 'string' ? source.model : ''
    if (model === '') continue
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0
    if (time <= 0) continue
    const input = numberOf(usage.inputTokens ?? usage.uncachedInputTokens ?? usage.input)
    const cacheRead = numberOf(usage.cacheReadTokens ?? usage.cacheRead)
    const cacheWrite = numberOf(usage.cacheWriteTokens ?? usage.cacheWrite)
    const output = numberOf(usage.outputTokens ?? usage.output)
    if (input + cacheRead + cacheWrite + output === 0) continue
    rows.push([Math.round(time), numberOf(event.seq), provider, model, input, cacheRead, cacheWrite, output])
  }
  return { rows, title }
}

/* ------------------------------------------------------------------------- */
/* Refresh: bounded, resumable backfill                                       */
/* ------------------------------------------------------------------------- */

function serviceOf(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

function revisionText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return String(value)
  } catch {
    return ''
  }
}

/**
 * Persisted snapshots keyed by session id: revision, size, artifact path.
 * Optional: a profile without the JSONL backend still bills live sessions.
 */
async function persistenceIndex(ctx, signal) {
  const persistence = serviceOf(ctx, 'sessionPersistence')
  const index = new Map()
  if (persistence === undefined || typeof persistence.list !== 'function') return index
  let snapshots
  try {
    snapshots = await persistence.list({ signal })
  } catch {
    return index
  }
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const header = snapshot?.header
    if (header === null || typeof header !== 'object' || typeof header.id !== 'string') continue
    index.set(header.id, {
      revision: revisionText(snapshot.revision),
      size: typeof snapshot.sizeBytes === 'number' ? snapshot.sizeBytes : -1,
      path: snapshot?.location?.path,
    })
  }
  return index
}

async function modifiedAt(entry) {
  if (entry === undefined || typeof entry.path !== 'string' || entry.path === '') return null
  try {
    const info = await stat(entry.path)
    return info.mtimeMs
  } catch {
    return null
  }
}

function isCovered(entry, revision, size, live, now) {
  if (entry === undefined) return false
  if (revision !== '' && entry.rev !== revision) return false
  if (size >= 0 && entry.size !== size) return false
  if (live === true && now - entry.at > LIVE_REREAD_MS) return false
  return true
}

/**
 * Bring the ledger up to date, spending at most one budget on log reads.
 * @returns a report for the page: coverage, progress, and per-session failures.
 */
async function refresh(ctx, { signal, budgetMs = BUDGET_MS } = {}) {
  const ledger = await loadLedger()
  store.logger = ctx.logger
  const query = serviceOf(ctx, 'sessionQuery')
  if (query === undefined || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
    return { ok: false, reason: 'session-query 服务不可用，无法回溯会话用量', stats: null }
  }

  const now = Date.now()
  const cutoff = now - WINDOW_DAYS * DAY_MS
  const corpus = await query.listSessions(signal)
  const persisted = await persistenceIndex(ctx, signal)
  const errors = []

  const candidates = []
  for (const record of Array.isArray(corpus) ? corpus : []) {
    const header = record?.header
    if (header === null || typeof header !== 'object' || typeof header.id !== 'string') continue
    const id = header.id
    const live = record.live === true
    const entry = ledger.sessions[id]
    const persistedEntry = persisted.get(id)
    const revision = persistedEntry === undefined ? '' : persistedEntry.revision
    const size = persistedEntry === undefined ? -1 : persistedEntry.size
    const touched = persistedEntry === undefined ? null : await modifiedAt(persistedEntry)
    const createdAt = typeof header.createdAt === 'number' ? header.createdAt : 0
    // A session outside the widest window, untouched since, contributes no row
    // any tab can show. Live sessions are always in scope: their log is the tail
    // that the current turn is appending to.
    const inWindow = live === true || touched === null ? createdAt >= cutoff : touched >= cutoff
    if (inWindow !== true) continue
    candidates.push({
      id,
      live,
      createdAt,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      origin: header.origin === 'subagent' ? 'subagent' : '',
      revision,
      size,
      touched: touched ?? createdAt,
      covered: isCovered(entry, revision, size, live, now),
    })
  }

  // Newest activity first: today's numbers should be complete before a week ago.
  candidates.sort((left, right) => right.touched - left.touched)

  const pending = candidates.filter((candidate) => candidate.covered !== true)
  const startedAt = Date.now()
  let scanned = 0
  let bytes = 0
  let stopped = false

  for (const candidate of pending) {
    if (scanned >= MAX_SESSIONS_PER_SCAN) {
      stopped = true
      break
    }
    if (bytes >= MAX_SCAN_BYTES) {
      stopped = true
      break
    }
    if (scanned > 0 && Date.now() - startedAt > budgetMs) {
      stopped = true
      break
    }
    try {
      const snapshot = await query.readSession(candidate.id)
      const folded = factsFromSession(snapshot)
      ledger.sessions[candidate.id] = {
        rev: candidate.revision,
        size: candidate.size,
        at: Date.now(),
        createdAt: candidate.createdAt,
        title: folded.title,
        cwd: candidate.cwd,
        origin: candidate.origin,
        live: candidate.live,
        rows: folded.rows,
      }
      scanned += 1
      bytes += candidate.size > 0 ? candidate.size : 0
      ledgerDirty = true
      await yieldTurn()
    } catch (error) {
      // A log this build cannot read must not stop the other sessions; the page
      // names the failures instead of hiding them.
      if (errors.length < 8) errors.push({ sessionId: candidate.id, reason: messageOf(error) })
      ledger.sessions[candidate.id] = {
        rev: candidate.revision,
        size: candidate.size,
        at: Date.now(),
        createdAt: candidate.createdAt,
        title: '',
        cwd: candidate.cwd,
        origin: candidate.origin,
        live: candidate.live,
        rows: [],
      }
      ledgerDirty = true
    }
  }

  // Retention: facts older than the widest window can never appear in a tab.
  const horizon = now - RETENTION_MS
  for (const id of Object.keys(ledger.sessions)) {
    const entry = ledger.sessions[id]
    const rows = entry.rows.filter((row) => row[0] >= horizon)
    if (rows.length !== entry.rows.length) {
      entry.rows = rows
      ledgerDirty = true
    }
    if (rows.length === 0 && entry.size < 0 && entry.rev === '' && entry.createdAt < cutoff) {
      delete ledger.sessions[id]
      ledgerDirty = true
    }
  }

  ledger.updatedAt = now
  ledgerDirty = true
  await saveLedger()

  const remaining = candidates.filter((candidate) => {
    const entry = ledger.sessions[candidate.id]
    return isCovered(entry, candidate.revision, candidate.size, candidate.live, Date.now()) !== true
  })

  store.lastScan = {
    at: now,
    scanned,
    bytes,
    stopped,
    candidates: candidates.length,
    pending: remaining.length,
    errors: errors.length,
  }

  return {
    ok: true,
    stats: {
      sessions: candidates.length,
      covered: candidates.length - remaining.length,
      pending: remaining.length,
      live: candidates.filter((candidate) => candidate.live === true).length,
      subagents: candidates.filter((candidate) => candidate.origin === 'subagent').length,
      scanned,
      bytes,
      // `changed` lets the page keep its current facts instead of re-downloading
      // half a megabyte of rows that did not move.
      changed: scanned > 0,
      scanning: remaining.length > 0,
      budgetHit: stopped,
      errors,
      updatedAt: ledger.updatedAt,
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Facts payload                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Flatten the ledger into the compact wire shape the page reviews:
 * `sessions[]` carries the identity, `rows[]` stays a plain tuple array so a
 * month of usage is a few hundred kilobytes rather than a few megabytes.
 */
function factsPayload(ledger, { since = 0 } = {}) {
  const sessions = []
  const indexOf = new Map()
  const rows = []
  const horizon = since > 0 ? since : Date.now() - RETENTION_MS

  for (const id of Object.keys(ledger.sessions)) {
    const entry = ledger.sessions[id]
    if (entry.rows.length === 0) continue
    let index = indexOf.get(id)
    for (const row of entry.rows) {
      if (row[0] < horizon) continue
      if (index === undefined) {
        index = sessions.length
        indexOf.set(id, index)
        sessions.push({
          id,
          createdAt: entry.createdAt,
          origin: entry.origin,
          live: entry.live === true,
          title: entry.title === undefined ? '' : entry.title,
          cwd: entry.cwd === undefined ? '' : entry.cwd,
        })
      }
      rows.push([row[0], index, row[1], row[2], row[3], row[4], row[5], row[6], row[7]])
    }
  }
  rows.sort((left, right) => left[0] - right[0])
  const oldest = rows.length > 0 ? rows[0][0] : 0
  const newest = rows.length > 0 ? rows[rows.length - 1][0] : 0
  return { sessions, rows, coverage: { oldest, newest, rows: rows.length } }
}

/* ------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* ------------------------------------------------------------------------- */

function sendJson(res, status, payload) {
  if (res.writableEnded === true) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendFailure(res, status, reason) {
  sendJson(res, status, { ok: false, reason })
}

async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    size += bytes
    if (size > MAX_BODY_BYTES) {
      req.resume?.()
      return null
    }
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function requestSignal(req, res) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once?.('aborted', abort)
  res.once?.('close', abort)
  return controller.signal
}

/**
 * Apply the composition's Host/Origin + browser-authentication fence when the
 * carrier exposes one; `undefined` admits the request, a number is the refusal.
 */
function rejectedByTrustFence(ctx, req, res) {
  const connection = serviceOf(ctx, 'connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function') return false
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch {
    return false
  }
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/* ------------------------------------------------------------------------- */
/* Ops                                                                        */
/* ------------------------------------------------------------------------- */

function parseSince(value) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) !== true || parsed <= 0) return 0
  return Math.round(parsed)
}

/** Serialize refresh runs so two open windows cannot scan the same logs at once. */
async function refreshOnce(ctx, options) {
  if (store.inflight !== null) return store.inflight
  const run = refresh(ctx, options).finally(() => {
    store.inflight = null
  })
  store.inflight = run
  return run
}

async function factsResponse(ctx, url, signal) {
  const report = await refreshOnce(ctx, { signal })
  if (report.ok !== true) {
    return { status: 200, payload: { ok: false, reason: report.reason, stats: report.stats, sessions: [], rows: [], coverage: { oldest: 0, newest: 0, rows: 0 } } }
  }
  const includeRows = url.searchParams.get('rows') !== '0'
  const ledger = await loadLedger()
  const since = parseSince(url.searchParams.get('since')) || Date.now() - RETENTION_MS
  const payload = includeRows ? factsPayload(ledger, { since }) : { sessions: [], rows: [], coverage: { oldest: 0, newest: 0, rows: 0 } }
  return {
    status: 200,
    payload: {
      ok: true,
      generatedAt: Date.now(),
      stats: report.stats,
      ...payload,
    },
  }
}

async function handleGet(ctx, url, res, signal) {
  const op = url.searchParams.get('op') ?? 'ping'
  if (op === 'ping') return sendJson(res, 200, { ok: true, version: '1' })
  if (op === 'facts') {
    const answer = await factsResponse(ctx, url, signal)
    return sendJson(res, answer.status, answer.payload)
  }
  if (op === 'rules') {
    const rules = await loadRules()
    return sendJson(res, 200, { ok: true, rules, source: store.rulesSource })
  }
  return sendFailure(res, 400, `unknown op: ${op}`)
}

async function handlePost(ctx, req, res, signal) {
  let text
  try {
    text = await readBoundedBody(req)
  } catch (error) {
    return sendFailure(res, 400, `request body unreadable: ${messageOf(error)}`)
  }
  if (text === null) return sendFailure(res, 413, 'request body is too large')
  let body
  try {
    body = JSON.parse(text.length === 0 ? '{}' : text)
  } catch (error) {
    return sendFailure(res, 400, `request body is not JSON: ${messageOf(error)}`)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return sendFailure(res, 400, 'request body is not an object')
  const op = typeof body.op === 'string' ? body.op : ''

  if (op === 'rules') {
    const rules = normalizeRules(body.rules)
    const viaConfig = await persistRules(ctx, rules)
    if (viaConfig.saved === true) {
      store.rules = rules
      store.rulesSource = 'config'
      // The row config is now the source of truth; retire the side file so the
      // two cannot disagree after an upgrade.
      try {
        await renameIfPresent(rulesPath())
      } catch {
        /* a leftover file is harmless */
      }
      return sendJson(res, 200, { ok: true, rules, source: 'config' })
    }
    try {
      await saveRules(rules)
      store.rulesSource = 'file'
    } catch (error) {
      return sendFailure(res, 500, `could not save rules: ${messageOf(error)}`)
    }
    return sendJson(res, 200, { ok: true, rules, source: 'file', note: viaConfig.reason })
  }
  if (op === 'reset') {
    const rules = await loadRules()
    const ledger = emptyLedger()
    store.ledger = ledger
    ledgerDirty = true
    await saveLedger()
    return sendJson(res, 200, { ok: true, reset: true, rules })
  }
  if (op === 'export') {
    const csv = typeof body.csv === 'string' ? body.csv : ''
    if (csv === '') return sendFailure(res, 400, 'the export is empty')
    if (Buffer.byteLength(csv, 'utf8') > MAX_EXPORT_BYTES) return sendFailure(res, 413, 'the export is too large')
    const rawName = typeof body.name === 'string' ? body.name : 'costops'
    // Letters, digits, dash and underscore only: no dot means no traversal.
    const name = rawName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'costops'
    const directory = exportsDir()
    const file = join(directory, `${name}-${exportStamp(Date.now())}.csv`)
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(file, csv, 'utf8')
    } catch (error) {
      return sendFailure(res, 500, `could not write the export: ${messageOf(error)}`)
    }
    return sendJson(res, 200, { ok: true, path: file, bytes: Buffer.byteLength(csv, 'utf8') })
  }
  if (op === 'facts') {
    const answer = await factsResponse(ctx, new URL(`${ROUTE_PATH}?op=facts`), signal)
    return sendJson(res, answer.status, answer.payload)
  }
  return sendFailure(res, 400, `unknown op: ${op}`)
}

async function handleRequest(ctx, req, res) {
  const method = String(req.method ?? 'GET').toUpperCase()
  const url = new URL(String(req.url ?? ROUTE_PATH), 'http://localhost')
  const signal = requestSignal(req, res)
  if (method === 'GET' || method === 'HEAD') return handleGet(ctx, url, res, signal)
  if (method !== 'POST') {
    res.statusCode = 405
    res.setHeader('allow', 'POST, GET')
    res.end()
    return
  }
  return handlePost(ctx, req, res, signal)
}

/* ------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Mount the ledger route on the Web carrier and remove it on unload.
 * @param ctx the plugin Context (only `webServer` is required).
 */
export function apply(ctx, config) {
  store.logger = ctx.logger
  store.config = config === undefined ? null : config
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          if (rejectedByTrustFence(ctx, req, res) === true) return
          await handleRequest(ctx, req, res)
        } catch (error) {
          warn(ctx.logger, `local-savings: request failed: ${messageOf(error)}`)
          sendFailure(res, 500, messageOf(error))
        }
      },
    }),
    'local-savings: session ledger route',
  )

  // The ledger and the rules are a cache and a preference: losing them only
  // costs a rescan, so a missing service degrades instead of failing the load.
  ctx.effect(() => {
    void loadRules().catch(() => {})
    void loadLedger().catch(() => {})
    return () => {
      store.ledger = null
      store.rules = null
      store.rulesSource = ''
      store.config = null
      store.inflight = null
    }
  }, 'local-savings: ledger store')
}
