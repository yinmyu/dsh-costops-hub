/**
 * Offline checks for the client module.
 *
 * Loads client.js with a fake module loader and a minimal React shim, then
 * renders the widget for synthetic sessions and asserts the numbers, the
 * attribution, the honesty notes and the degradation paths.
 *
 * Every money assertion uses a fixed request timestamp, so peak/off-peak
 * pricing is deterministic instead of depending on when the suite runs.
 *
 * Run: <bundled node>/node tools/test-client.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

/* ---------------------------------------------------------------- */
/* Minimal React shim with per-component hook stores                 */
/* ---------------------------------------------------------------- */

const runtime = {
  hooks: [],
  index: 0,
  effects: [],
  dirty: false,
  pendingFirstState: null,
};

const stores = new Map();

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(4).filter((c) => c !== null && c !== undefined && c !== false) };
  },
  useState(initial) {
    const index = runtime.index;
    runtime.index += 1;
    if (runtime.hooks.length <= index) runtime.hooks[index] = { value: initial };
    const slot = runtime.hooks[index];
    if (index === 0 && runtime.pendingFirstState !== null) {
      slot.value = runtime.pendingFirstState;
      runtime.pendingFirstState = null;
    }
    const setValue = (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next;
      runtime.dirty = true;
    };
    return [slot.value, setValue];
  },
  useRef(value) {
    const index = runtime.index;
    runtime.index += 1;
    if (runtime.hooks.length <= index) runtime.hooks[index] = { current: value };
    return runtime.hooks[index];
  },
  useEffect(effect) {
    const index = runtime.index;
    runtime.index += 1;
    if (runtime.hooks.length <= index) {
      runtime.hooks[index] = { effect };
      runtime.effects.push(effect);
    }
  },
};

class Component {
  constructor(props) {
    this.props = props;
    this.state = {};
  }
  setState(next) {
    this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state, this.props) : next) };
  }
}
Component.prototype.isReactComponent = {};
React.Component = Component;

/* ---------------------------------------------------------------- */
/* Fake loader                                                       */
/* ---------------------------------------------------------------- */

let factory = null;
globalThis.window = {
  __ModuleLoader__: {
    load(mod) {
      factory = mod.factory;
    },
  },
};

new Function('window', source)(globalThis.window);
if (factory === null) throw new Error('factory was not registered');

const plugin = factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});

const registrations = new Map();
const ctx = {
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  slots: {
    inject(key, fn) {
      if (key !== 'conversation.composer.dock' && key !== 'main' && key !== 'sidebar.panellist') throw new Error('unexpected slot: ' + key);
      fn();
      return () => {};
    },
    register(options, component) {
      registrations.set(options.name + ':' + (options.id || options.key || ''), { options, component });
      return () => {};
    },
  },
};
plugin.apply(ctx);

const dock = registrations.get('conversation.composer.dock:local-savings');
if (dock === undefined) throw new Error('the dock pill was not registered');
if (dock.options.order !== 2) throw new Error('unexpected order');

const pageRegistration = registrations.get('main:local-savings');
if (pageRegistration === undefined) throw new Error('the bill page was not registered');

const rail = registrations.get('sidebar.panellist:local-savings');
if (rail === undefined) throw new Error('the sidebar entry was not registered');
if (typeof rail.options.label !== 'function') throw new Error('the sidebar label must follow the locale');

const Widget = dock.component;
const Page = pageRegistration.component;

/* ---------------------------------------------------------------- */
/* Render helpers                                                    */
/* ---------------------------------------------------------------- */

/**
 * Render one function component against its own persistent hook store, then
 * run its effects on the first render only — the parts of React this suite
 * needs, and nothing else.
 */
function functionTree(component, props) {
  let store = stores.get(component);
  if (store === undefined) {
    store = { hooks: [], mounted: false, effects: [] };
    stores.set(component, store);
  }
  const saved = { hooks: runtime.hooks, index: runtime.index, effects: runtime.effects };
  runtime.hooks = store.hooks;
  runtime.index = 0;
  runtime.effects = [];
  const tree = component(props);
  const queued = runtime.effects;
  runtime.hooks = saved.hooks;
  runtime.index = saved.index;
  runtime.effects = saved.effects;
  if (store.mounted !== true) {
    store.mounted = true;
    store.effects = queued;
    store.cleanups = store.cleanups || [];
    for (const effect of queued) {
      const cleanup = effect();
      if (typeof cleanup === 'function') store.cleanups.push(cleanup);
    }
  }
  return tree;
}

/** Resolve function components into a plain element tree. */
function expand(node) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node !== 'object') return null;
  const type = node.type;
  if (typeof type === 'function') {
    const proto = type.prototype;
    if (proto !== undefined && proto !== null && proto.isReactComponent !== undefined) {
      return expand(new type(node.props).render());
    }
    return expand(functionTree(type, node.props));
  }
  return { ...node, children: (node.children || []).map(expand) };
}

function text(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (node.children === undefined) return '';
  return node.children.map(text).join(' ');
}

function renderComponent(Component, props, firstState) {
  const proto = Component.prototype;
  if (firstState !== undefined) runtime.pendingFirstState = firstState;
  if (proto !== undefined && proto !== null && proto.isReactComponent !== undefined) {
    const tree = expand(new Component(props).render());
    runtime.pendingFirstState = null;
    return tree;
  }
  const tree = functionTree(Component, props);
  runtime.pendingFirstState = null;
  return expand(tree);
}

function invoke(props, open) {
  stores.clear();
  runtime.dirty = false;
  const full = { t: undefined, ...props };
  return text(renderComponent(Widget, full, open === undefined ? null : open));
}

/* ---------------------------------------------------------------- */
/* Host route stub                                                   */
/* ---------------------------------------------------------------- */

const host = {
  facts: { ok: true, stats: { sessions: 0, covered: 0, pending: 0, subagents: 0, scanning: false }, sessions: [], rows: [] },
  rules: { version: 1, includeSubagents: true, providers: {}, models: {} },
  posted: [],
  rulesSource: 'config',
  rulesNote: '',
  loseNextRulesWrite: false,
  fullFetches: 0,
  fail: null,
  status: 200,
};

let inflight = 0;

globalThis.fetch = async (url, options) => {
  inflight += 1;
  try {
    const target = String(url);
    const method = options !== undefined && options !== null && options.method !== undefined ? String(options.method) : 'GET';
    if (host.fail !== null) throw new Error(host.fail);
    let payload;
    if (method === 'POST') {
      const body = JSON.parse(options.body);
      host.posted.push(body);
      if (body.op === 'rules') {
        host.rules = { ...host.rules, ...body.rules };
        if (host.loseNextRulesWrite === true) {
          host.loseNextRulesWrite = false;
          throw new Error('socket hang up');
        }
        payload = { ok: true, rules: host.rules, source: host.rulesSource, note: host.rulesNote };
      } else if (body.op === 'export') {
        payload = { ok: true, path: '/tmp/costops-export.csv', bytes: body.csv.length };
      } else {
        payload = { ok: true };
      }
    } else if (target.indexOf('op=rules') >= 0) {
      payload = { ok: true, rules: host.rules, source: host.rulesSource };
    } else {
      if (target.indexOf('rows=0') < 0) host.fullFetches += 1;
      payload = host.facts;
    }
    return {
      ok: host.status < 400,
      status: host.status,
      text: async () => JSON.stringify(payload),
    };
  } finally {
    inflight -= 1;
  }
};

function unmountAll() {
  for (const store of stores.values()) {
    if (Array.isArray(store.cleanups) !== true) continue;
    for (const cleanup of store.cleanups) cleanup();
  }
  stores.clear();
  runtime.dirty = false;
}

let pageProps = {};

async function mountPage(props) {
  unmountAll();
  pageProps = props || {};
  let tree = renderComponent(Page, pageProps);
  for (let round = 0; round < 80; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (runtime.dirty !== true && inflight === 0) return tree;
    if (runtime.dirty === true) {
      runtime.dirty = false;
      tree = renderComponent(Page, pageProps);
    }
  }
  return tree;
}

function rerender() {
  runtime.dirty = false;
  return renderComponent(Page, pageProps);
}

async function clickAndSettle(tree, label) {
  let next = click(tree, label);
  for (let round = 0; round < 40; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (runtime.dirty !== true && inflight === 0) return next;
    if (runtime.dirty === true) {
      runtime.dirty = false;
      next = renderComponent(Page, pageProps);
    }
  }
  return next;
}

function nodesOf(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) nodesOf(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  out.push(node);
  nodesOf(node.children, out);
  return out;
}

function buttonByText(tree, label) {
  for (const node of nodesOf(tree)) {
    if (node.type === 'button' && text(node) === label) return node;
  }
  return null;
}

function buttonContaining(tree, fragment) {
  for (const node of nodesOf(tree)) {
    if (node.type === 'button' && text(node).indexOf(fragment) >= 0) return node;
  }
  return null;
}

function click(tree, label) {
  const button = buttonByText(tree, label);
  if (button === null) throw new Error('no button labelled ' + JSON.stringify(label));
  button.props.onClick({ target: {} });
  return rerender();
}

/** The buttons inside the rule row whose text mentions `name`. */
function rowButtons(tree, name) {
  for (const node of nodesOf(tree)) {
    if (node.type !== 'div' || node.props.className !== 'dsh-ls-rulerow') continue;
    if (text(node).indexOf(name) < 0) continue;
    return nodesOf(node).filter((child) => child.type === 'button');
  }
  return [];
}

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

// 2026-11-11 is a Wednesday. 03:00Z = 11:00 Beijing (peak); 00:00Z = 08:00 (off-peak);
// 04:00Z = 12:00 Beijing (off-peak — the boundary the old build got wrong).
const PEAK = Date.parse('2026-11-11T03:00:00Z');
const OFF_PEAK = Date.parse('2026-11-11T00:00:00Z');
const NOON_BOUNDARY = Date.parse('2026-11-11T04:00:00Z');

const DEEPSEEK = 'DeepSeek-V4.1-Flash-1017';

function usageOf(month, extra) {
  return Object.assign({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, month, extra);
}

function projections(totals, provider, model) {
  return {
    useProjection: (key) =>
      key === 'tokenUsage' ? totals : { lastUsed: { provider, model }, next: { provider, model } },
  };
}

function trajectory(rows) {
  return {
    useProjection: (key) =>
      key === 'tokenUsage' ? rows.totals : { lastUsed: { provider: rows.provider, model: rows.model }, next: null },
    useTrajectory: (selector) => selector({ requests: rows.requests }),
  };
}

/** One tracked request with an explicit timestamp and providerMetadata. */
function request(options) {
  return {
    purpose: 'assistant',
    startedAt: options.startedAt,
    providerMetadata: { provider: options.provider || 'local', model: options.model },
    usage: options.usage,
  };
}

const results = [];
function check(name, ok, actual) {
  results.push({ name, ok, actual });
}

function amountOf(textValue) {
  const match = textValue.match(/¥([\d,]+(?:\.\d+)?)/);
  return match === null ? null : Number(match[1].replaceAll(',', ''));
}

const DEEPSEEK_USAGE = { inputTokens: 500000, cacheReadTokens: 1000000, outputTokens: 50000 };

/* 1. Peak and off-peak are priced at the time the request ran. */
{
  const peak = trajectory({
    totals: usageOf({ uncachedInputTokens: 500000, cacheReadTokens: 1000000, outputTokens: 50000 }),
    provider: 'local', model: DEEPSEEK,
    requests: [request({ startedAt: PEAK, model: DEEPSEEK, usage: DEEPSEEK_USAGE })],
  });
  const peakText = invoke(peak, false);
  // (0.5M*2 + 1M*0.04 + 50k*8)/1e6 = 1.44 CNY at peak
  check('peak request costs 1.44', amountOf(peakText) === 1.44, peakText);
  check('local route says saved', peakText.includes('saved'), peakText);

  const offPeak = trajectory({
    totals: usageOf({ uncachedInputTokens: 500000, cacheReadTokens: 1000000, outputTokens: 50000 }),
    provider: 'local', model: DEEPSEEK,
    requests: [request({ startedAt: OFF_PEAK, model: DEEPSEEK, usage: DEEPSEEK_USAGE })],
  });
  const offPeakText = invoke(offPeak, false);
  check('off-peak request costs 0.72', amountOf(offPeakText) === 0.72, offPeakText);
}

/* 2. The 12:00 boundary is off-peak, and the total does not depend on "now". */
{
  const noon = trajectory({
    totals: usageOf({ uncachedInputTokens: 500000, cacheReadTokens: 1000000, outputTokens: 50000 }),
    provider: 'local', model: DEEPSEEK,
    requests: [request({ startedAt: NOON_BOUNDARY, model: DEEPSEEK, usage: DEEPSEEK_USAGE })],
  });
  check('12:00 Beijing is off-peak', amountOf(invoke(noon, false)) === 0.72, invoke(noon, false));
}

/* 3. A session spanning peak and off-peak prices each request separately. */
{
  const spanning = trajectory({
    totals: usageOf({ uncachedInputTokens: 2000000 }),
    provider: 'local', model: DEEPSEEK,
    requests: [
      request({ startedAt: PEAK, model: DEEPSEEK, usage: { inputTokens: 1000000, outputTokens: 0 } }),
      request({ startedAt: OFF_PEAK, model: DEEPSEEK, usage: { inputTokens: 1000000, outputTokens: 0 } }),
    ],
  });
  const closed = invoke(spanning, false);
  check('spanning session costs 3.00', amountOf(closed) === 3.0, closed);
  const openPanel = invoke(spanning, true);
  check('spanning session says the price follows the request window', openPanel.includes('per request'), openPanel);
}

/* 4. Cloud routes report spend, not savings. */
{
  const cloud = trajectory({
    totals: usageOf({ uncachedInputTokens: 500000, cacheReadTokens: 1000000, outputTokens: 50000 }),
    provider: 'deepseek-official', model: DEEPSEEK,
    requests: [request({ startedAt: PEAK, provider: 'deepseek-official', model: DEEPSEEK, usage: DEEPSEEK_USAGE })],
  });
  const cloudText = invoke(cloud, false);
  check('cloud route says spent', cloudText.includes('spent'), cloudText);
  check('cloud route costs 1.44', amountOf(cloudText) === 1.44, cloudText);
}

/* 5. A session that mixes local and cloud shows both figures. */
{
  const mixed = trajectory({
    totals: usageOf({ uncachedInputTokens: 1500000, cacheReadTokens: 1000000, outputTokens: 50000 }),
    provider: 'deepseek-official', model: DEEPSEEK,
    requests: [
      request({ startedAt: PEAK, provider: 'local', model: DEEPSEEK, usage: DEEPSEEK_USAGE }),
      request({ startedAt: PEAK, provider: 'deepseek-official', model: DEEPSEEK, usage: { inputTokens: 1000000, outputTokens: 0 } }),
    ],
  });
  const mixedText = invoke(mixed, false);
  check('mixed route shows saved and spent', mixedText.includes('saved') && mixedText.includes('spent'), mixedText);
  check('mixed route keeps both amounts', mixedText.includes('¥1.44') && mixedText.includes('¥2.00'), mixedText);
}

/* 6. Per-request attribution reads providerMetadata and keeps models apart. */
{
  const twoModels = trajectory({
    totals: usageOf({ uncachedInputTokens: 1500000, cacheReadTokens: 1000000, outputTokens: 50000 }),
    provider: 'local', model: DEEPSEEK,
    requests: [
      request({ startedAt: PEAK, model: DEEPSEEK, usage: DEEPSEEK_USAGE }),
      request({ startedAt: PEAK, model: 'GLM-5.3', usage: { inputTokens: 1000000, outputTokens: 0 } }),
    ],
  });
  const closed = invoke(twoModels, false);
  // 1.44 (DeepSeek) + 8.00 (GLM-5.3) = 9.44
  check('two models add up', amountOf(closed) === 9.44, closed);
  const openPanel = invoke(twoModels, true);
  check('two models are listed by name', openPanel.includes('GLM-5.3') && openPanel.includes('DeepSeek-V4.1-Flash-1017'), openPanel);
  check('two models show both amounts', openPanel.includes('¥1.44') && openPanel.includes('¥8.00'), openPanel);
}

/* 7. Approximate tiers are declared, exact local ids are not. */
{
  const exact = trajectory({
    totals: usageOf({ uncachedInputTokens: 1000000 }),
    provider: 'local', model: 'Qwen3.8-27B-Instruct-AWQ',
    requests: [request({ startedAt: PEAK, model: 'Qwen3.8-27B-Instruct-AWQ', usage: { inputTokens: 1000000, outputTokens: 0 } })],
  });
  const exactPanel = invoke(exact, true);
  check('exact quantised id carries no tier caveat', !exactPanel.includes('nearest tier'), exactPanel);

  const approximate = trajectory({
    totals: usageOf({ uncachedInputTokens: 1000000 }),
    provider: 'local', model: 'GLM-4.6',
    requests: [request({ startedAt: PEAK, model: 'GLM-4.6', usage: { inputTokens: 1000000, outputTokens: 0 } })],
  });
  check('approximated tier is declared', invoke(approximate, true).includes('nearest tier'), invoke(approximate, true));
}

/* 8. The provider model id "deepseek-flash" resolves to the exact DeepSeek row. */
{
  const alias = trajectory({
    totals: usageOf({ uncachedInputTokens: 1000000 }),
    provider: 'local', model: 'deepseek-flash',
    requests: [request({ startedAt: PEAK, model: 'deepseek-flash', usage: { inputTokens: 1000000, outputTokens: 0 } })],
  });
  const panel = invoke(alias, true);
  check('deepseek-flash is priced exactly', amountOf(invoke(alias, false)) === 2.0, invoke(alias, false));
  check('deepseek-flash carries no tier caveat', !panel.includes('nearest tier'), panel);
}

/* 9. Unpublished prices and unknown models degrade to tokens only. */
{
  const kimi = trajectory({
    totals: usageOf({ uncachedInputTokens: 1000000 }),
    provider: 'local', model: 'kimi-k3',
    requests: [request({ startedAt: PEAK, model: 'kimi-k3', usage: { inputTokens: 1000000, outputTokens: 0 } })],
  });
  const kimiText = invoke(kimi, false);
  check('unpublished price shows tokens only', kimiText.includes('1.0M tok') && !kimiText.includes('¥'), kimiText);
  check('unpublished price is explained', invoke(kimi, true).includes('No published list price'), invoke(kimi, true));

  const unknown = trajectory({
    totals: usageOf({ uncachedInputTokens: 1234, outputTokens: 5678 }),
    provider: 'local', model: 'some-random-model-7b',
    requests: [request({ startedAt: PEAK, model: 'some-random-model-7b', usage: { inputTokens: 1234, outputTokens: 5678 } })],
  });
  const unknownText = invoke(unknown, false);
  check('unknown model shows no amount', !unknownText.includes('¥'), unknownText);
  check('unknown model still shows tokens', unknownText.includes('6,912 tok'), unknownText);
}

/* 10. Tokens with no per-request record are declared and priced. */
{
  const residual = trajectory({
    totals: usageOf({ uncachedInputTokens: 2000000 }),
    provider: 'local', model: DEEPSEEK,
    requests: [request({ startedAt: PEAK, model: DEEPSEEK, usage: { inputTokens: 1000000, outputTokens: 0 } })],
  });
  const panel = invoke(residual, true);
  check('residual tokens are declared', panel.includes('% of tokens have no per-request record'), panel);
  const closed = invoke(residual, false);
  check('residual tokens are still priced', amountOf(closed) === 3.0 || amountOf(closed) === 4.0, closed);
}

/* 11. USD list prices are converted and the conversion is stated. */
{
  const qwen = trajectory({
    totals: usageOf({ uncachedInputTokens: 1000000 }),
    provider: 'local', model: 'Qwen3.8-27B',
    requests: [request({ startedAt: PEAK, model: 'Qwen3.8-27B', usage: { inputTokens: 1000000, outputTokens: 0 } })],
  });
  // 0.424 USD * 6.67 = 2.82808 CNY
  const qwenText = invoke(qwen, false);
  check('USD list price converts to CNY', amountOf(qwenText) === 2.83, qwenText);
  check('conversion rate is stated', invoke(qwen, true).includes('USD converted at 6.67'), invoke(qwen, true));
}

/* 12. A published cache-creation price is used for cache writes. */
{
  const qwen = trajectory({
    totals: usageOf({ cacheWriteTokens: 1000000 }),
    provider: 'local', model: 'Qwen3.8-27B',
    requests: [request({ startedAt: PEAK, model: 'Qwen3.8-27B', usage: { cacheWriteTokens: 1000000, outputTokens: 0 } })],
  });
  // 0.53 USD * 6.67 = 3.5351 CNY
  const closed = invoke(qwen, false);
  check('cache write uses the creation price', amountOf(closed) === 3.54, closed);
  check('cache write row is listed', invoke(qwen, true).includes('Cache write'), invoke(qwen, true));
}

/* 13. The pill does not repeat the token count the shipped usage pill shows. */
{
  const usage = usageOf({ uncachedInputTokens: 500000, cacheReadTokens: 1000000, outputTokens: 50000 });
  const closed = invoke(projections(usage, 'local', DEEPSEEK), false);
  check('pill does not repeat the token total', !closed.includes('tok'), closed);
}

/* 14. Projection-only sessions (no trajectory yet) still price. */
{
  const usage = usageOf({ uncachedInputTokens: 500000, cacheReadTokens: 1000000, outputTokens: 50000 });
  const closed = invoke(projections(usage, 'local', DEEPSEEK), false);
  check('projection-only session prices at the current window', closed.includes('saved') && amountOf(closed) !== null, closed);
  check('projection-only session has no residual notice', !invoke(projections(usage, 'local', DEEPSEEK), true).includes('% of tokens have no per-request record'), '');
}

/* 15. A throwing trajectory hook must not blank the widget. */
{
  const props = {
    useProjection: (key) =>
      key === 'tokenUsage' ? usageOf({ uncachedInputTokens: 1000, outputTokens: 1000 }) : { lastUsed: { provider: 'local', model: DEEPSEEK }, next: null },
    useTrajectory: () => {
      throw new Error('boom');
    },
  };
  const closed = invoke(props, false);
  check('throwing trajectory degrades gracefully', closed.length > 0 && closed.includes('saved'), closed);
}

/* 16. No usage yet: render nothing. */
{
  check('no usage renders nothing', invoke({ useProjection: () => undefined }, false) === '', '');
}

/* 17. Route detection matches whole id segments, never stray substrings. */
{
  const usage = usageOf({ uncachedInputTokens: 1000000 });
  const cloud = invoke(projections(usage, 'deepseek-account', DEEPSEEK), false);
  check('cloud account is not mistaken for local', cloud.includes('spent'), cloud);
  const local = invoke(projections(usage, 'home-local-box', DEEPSEEK), false);
  check('local id segment is recognised', local.includes('saved'), local);
}

/* 18. Copy: the panel repeats the same claim as the pill. */
{
  const usage = usageOf({ uncachedInputTokens: 500000, cacheReadTokens: 1000000, outputTokens: 50000 });
  const closed = invoke(projections(usage, 'local', DEEPSEEK), false);
  const openPanel = invoke(projections(usage, 'local', DEEPSEEK), true);
  const pillAmount = amountOf(closed);
  check('panel headline repeats the pill claim', openPanel.includes('saved') && openPanel.includes('¥' + String(pillAmount)), openPanel);
  check('panel states the price date', openPanel.includes('Prices as of 2026-11-11'), openPanel);
  check('panel states what is excluded', openPanel.includes('excludes power/hardware'), openPanel);
}


/* ---------------------------------------------------------------- */
/* Bill page: windows, money, rules, degradation                     */
/* ---------------------------------------------------------------- */

const QWEN = 'Qwen3.8-27B';
const TODAY = Math.floor((Date.now() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
const RECENT = Math.max(TODAY, Date.now() - 1000);

function fact(time, sessionIndex, seq, provider, model, input, cacheRead, cacheWrite, output) {
  return [time, sessionIndex, seq, provider, model, input, cacheRead, cacheWrite, output];
}

function factsOf(rows, sessions, extra) {
  return {
    ok: true,
    generatedAt: Date.now(),
    stats: {
      sessions: sessions.length,
      covered: sessions.length,
      pending: 0,
      live: 0,
      subagents: sessions.filter((entry) => entry.origin === 'subagent').length,
      scanned: sessions.length,
      bytes: 0,
      scanning: false,
      budgetHit: false,
      errors: [],
      updatedAt: Date.now(),
    },
    sessions,
    rows,
    coverage: { oldest: 0, newest: 0, rows: rows.length },
    ...(extra || {}),
  };
}

const localQwen = (time, input, sessionIndex) => fact(time, sessionIndex || 0, 1, 'local', QWEN, input, 0, 0, 0);
const cloudQwen = (time, input, sessionIndex) => fact(time, sessionIndex || 0, 2, 'deepseek-official', QWEN, input, 0, 0, 0);

await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.facts = factsOf([localQwen(RECENT, 2000000), cloudQwen(RECENT, 1000000)], [{ id: 'a', createdAt: TODAY, origin: '', live: true }]);
  const tree = await mountPage();
  const body = text(tree);
  // 2M * 0.424 USD * 6.67 = 5.65616 → ¥5.66; 1M → ¥2.83
  check('page prices local tokens as money not spent', body.includes('¥5.66'), body);
  check('page prices cloud tokens as money spent', body.includes('¥2.83'), body);
  check('page names the net saving', body.includes('Net saved'), body);
  check('page shows the token scale', body.includes('2.0M tok') && body.includes('1.0M tok'), body);
  check('page shows the price date', body.includes('prices as of 2026-11-11'), body);
  check('page shows the excluded cost', body.includes('excludes power/hardware'), body);
})();

await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  const tenDaysAgo = Date.now() - 10 * 86400000;
  host.facts = factsOf(
    [localQwen(RECENT, 2000000), cloudQwen(RECENT, 1000000), localQwen(tenDaysAgo, 3000000)],
    [{ id: 'a', createdAt: tenDaysAgo, origin: '', live: false }],
  );
  let tree = await mountPage();
  const today = text(tree);
  check('today excludes an older day', !today.includes('¥14.14'), today);
  tree = click(tree, 'Last 30 days');
  const month = text(tree);
  // 5.66 (2M) + 8.48 (3M) = 14.14
  check('30 days includes the older day', month.includes('¥14.14'), month);
})();

await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.posted = [];
  host.facts = factsOf([localQwen(RECENT, 2000000), cloudQwen(RECENT, 1000000)], [{ id: 'a', createdAt: TODAY, origin: '', live: true }]);
  let tree = await mountPage();
  tree = click(tree, 'Route rules');
  const rulesText = text(tree);
  check('rules tab lists the providers seen in the ledger', rulesText.includes('local') && rulesText.includes('deepseek-official'), rulesText);
  check('rules tab explains that rules do not rewrite facts', rulesText.includes('Rules change the verdict'), rulesText);

  const buttons = rowButtons(tree, 'local');
  const cloudButton = buttons.find((button) => text(button) === 'Cloud');
  check('a provider row carries a verdict control', cloudButton !== undefined, rulesText);
  cloudButton.props.onClick({ target: {} });
  tree = rerender(tree);
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = rerender(tree);
  const saved = host.posted.filter((body) => body.op === 'rules').pop();
  check('changing a provider verdict posts the rules', saved !== undefined && saved.rules.providers.local === 'cloud', JSON.stringify(host.posted));

  tree = click(tree, 'Bills');
  const bill = text(tree);
  check('the new verdict moves that route to spent', bill.includes('¥8.48') && bill.includes('¥0.00'), bill);
})();

await (async () => {
  host.rules = { version: 1, includeSubagents: false, providers: {}, models: {} };
  host.facts = factsOf(
    [localQwen(RECENT, 2000000), localQwen(RECENT, 4000000, 1)],
    [
      { id: 'main', createdAt: TODAY, origin: '', live: true },
      { id: 'child', createdAt: TODAY, origin: 'subagent', live: false },
    ],
  );
  const tree = await mountPage();
  const body = text(tree);
  check('sub-agent sessions can be excluded', body.includes('¥5.66') && !body.includes('¥16.97'), body);

  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  const all = text(await mountPage());
  check('sub-agent sessions are counted by default', all.includes('¥16.97'), all);
})();

await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.facts = factsOf([], []);
  const tree = await mountPage();
  const body = text(tree);
  check('an empty ledger says so', body.includes('No usage recorded yet'), body);
  check('an empty ledger does not invent money', !body.includes('¥'), body);
})();

await (async () => {
  host.facts = factsOf([], []);
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.fail = 'host unreachable';
  const tree = await mountPage();
  const body = text(tree);
  check('a broken route reports the failure', body.includes('Cannot read the ledger') && body.includes('host unreachable'), body);
  check('a broken route offers a retry', body.includes('Retry'), body);
  host.fail = null;
})();

await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.facts = factsOf(
    [null, [1, 2], localQwen(RECENT, 1000000), [RECENT, 9, 3, 'local', 'kimi-k3', 500000, 0, 0, 0]],
    [{ id: 'a', createdAt: TODAY, origin: '', live: true }],
  );
  const body = text(await mountPage());
  check('malformed rows are skipped without crashing', body.includes('Saved'), body);
  check('an unpriced model is declared, not invented', body.includes('% of tokens have no published list price'), body);
})();

/* ---------------------------------------------------------------- */
/* ---------------------------------------------------------------- */


await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  const yesterday = RECENT - 86400000;
  host.facts = factsOf(
    [localQwen(RECENT, 1000000), cloudQwen(RECENT, 1000000), localQwen(yesterday, 500000), cloudQwen(yesterday, 2000000)],
    [{ id: 'a', createdAt: yesterday, origin: '', live: true }],
  );
  const body = text(await mountPage());
  // saved 2.83 vs 1.41 yesterday → +100%; spent 2.83 vs 5.66 → -50%
  check('saving more than the previous day reads as a rise', body.includes('↑100%'), body);
  check('spending less than the previous day reads as a fall', body.includes('↓50%'), body);
})();

await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.posted = [];
  host.facts = factsOf([localQwen(RECENT, 1000000)], [{ id: 'a', createdAt: TODAY, origin: '', live: true }]);
  let tree = await mountPage();
  tree = await clickAndSettle(tree, 'Export CSV');
  const posted = host.posted.find((body) => body.op === 'export');
  check('export posts one CSV to the host', posted !== undefined && typeof posted.csv === 'string', JSON.stringify(posted && posted.csv.slice(0, 120)));
  check('the CSV opens with the documented columns', posted !== undefined && posted.csv.includes('模型,Provider,线路'), posted !== undefined ? posted.csv.slice(0, 160) : '');
  check('the CSV carries the priced row', posted !== undefined && posted.csv.includes('Qwen3.8-27B') && posted.csv.includes('2.8281'), posted !== undefined ? posted.csv : '');
  check('the CSV carries a total row', posted !== undefined && posted.csv.includes('Total'), posted !== undefined ? posted.csv : '');
  check('the page reports where the file went', text(tree).includes('/tmp/costops-export.csv'), text(tree));
})();


await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.facts = factsOf(
    [fact(RECENT - 60000, 0, 1, 'local', QWEN, 1000000, 0, 0, 0), fact(RECENT, 1, 1, 'local', QWEN, 500000, 0, 0, 0)],
    [
      { id: 's1', createdAt: TODAY, origin: '', live: true, title: '省钱计算token插件打磨' },
      { id: 's2', createdAt: TODAY, origin: '', live: false, title: '继续对话项目' },
    ],
  );
  let tree = await mountPage();
  const collapsed = text(tree);
  check('the drill-down starts closed', !collapsed.includes('2 sessions contributed'), collapsed);

  const row = buttonContaining(tree, QWEN);
  check('a model row is an expandable control', row !== null && row.props['aria-expanded'] === false, collapsed);
  row.props.onClick({ target: {} });
  tree = rerender();
  const open = text(tree);
  check('the drill-down counts the contributing sessions', open.includes('2 sessions contributed'), open);
  check('the drill-down names each session', open.includes('省钱计算token插件打磨') && open.includes('继续对话项目'), open);
  check('the drill-down prices each session', open.includes('¥2.83') && open.includes('¥1.41'), open);
  check('the drill-down states requests and recency', open.includes('1 requests') && open.includes('last '), open);

  const again = buttonContaining(tree, QWEN);
  again.props.onClick({ target: {} });
  const closed = text(rerender());
  check('a second click collapses the drill-down', !closed.includes('2 sessions contributed'), closed);

  // Re-open and pick the other session: the page should switch to that bill.
  tree = rerender();
  buttonContaining(tree, QWEN).props.onClick({ target: {} });
  tree = rerender();
  const other = buttonContaining(tree, '省钱计算token插件打磨');

  check('a drill row is a control for its session', other !== null, text(tree));
  other.props.onClick({ target: {} });
  const pickedView = text(rerender());
  check('picking a session opens its bill', pickedView.includes('This session: 省钱计算token插件打磨'), pickedView);
  check('the picked bill counts only that session', pickedView.includes('¥2.83') && !pickedView.includes('¥11.31'), pickedView);
  check('a picked session offers the way back', pickedView.includes('back to the current session'), pickedView);

  const back = buttonContaining(rerender(), 'back to the current session');
  check('the way back is a button', back !== null, pickedView);
  back.props.onClick({ target: {} });
  const restored = text(rerender());
  check('the way back returns to the current session', restored.includes('This session: 继续对话项目'), restored);
})();

await (async () => {
  host.rules = { version: 1, includeSubagents: false, providers: {}, models: {} };
  host.facts = factsOf(
    [fact(RECENT, 0, 1, 'local', QWEN, 1000000, 0, 0, 0), fact(RECENT, 1, 1, 'local', QWEN, 500000, 0, 0, 0)],
    [
      { id: 'main', createdAt: TODAY, origin: '', live: true, title: '主会话' },
      { id: 'child', createdAt: TODAY, origin: 'subagent', live: false, title: '子任务' },
    ],
  );
  let tree = await mountPage();
  tree = click(tree, 'Export CSV'); // no-op guard: the export path must not disturb the drill
  const row = buttonContaining(tree, QWEN);
  row.props.onClick({ target: {} });
  const open = text(rerender());
  check('the drill-down honours the sub-agent switch', open.includes('1 sessions contributed') && !open.includes('子任务'), open);
})();


await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  // Keep the older row inside today's window even when the suite runs just after midnight.
  const older = Math.max(TODAY, RECENT - 3600000);
  host.facts = factsOf(
    [fact(older, 0, 1, 'local', QWEN, 1000000, 0, 0, 0), fact(RECENT, 1, 1, 'local', QWEN, 3000000, 0, 0, 0)],
    [
      { id: 's-old', createdAt: older, origin: '', live: false, title: '旧会话' },
      { id: 's-new', createdAt: RECENT, origin: '', live: true, title: '当前会话' },
    ],
  );
  const useSessions = (selector) => selector({
    byId: {
      's-old': { id: 's-old', updatedAt: 1, retainedBy: {} },
      's-new': { id: 's-new', updatedAt: 2, retainedBy: { mainView: 1 } },
    },
  });
  let tree = await mountPage({ useSessions });
  const today = text(tree);
  check('today still spans every session', today.includes('¥11.31'), today);

  tree = click(tree, 'This session');
  const body = text(tree);
  check('the session window names the retained session', body.includes('This session: 当前会话'), body);
  check('the session window counts only that session', body.includes('¥8.48') && !body.includes('¥11.31'), body);
  check('the session window drops the comparison chip', !body.includes('↑') && !body.includes('↓'), body);
})();

await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  // Keep the older row inside today's window even when the suite runs just after midnight.
  const older = Math.max(TODAY, RECENT - 3600000);
  host.facts = factsOf(
    [fact(older, 0, 1, 'local', QWEN, 1000000, 0, 0, 0), fact(RECENT, 1, 1, 'local', QWEN, 3000000, 0, 0, 0)],
    [
      { id: 's-old', createdAt: older, origin: '', live: false, title: '旧会话' },
      { id: 's-new', createdAt: RECENT, origin: '', live: true, title: '当前会话' },
    ],
  );
  const tree = await mountPage({});
  const body = text(click(tree, 'This session'));
  check('without a retained session the newest activity wins', body.includes('This session: 当前会话'), body);
})();


await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.rulesSource = 'config';
  host.facts = factsOf([localQwen(RECENT, 1000000)], [{ id: 'a', createdAt: TODAY, origin: '', live: true }]);
  const body = text(click(await mountPage(), 'Route rules'));
  check('the rules tab says the rules live in the plugin config', body.includes('Rules live in this plugin configuration'), body);
})();

await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.rulesSource = 'file';
  host.rulesNote = 'this profile has no configuration editor';
  host.posted = [];
  host.facts = factsOf([localQwen(RECENT, 1000000)], [{ id: 'a', createdAt: TODAY, origin: '', live: true }]);
  let tree = await mountPage();
  tree = click(tree, 'Route rules');
  const buttons = rowButtons(tree, 'local');
  const cloud = buttons.find((button) => text(button) === 'Cloud');
  cloud.props.onClick({ target: {} });
  tree = await clickAndSettle(tree, 'Route rules');
  const body = text(tree);
  check('a file fallback is reported, not hidden', body.includes('this profile has no configuration editor'), body);
  check('the source line follows the write', body.includes('plugin data folder'), body);
})();

await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.rulesSource = 'config';
  host.rulesNote = '';
  host.posted = [];
  host.loseNextRulesWrite = true;
  host.facts = factsOf([localQwen(RECENT, 1000000)], [{ id: 'a', createdAt: TODAY, origin: '', live: true }]);
  let tree = await mountPage();
  tree = click(tree, 'Route rules');
  const buttons = rowButtons(tree, 'local');
  buttons.find((button) => text(button) === 'Cloud').props.onClick({ target: {} });
  tree = await clickAndSettle(tree, 'Route rules');
  const body = text(tree);
  check('a lost response after a config write is not reported as failure', body.includes('Saved') && !body.includes('Rules were not saved'), body);
})();


await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.facts = factsOf([localQwen(RECENT, 1000000)], [{ id: 'a', createdAt: TODAY, origin: '', live: true }]);
  host.facts.stats.changed = false;
  host.fullFetches = 0;
  let tree = await mountPage();
  check('the first load fetches the rows once', host.fullFetches === 1, String(host.fullFetches));

  tree = await clickAndSettle(tree, 'Refresh');
  check('a refresh with nothing new skips the row payload', host.fullFetches === 1, String(host.fullFetches));
  check('a skipped refresh keeps the numbers', text(tree).includes('¥2.83'), text(tree));

  host.facts = factsOf([localQwen(RECENT, 3000000)], [{ id: 'a', createdAt: TODAY, origin: '', live: true }]);
  host.facts.stats.changed = true;
  tree = await clickAndSettle(tree, 'Refresh');
  check('a changed ledger refetches the rows', host.fullFetches === 2, String(host.fullFetches));
  check('a changed ledger updates the numbers', text(tree).includes('¥8.48'), text(tree));
})();


await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.facts = factsOf([localQwen(RECENT, 1000000)], [{ id: 'a', createdAt: TODAY, origin: '', live: true }]);
  let tree = await mountPage();
  const tablist = nodesOf(tree).find((node) => node.props.className === 'dsh-ls-tabs');
  check('the bill/rules tabs are a tablist', tablist !== undefined && tablist.props.role === 'tablist', text(tree));
  tablist.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  const afterKey = text(rerender());
  check('arrow keys move between tabs', afterKey.includes('Rules change the verdict'), afterKey);
  const live = nodesOf(rerender()).filter((node) => node.props['aria-live'] === 'polite');
  check('save status announces itself politely', live.length >= 1, afterKey);
})();


await (async () => {
  host.rules = { version: 1, includeSubagents: true, providers: {}, models: {} };
  host.facts = factsOf([localQwen(RECENT, 1000000)], [{ id: 'a', createdAt: TODAY, origin: '', live: true }]);
  let tree = await mountPage();
  const tipsOf = (component) => nodesOf(component).filter((node) => typeof node.props.className === 'string' && node.props.className.indexOf('dsh-ls-tip ') === 0);
  const columnsOf = (component) => nodesOf(component).filter((node) => node.props.className === 'dsh-ls-col');

  check('every bucket is focusable and labelled', columnsOf(tree).every((column) => column.props.tabIndex === 0 && String(column.props['aria-label']).indexOf('¥') > 0), String(columnsOf(tree).length));
  check('no readout before hovering', tipsOf(tree).length === 0, text(tree));

  const busy = columnsOf(tree).find((column) => String(column.props['aria-label']).indexOf('¥2.83') >= 0);
  check('the bucket with usage is labelled with its amount', busy !== undefined, '');
  busy.props.onMouseEnter();
  tree = rerender();
  const tip = tipsOf(tree)[0];
  check('hovering a bucket opens its readout', tip !== undefined, text(tree));
  check('the readout carries both sides', text(tip).indexOf('¥2.83') >= 0 && text(tip).indexOf('¥0.00') >= 0, text(tip));

  busy.props.onMouseLeave();
  tree = rerender();
  check('leaving the bucket closes the readout', tipsOf(tree).length === 0, '');

  const focused = columnsOf(tree).find((column) => String(column.props['aria-label']).indexOf('¥2.83') >= 0);
  focused.props.onFocus();
  tree = rerender();
  check('focus opens the same readout for keyboard users', tipsOf(tree).length === 1, '');

  // Edge buckets anchor the readout inward instead of letting it spill out.
  const columns = columnsOf(tree);
  columns[0].props.onMouseEnter();
  const first = tipsOf(rerender())[0];
  check('the first bucket anchors its readout to the left edge', String(first.props.className).indexOf('dsh-ls-tip-start') >= 0, String(first.props.className));
  columns[columns.length - 1].props.onMouseEnter();
  const last = tipsOf(rerender())[0];
  check('the last bucket anchors it to the right edge', String(last.props.className).indexOf('dsh-ls-tip-end') >= 0, String(last.props.className));
  columns[Math.floor(columns.length / 2)].props.onMouseEnter();
  const middle = tipsOf(rerender())[0];
  check('a middle bucket centres it', String(middle.props.className).indexOf('dsh-ls-tip-center') >= 0, String(middle.props.className));
})();

unmountAll();

let failures = 0;
for (const result of results) {
  if (!result.ok) failures += 1;
  console.log((result.ok ? 'PASS' : 'FAIL') + '  ' + result.name + (result.ok ? '' : ' → ' + JSON.stringify(result.actual).slice(0, 240)));
}
console.log('\n' + (results.length - failures) + '/' + results.length + ' checks passed');
if (failures > 0) process.exitCode = 1;
