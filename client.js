/**
 * Session cost / savings pill for the composer dock.
 *
 * The pill makes one claim: what this session's tokens are worth in money, at
 * the official list price of the model that produced them. When the route is a
 * local provider that claim is money saved; when it is a cloud provider it is
 * estimated spend.
 *
 * Data comes from shipped client projections only:
 *   useProjection('tokenUsage')     session-cumulative provider usage
 *   useProjection('modelSelection') provider/model of the latest request
 *   useTrajectory(...).requests     per-request provider/model/usage/startedAt
 *
 * Two principles drive the numbers:
 *   1. A token is priced at the list price that applied WHEN IT WAS USED, so the
 *      figure never changes just because the clock crossed a peak boundary.
 *      Per-request rows carry `startedAt`; any remainder is priced "now" and
 *      declared in the panel.
 *   2. Nothing is hidden: local savings and cloud spend are both reported, USD
 *      list prices are converted at a stated rate, approximated tiers and
 *      unpublished prices are labelled, and the panel says what the figure
 *      excludes (electricity, hardware).
 *
 * Prices were researched on 2026-11-11; see docs/pricing-research.md.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-local-savings',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PRICE_AS_OF = '2026-11-11';
    const FX_CNY_PER_USD = 6.67;
    const STYLE_ID = 'dsh-local-savings-style';

    /* ------------------------------------------------------------------ */
    /* Copy                                                                */
    /* ------------------------------------------------------------------ */

    const DICTS = {
      en: {
        saved: 'saved',
        spent: 'spent',
        tokensTok: 'tok',
        miss: 'Uncached input',
        hit: 'Cache read',
        write: 'Cache write',
        out: 'Output',
        official: '{vendor} list price',
        officialGeneric: 'each at its own list price',
        windowPeak: 'peak',
        windowOffPeak: 'off-peak · 50%',
        windowMixed: 'per request',
        windowNow: 'current window',
        approximate: 'nearest tier: {tier}',
        approximateGeneric: 'includes approximated tiers',
        noPublishedPrice: 'No published list price',
        unpricedShare: '{pct}% of tokens have no published list price',
        residual: '{pct}% of tokens have no per-request record; priced at current rates',
        otherModels: '{count} more',
        routeLocal: 'Local run · no API fees',
        routeCloud: 'Cloud call · estimated at list price',
        routeMixed: 'Local and cloud calls',
        priceAsOf: 'Prices as of {date}',
        excludesPower: 'excludes power/hardware',
        fxNote: 'USD converted at {rate}',
        modelCount: '{count} models',
        ariaHint: 'Click for the breakdown',
        panelLabel: 'CostOps Hub · session cost breakdown',
      },
      zh: {
        saved: '省下',
        spent: '花费',
        tokensTok: 'tok',
        miss: '未缓存输入',
        hit: '缓存读取',
        write: '缓存写入',
        out: '输出',
        official: '{vendor} 官方价',
        officialGeneric: '按各自官方价',
        windowPeak: '高峰期',
        windowOffPeak: '低谷期 · 五折',
        windowMixed: '按时段',
        windowNow: '按当前时段',
        approximate: '近似档位：{tier}',
        approximateGeneric: '含近似档位',
        noPublishedPrice: '官方未公开价格',
        unpricedShare: '{pct}% 的 token 暂无官方标价',
        residual: '{pct}% 的 token 无逐请求记录，按当前价格估算',
        otherModels: '另有 {count} 个',
        routeLocal: '本地运行 · 未产生 API 费用',
        routeCloud: '云端调用 · 按官方价估算',
        routeMixed: '含本地与云端调用',
        priceAsOf: '价格更新于 {date}',
        excludesPower: '不含电费/硬件',
        fxNote: 'USD 按 1 : {rate} 折算',
        modelCount: '{count} 个模型',
        ariaHint: '点击查看明细',
        panelLabel: '省流中台 · 会话费用明细',
      },
    };

    function preferredLanguage() {
      try {
        if (typeof document !== 'undefined' && document.documentElement !== null) {
          const lang = document.documentElement.lang;
          if (typeof lang === 'string' && lang !== '') return lang.toLowerCase();
        }
      } catch {
        /* ignore */
      }
      try {
        if (typeof navigator === 'object' && navigator !== null && typeof navigator.language === 'string') {
          return navigator.language.toLowerCase();
        }
      } catch {
        /* ignore */
      }
      return 'en';
    }

    function dictFor(lang) {
      return lang.indexOf('zh') === 0 ? DICTS.zh : DICTS.en;
    }

    function format(template, values) {
      let text = template;
      for (const key of Object.keys(values)) {
        text = text.split('{' + key + '}').join(String(values[key]));
      }
      return text;
    }

    /* ------------------------------------------------------------------ */
    /* Routes that are "my own hardware"                                   */
    /* ------------------------------------------------------------------ */

    // Matched on whole id segments ("local", "ollama-7b") rather than raw
    // substrings, so a cloud route whose id merely contains a keyword can never
    // be mistaken for a free local route.
    const LOCAL_PROVIDER_IDS = [
      'local', 'localhost', 'ollama', 'lmstudio', 'lm-studio', 'llamacpp',
      'llama-cpp', 'llama', 'vllm', 'sglang', 'mlx', 'exo', 'omlx', 'ds4',
      'textgen', 'kobold', 'jan', 'openwebui', 'selfhosted', 'self-hosted',
      'spark',
    ];

    function providerSegments(provider) {
      return provider
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((part) => part !== '');
    }

    function isLocalProvider(provider) {
      if (typeof provider !== 'string' || provider === '') return false;
      const segments = providerSegments(provider);
      const joined = segments.join('-');
      return LOCAL_PROVIDER_IDS.some((id) => segments.indexOf(id) >= 0 || joined === id);
    }

    /* ------------------------------------------------------------------ */
    /* Official list prices, per 1,000,000 tokens.                         */
    /* Ordered most specific first; the first matching row wins.           */
    /* ------------------------------------------------------------------ */

    const PRICING = [
      // DeepSeek — https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
      // Every match token is vendor-prefixed on purpose: a bare "flash" would
      // also match "glm-5.3-flash", which is a different vendor's price list.
      { vendor: 'DeepSeek', currency: 'CNY', match: ['deepseek-v4.1-flash', 'v4.1-flash', 'deepseek-v4-flash', 'v4-flash', 'deepseek-flash'], label: 'deepseek-flash', miss: 2, hit: 0.04, out: 8, offPeakFactor: 0.5, assume: false, exactIds: ['deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash', 'deepseek-flash'] },
      { vendor: 'DeepSeek', currency: 'CNY', match: ['deepseek-v4-pro', 'deepseek-v4.1-pro', 'v4-pro'], label: 'deepseek-v4-pro', miss: 9, hit: 0.3, out: 27, offPeakFactor: 0.5, assume: false, exactIds: ['deepseek-v4-pro', 'deepseek-v4.1-pro'] },
      { vendor: 'DeepSeek', currency: 'CNY', match: ['deepseek'], label: 'deepseek-flash', miss: 2, hit: 0.04, out: 8, offPeakFactor: 0.5, assume: true },

      // Zhipu GLM — https://docs.bigmodel.cn/cn/guide/start/pricing
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm-5.3-flashx-legal', 'glm-5.3-flashx'], label: 'GLM-5.3-FlashX', miss: 2, hit: 0.57, out: 7, assume: false, exactIds: ['glm-5.3-flashx', 'glm-5.3-flashx-legal'] },
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm-5.3-flash'], label: 'GLM-5.3-Flash', miss: 0.8, hit: 0.23, out: 2.8, assume: true, exactIds: ['glm-5.3-flash'] },
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm-5.3'], label: 'GLM-5.3', miss: 8, hit: 2, out: 28, assume: false, exactIds: ['glm-5.3'] },
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm-5.2'], label: 'GLM-5.2', miss: 8, hit: 2, out: 28, assume: false },
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm-5.1'], label: 'GLM-5.1', miss: 6, hit: 1.3, out: 24, assume: false },
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm-5-turbo', 'glm-5v-turbo'], label: 'GLM-5-Turbo', miss: 5, hit: 1.2, out: 22, assume: false },
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm-5'], label: 'GLM-5', miss: 4, hit: 1, out: 18, assume: false },
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm-4.7'], label: 'GLM-4.7', miss: 2, hit: 0.4, out: 8, assume: false },
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm-4.6', 'glm-4.6v'], label: 'GLM-4.7', miss: 2, hit: 0.4, out: 8, assume: true },
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm-4.5-air'], label: 'GLM-4.5-Air', miss: 0.8, hit: 0.16, out: 2, assume: false },
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm-4.5'], label: 'GLM-4.7', miss: 2, hit: 0.4, out: 8, assume: true },
      { vendor: 'Zhipu', currency: 'CNY', match: ['glm'], label: 'GLM-5', miss: 4, hit: 1, out: 18, assume: true },

      // Alibaba Qwen — https://www.alibabacloud.com/help/zh/model-studio/model-pricing (USD)
      // qwen3.8-27b uses the 华北2（北京） list price (Singapore is 0.5 / 0.1 / 3 / 0.625).
      { vendor: 'Qwen', currency: 'USD', match: ['qwen3.8-27b'], label: 'qwen3.8-27b', miss: 0.424, hit: 0.085, out: 1.696, write: 0.53, assume: false, exactIds: ['qwen3.8-27b'] },
      { vendor: 'Qwen', currency: 'USD', match: ['qwen3.8-max', 'qwen3.7-max', 'qwen-max'], label: 'qwen3.8-max', miss: 2, hit: 0.2, out: 6, assume: false, exactIds: ['qwen3.8-max'] },
      { vendor: 'Qwen', currency: 'USD', match: ['qwen3.8-flash', 'qwen3.7-flash', 'qwen-flash'], label: 'qwen3.8-flash', miss: 0.15, hit: 0.015, out: 0.47, assume: false, exactIds: ['qwen3.8-flash'] },
      { vendor: 'Qwen', currency: 'USD', match: ['qwen'], label: 'qwen3.8-flash', miss: 0.15, hit: 0.015, out: 0.47, assume: true },

      // Moonshot Kimi — https://platform.kimi.ai/docs/pricing/chat (client-rendered tables, no readable numbers)
      { vendor: 'Moonshot', currency: 'USD', match: ['kimi', 'moonshot'], label: 'Kimi K3', miss: null, hit: null, out: null, assume: false, exactIds: [] },
    ];

    function resolvePrice(model) {
      if (typeof model !== 'string' || model === '') return null;
      const id = model.toLowerCase();
      for (const row of PRICING) {
        for (const token of row.match) {
          if (id.indexOf(token) >= 0) return row;
        }
      }
      return null;
    }

    /**
     * Artifact tags that name the same weights as the official service:
     * "Qwen3.8-27B-Instruct-AWQ" and "GLM-5.3-Flash-EXL3" are the same model at
     * the same tier, so they are priced without an approximation notice.
     */
    const ARTIFACT_SUFFIXES = [
      '-instruct', '-chat', '-base', '-it', '-awq', '-gptq', '-exl2', '-exl3',
      '-gguf', '-int4', '-int8', '-fp4', '-fp8', '-bf16', '-fp16', '-4bit', '-8bit',
      '-q4-k-m', '-q5-k-m', '-q8-0', '-v1',
    ];

    function canonicalModelId(model) {
      let id = model.toLowerCase().trim();
      let stripped = true;
      while (stripped) {
        stripped = false;
        for (const suffix of ARTIFACT_SUFFIXES) {
          if (id.length > suffix.length && id.endsWith(suffix)) {
            id = id.slice(0, -suffix.length);
            stripped = true;
          }
        }
      }
      return id;
    }

    function isExactModel(price, model) {
      if (typeof model !== 'string' || !Array.isArray(price.exactIds)) return false;
      const id = canonicalModelId(model);
      return price.exactIds.some((exact) => exact === id);
    }

    /* ------------------------------------------------------------------ */
    /* Time-of-day pricing (DeepSeek publishes a peak/off-peak list price)  */
    /* ------------------------------------------------------------------ */

    let peakFormatter = null;

    function deepSeekPeakFormatter() {
      if (peakFormatter === null) {
        peakFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Shanghai',
          hour: '2-digit',
          minute: '2-digit',
          weekday: 'short',
          hourCycle: 'h23',
        });
      }
      return peakFormatter;
    }

    /** Beijing time, Mon-Fri 09:00-12:00 and 14:00-18:00; holidays not modelled. */
    function isPeak(date) {
      try {
        const parts = deepSeekPeakFormatter().formatToParts(date);
        const pick = (type) => {
          for (const part of parts) {
            if (part.type === type) return part.value;
          }
          return '';
        };
        const weekday = pick('weekday');
        if (weekday === 'Sat' || weekday === 'Sun') return false;
        const minutes = Number(pick('hour')) * 60 + Number(pick('minute'));
        return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
      } catch {
        return true;
      }
    }

    function toDate(value) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value);
      if (typeof value === 'string' && value !== '') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return new Date(parsed);
      }
      return null;
    }

    /**
     * The multiplier applied to one contribution. A contribution with a known
     * timestamp is priced at that moment; the rest is priced now.
     */
    function factorAt(price, date) {
      if (typeof price.offPeakFactor !== 'number') return 1;
      return isPeak(date === null ? new Date() : date) ? 1 : price.offPeakFactor;
    }

    /* ------------------------------------------------------------------ */
    /* Usage → money                                                       */
    /* ------------------------------------------------------------------ */

    function emptyUsage() {
      return { miss: 0, hit: 0, write: 0, out: 0 };
    }

    function normalizeUsage(usage) {
      if (usage === null || typeof usage !== 'object') return null;
      const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
      const miss = num(usage.inputTokens !== undefined ? usage.inputTokens : usage.input !== undefined ? usage.input : usage.uncachedInputTokens);
      const hit = num(usage.cacheReadTokens !== undefined ? usage.cacheReadTokens : usage.cacheRead);
      const write = num(usage.cacheWriteTokens !== undefined ? usage.cacheWriteTokens : usage.cacheWrite);
      const out = num(usage.outputTokens !== undefined ? usage.outputTokens : usage.output);
      if (miss + hit + write + out === 0) return null;
      return { miss, hit, write, out };
    }

    function addUsage(into, part) {
      into.miss += part.miss;
      into.hit += part.hit;
      into.write += part.write;
      into.out += part.out;
      return into;
    }

    function subtractUsage(a, b) {
      return {
        miss: Math.max(0, a.miss - b.miss),
        hit: Math.max(0, a.hit - b.hit),
        write: Math.max(0, a.write - b.write),
        out: Math.max(0, a.out - b.out),
      };
    }

    function totalOf(usage) {
      return usage.miss + usage.hit + usage.write + usage.out;
    }

    function emptyCost() {
      return { miss: 0, hit: 0, write: 0, out: 0 };
    }

    /** Native-currency cost per token bucket for one usage sample. */
    function costBuckets(usage, price, factor) {
      const hitPrice = price.hit === null ? price.miss : price.hit;
      const writePrice = typeof price.write === 'number' ? price.write : price.miss;
      const scale = factor / 1e6;
      return {
        miss: usage.miss * price.miss * scale,
        hit: usage.hit * hitPrice * scale,
        write: usage.write * writePrice * scale,
        out: usage.out * price.out * scale,
      };
    }

    function toCnyBuckets(cost, currency) {
      const rate = currency === 'USD' ? FX_CNY_PER_USD : 1;
      return {
        miss: cost.miss * rate,
        hit: cost.hit * rate,
        write: cost.write * rate,
        out: cost.out * rate,
      };
    }

    function addCost(into, part) {
      into.miss += part.miss;
      into.hit += part.hit;
      into.write += part.write;
      into.out += part.out;
      return into;
    }

    function sumCost(cost) {
      return cost.miss + cost.hit + cost.write + cost.out;
    }

    function canPrice(price) {
      return price !== null && price.miss !== null && price.miss !== undefined && price.out !== null && price.out !== undefined;
    }

    /* ------------------------------------------------------------------ */
    /* Requests → per-model rows (native attribution)                      */
    /* ------------------------------------------------------------------ */

    function requestModel(request) {
      if (typeof request.model === 'string' && request.model !== '') return request.model;
      const metadata = request.providerMetadata;
      if (metadata !== null && typeof metadata === 'object' && typeof metadata.model === 'string') return metadata.model;
      return '';
    }

    function requestProvider(request) {
      if (typeof request.provider === 'string' && request.provider !== '') return request.provider;
      const metadata = request.providerMetadata;
      if (metadata !== null && typeof metadata === 'object' && typeof metadata.provider === 'string') return metadata.provider;
      return '';
    }

    function newRow(provider, model) {
      return {
        provider,
        model,
        usage: emptyUsage(),
        cny: emptyCost(),
        priced: false,
        local: isLocalProvider(provider),
        converted: false,
        approximate: false,
        windows: { peak: false, offPeak: false, current: false },
        price: null,
      };
    }

    function addContribution(row, usage, price, date) {
      addUsage(row.usage, usage);
      if (!canPrice(price)) {
        row.price = row.price === null ? price : row.price;
        return;
      }
      const factor = factorAt(price, date);
      addCost(row.cny, toCnyBuckets(costBuckets(usage, price, factor), price.currency));
      row.priced = true;
      row.price = row.price === null ? price : row.price;
      if (price.currency === 'USD') row.converted = true;
      if (price.assume === true && !isExactModel(price, row.model)) row.approximate = true;
      if (date === null) row.windows.current = true;
      else if (factor < 1) row.windows.offPeak = true;
      else row.windows.peak = true;
    }

    function rowKey(provider, model) {
      return provider + '\u0000' + model;
    }

    /**
     * Builds one row per provider+model from the per-request trajectory.
     * Requests are priced with their own `startedAt`, so a session that spans a
     * peak boundary keeps the price it was actually exposed to.
     */
    function rowsFromRequests(requests, accumulator) {
      if (!Array.isArray(requests)) return accumulator;
      for (const request of requests) {
        if (request === null || typeof request !== 'object') continue;
        const model = requestModel(request);
        if (model === '') continue;
        const usage = normalizeUsage(request.usage);
        if (usage === null) continue;
        const provider = requestProvider(request);
        const key = rowKey(provider, model);
        let row = accumulator.get(key);
        if (row === undefined) {
          row = newRow(provider, model);
          accumulator.set(key, row);
        }
        addContribution(row, usage, resolvePrice(model), toDate(request.startedAt !== undefined ? request.startedAt : request.completedAt));
      }
      return accumulator;
    }

    /* ------------------------------------------------------------------ */
    /* Whole view model                                                    */
    /* ------------------------------------------------------------------ */

    const BUCKET_KEYS = ['miss', 'hit', 'write', 'out'];

    function windowLabel(row, t) {
      const peak = row.windows.peak;
      const offPeak = row.windows.offPeak;
      const current = row.windows.current;
      if (peak && offPeak) return t('windowMixed');
      if (peak && current) return t('windowMixed');
      if (offPeak && current) return t('windowMixed');
      if (peak) return t('windowPeak');
      if (offPeak) return t('windowOffPeak');
      if (current) return t('windowNow');
      return '';
    }

    function buildView(totals, selection, requests) {
      const rows = [];
      const accumulator = new Map();

      try {
        rowsFromRequests(requests, accumulator);
      } catch {
        accumulator.clear();
      }

      const attributed = emptyUsage();
      accumulator.forEach((row) => addUsage(attributed, row.usage));
      accumulator.forEach((row) => rows.push(row));

      // Tokens the trajectory did not account for (compaction, retries, a
      // session opened from history before the live source exists) are priced
      // at the model the composer would use now, and declared as such.
      const residual = subtractUsage(totals, attributed);
      let residualShare = 0;
      if (totalOf(residual) > 0) {
        residualShare = totalOf(residual) / Math.max(1, totalOf(totals));
        if (rows.length === 0) residualShare = 0;
        const lastUsed = selection !== null && selection !== undefined ? selection.lastUsed : null;
        const next = selection !== null && selection !== undefined ? selection.next : null;
        const model = (lastUsed && lastUsed.model) || (next && next.model) || '';
        const provider = (lastUsed && lastUsed.provider) || (next && next.provider) || '';
        const key = rowKey(provider, model);
        let row = accumulator.get(key);
        if (row === undefined) {
          row = newRow(provider, model);
          accumulator.set(key, row);
          rows.push(row);
        }
        addContribution(row, residual, resolvePrice(model), null);
      }

      // Amounts, buckets and the two totals.
      const buckets = emptyCost();
      let tokens = 0;
      let savedCny = 0;
      let spentCny = 0;
      let unpricedTokens = 0;
      let hasLocal = false;
      let hasCloud = false;
      let converted = false;
      let approximate = false;
      let pricedCount = 0;
      for (const row of rows) {
        const rowTokens = totalOf(row.usage);
        tokens += rowTokens;
        row.tokens = rowTokens;
        row.amount = row.priced ? sumCost(row.cny) : null;
        if (row.priced) {
          pricedCount += 1;
          addCost(buckets, row.cny);
          if (row.local) savedCny += row.amount;
          else spentCny += row.amount;
          converted = converted || row.converted;
          approximate = approximate || row.approximate;
        } else {
          unpricedTokens += rowTokens;
        }
        if (row.local) hasLocal = true;
        else hasCloud = true;
      }

      rows.sort((a, b) => {
        const left = a.amount === null ? -1 : a.amount;
        const right = b.amount === null ? -1 : b.amount;
        return right - left;
      });

      const composition = [];
      if (pricedCount > 0) {
        for (const key of BUCKET_KEYS) {
          const amount = buckets[key];
          if (amount > 0) composition.push({ key, amount });
        }
        composition.sort((a, b) => b.amount - a.amount);
      }

      return {
        rows,
        tokens,
        composition,
        savedCny,
        spentCny,
        hasLocal,
        hasCloud,
        converted,
        approximate,
        pricedCount,
        unpricedTokens,
        residualShare,
      };
    }

    /* ------------------------------------------------------------------ */
    /* Formatting                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * Fixed formatting, independent of the host locale: the same figures must be
     * rendered the same way in every window.
     */
    function groupThousands(text) {
      return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function tokenText(value) {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
      if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K';
      return groupThousands(String(Math.round(n)));
    }

    /** Money keeps two decimals, gains precision only below ¥0.10, and never pads. */
    function decimalText(value) {
      const abs = Math.abs(value);
      let digits = 2;
      if (abs > 0 && abs < 0.01) digits = 4;
      else if (abs > 0 && abs < 0.1) digits = 3;
      let text = abs.toFixed(digits);
      while (text.endsWith('0')) text = text.slice(0, -1);
      if (text.endsWith('.')) text = text.slice(0, -1);
      const dot = text.indexOf('.');
      const decimals = dot < 0 ? 0 : text.length - dot - 1;
      if (decimals < 2) text = text + (decimals === 0 ? '.' : '') + '0'.repeat(2 - decimals);
      const parts = text.split('.');
      return groupThousands(parts[0]) + '.' + parts[1];
    }

    function money(amount) {
      if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
      return '¥' + decimalText(Math.abs(amount));
    }

    function shortMoney(amount) {
      if (!Number.isFinite(amount)) return '—';
      if (amount > 0 && amount < 0.01) return '<¥0.01';
      return money(amount);
    }

    function percentText(share) {
      const value = share * 100;
      if (value >= 10) return String(Math.round(value));
      return value >= 1 ? value.toFixed(0) : value.toFixed(1);
    }

    /* ------------------------------------------------------------------ */
    /* Page copy — the bill page and the route rules                       */
    /* ------------------------------------------------------------------ */

    const PAGE_DICTS = {
      en: {
        title: 'CostOps Hub',
        subtitle: 'Official list prices: money saved locally, money spent in the cloud, and the net.',
        subtitleFull: 'Every settled request is priced at the list price that applied when it ran: a local run books money not spent, a cloud call books money spent.',
        tabBill: 'Bills',
        tabRules: 'Route rules',
        current: 'This session',
        sessionWindow: 'This session: {name} · read from the ledger; may differ from the pill by about a minute of usage',
        hour: 'Last hour',
        today: 'Today',
        week: 'Last 7 days',
        month: 'Last 30 days',
        refresh: 'Refresh',
        refreshing: 'Reading…',
        saved: 'Saved',
        spent: 'Spent',
        netSaved: 'Net saved',
        netSpent: 'Net over',
        savedMeta: '{tokens} tok · {calls} requests',
        spentMeta: '{tokens} tok · {calls} requests',
        netMeta: 'prices as of {date}',
        netAgainstSpend: 'local routes covered {pct}% of cloud spend',
        trendTitle: 'Saved and spent per {unit}',
        unitHour: '5 minutes',
        unitToday: 'hour',
        unitWeek: 'day',
        unitMonth: 'day',
        legendSaved: 'local · not spent',
        legendSpent: 'cloud · spent',
        modelsCard: 'Models',
        modelsHint: 'sorted by money · open a row for its sessions',
        peakLabel: 'peak {amount}',
        noModels: 'No model in this window',
        deltaTitle: 'versus the previous equal window',
        noRows: 'No usage in this window yet.',
        noRowsHint: 'Send a message and come back: every settled request is booked here.',
        unpriced: '{pct}% of tokens have no published list price',
        approximate: 'includes approximated tiers',
        scanning: 'Reading history {covered}/{total} sessions…',
        scanned: '{sessions} session logs · {subagents} sub-agent sessions',
        errors: '{count} logs unreadable',
        rulesSourceConfig: 'Rules live in this plugin configuration (cordis.patch.yml), so they travel with the profile.',
        rulesSourceFile: 'Rules live in the plugin data folder (rules.v1.json): this profile has no configuration editor.',
        rulesSourceUnknown: 'Rules have not been loaded yet.',
        rulesSourceNote: 'Saved without configuration: {reason}',
        rulesIntro: 'Rules change the verdict, never the facts: the ledger keeps tokens and timestamps, so every past bill is recalculated the moment a rule changes.',
        providersTitle: 'Providers',
        providersHint: 'Auto follows the built-in heuristic (an id that looks local is local). Your choice wins over it.',
        modelsTitle: 'Model exceptions',
        rulesModelsHint: 'One provider can serve both worlds. A model exception wins over the provider rule.',
        includeSubagents: 'Count sub-agent sessions',
        includeSubagentsHint: 'Delegated work is real spend; turn this off to review the main session only.',
        auto: 'Auto',
        local: 'Local',
        cloud: 'Cloud',
        add: 'Add',
        remove: 'Remove',
        modelPlaceholder: 'model id, e.g. qwen3.8-27b',
        saveFailed: 'Rules were not saved: {reason}',
        savedNote: 'Saved',
        saving: 'Saving…',
        retry: 'Retry',
        loadFailed: 'Cannot read the ledger',
        routeHint: 'The Host half answers at {route}. If this persists the bundle needs a reload.',
        empty: 'No usage recorded yet',
        emptyHint: 'This page books settled requests from every session. Send one message, then refresh.',
        excludesPower: 'excludes power/hardware',
        drillHint: 'Break down by session',
        drillTitle: '{count} sessions contributed',
        drillEmpty: 'No session in this window',
        openSession: 'Open this session\'s bill',
        backToCurrent: 'back to the current session',
        drillMore: '{count} more sessions',
        drillCalls: '{count} requests',
        drillLast: 'last {time}',
        noTitle: '(untitled session)',

        subagent: 'sub-agent',
        exportCsv: 'Export CSV',
        exportHint: 'Write this window as CSV into the plugin data folder',
        exported: 'Saved to {path}',
        exportFailed: 'Export failed: {reason}',
        deltaNew: 'new',
        updatedAt: 'updated {time}',
        totalRow: 'Total',
        noProvider: '(no provider)',
        modelUnknown: '(model id missing)',
      },
      zh: {
        title: '省流中台',
        subtitle: '按官方 API 价折算：本地省下的钱、云端花掉的钱，和净额。',
        subtitleFull: '每个已结算请求都按它自己的官方价折算：本地跑掉的记成没花出去的钱，云端调用的记成花出去的钱。',
        tabBill: '账单',
        tabRules: '口径',
        current: '本会话',
        sessionWindow: '本会话：{name} · 读数来自账本，与胶囊可能有约一分钟的出入',
        hour: '近1小时',
        today: '今天',
        week: '近7天',
        month: '近30天',
        refresh: '刷新',
        refreshing: '读取中…',
        saved: '省麻了',
        spent: '花麻了',
        netSaved: '净省',
        netSpent: '净花',
        savedMeta: '本地 {tokens} tok · {calls} 次请求',
        spentMeta: '在线 {tokens} tok · {calls} 次请求',
        netMeta: '价格更新于 {date}',
        netAgainstSpend: '本地线路抵扣了 {pct}% 的云端支出',
        trendTitle: '每{unit}的省与花',
        unitHour: '5分钟',
        unitToday: '小时',
        unitWeek: '天',
        unitMonth: '天',
        legendSaved: '本地 · 没花出去',
        legendSpent: '在线 · 花出去',
        modelsCard: '模型',
        modelsHint: '按金额排序 · 点开可按会话拆解',
        peakLabel: '峰值 {amount}',
        noModels: '这个窗口没有模型记录',
        deltaTitle: '与上一个等长窗口比较',
        noRows: '这个时间窗还没有用量。',
        noRowsHint: '发一条消息再回来：每个已结算请求都会记在这里。',
        unpriced: '{pct}% 的 token 没有官方标价',
        approximate: '含近似档位',
        scanning: '正在回溯历史会话 {covered}/{total} 个…',
        scanned: '{sessions} 个会话日志 · {subagents} 个子代理会话',
        errors: '{count} 个日志读取失败',
        rulesSourceConfig: '口径存在这个插件的配置里（cordis.patch.yml），跟着 profile 一起走。',
        rulesSourceFile: '口径存在插件数据目录的 rules.v1.json：这个 profile 没有配置编辑器。',
        rulesSourceUnknown: '口径还没读出来。',
        rulesSourceNote: '已保存，但没写进插件配置：{reason}',
        rulesIntro: '口径只改判断，不改事实：账本存的是 token 与时间戳，所以任何规则一改，历史账单立刻重算。',
        providersTitle: 'Provider 口径',
        providersHint: '自动 = 用内置启发式（id 看起来是本地的就算本地）。你的选择优先级更高。',
        modelsTitle: '模型例外',
        rulesModelsHint: '同一个 provider 可能既跑本地又代理云端，所以模型例外优先于 provider。',
        includeSubagents: '计入子代理会话',
        includeSubagentsHint: '被委派的工作也是真实花费；关掉只看主会话。',
        auto: '自动',
        local: '本地',
        cloud: '在线',
        add: '添加',
        remove: '删除',
        modelPlaceholder: '模型 id，例如 qwen3.8-27b',
        saveFailed: '规则没保存成功：{reason}',
        savedNote: '已保存',
        saving: '保存中…',
        retry: '重试',
        loadFailed: '读不到账本',
        routeHint: 'Host 端接口在 {route}。如果一直这样，插件需要重新加载一次。',
        empty: '还没有记录到用量',
        emptyHint: '这一页会统计所有会话的已结算请求。发一条消息，再刷新。',
        excludesPower: '不含电费/硬件',
        drillHint: '按会话拆解',
        drillTitle: '{count} 个会话贡献',
        drillEmpty: '这个窗口没有会话记录',
        openSession: '查看这个会话的账单',
        backToCurrent: '回到当前会话',
        drillMore: '另有 {count} 个会话',
        drillCalls: '{count} 次请求',
        drillLast: '最后 {time}',
        noTitle: '（未命名会话）',

        subagent: '子代理',
        exportCsv: '导出 CSV',
        exportHint: '把这个窗口写成 CSV，存到插件数据目录',
        exported: '已导出：{path}',
        exportFailed: '导出失败：{reason}',
        deltaNew: '新增',
        updatedAt: '更新于 {time}',
        totalRow: '合计',
        noProvider: '（未记录 provider）',
        modelUnknown: '（缺模型 id）',
      },
    };

    function pageDict(lang) {
      return lang.indexOf('zh') === 0 ? PAGE_DICTS.zh : PAGE_DICTS.en;
    }

    /* ------------------------------------------------------------------ */
    /* Facts → bill view                                                   */
    /* ------------------------------------------------------------------ */

    const API_PATH = '/plugins/local-savings/api';
    const LEDGER_DAY = 86400000;
    /** Asia/Shanghai has no DST, so one fixed offset buckets every window. */
    const LEDGER_OFFSET = 8 * 3600000;

    const DEFAULT_RULES = { version: 1, includeSubagents: true, providers: {}, models: {} };

    /** Two rule sets are equal when their verdicts are; the version is noise. */
    function rulesEqual(left, right) {
      const shape = (rules) => {
        const source = rules !== null && rules !== undefined ? rules : {};
        return JSON.stringify({
          includeSubagents: source.includeSubagents !== false,
          providers: source.providers !== undefined && source.providers !== null ? source.providers : {},
          models: source.models !== undefined && source.models !== null ? source.models : {},
        });
      };
      return shape(left) === shape(right);
    }

    function errorText(error) {
      const raw = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error);
      return raw.length > 200 ? raw.slice(0, 197) + '…' : raw;
    }

    async function readJson(path) {
      const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const text = await response.text();
      let payload = null;
      if (text !== '') {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      if (payload === null) throw new Error('HTTP ' + String(response.status));
      return payload;
    }

    function postJson(body) {
      return fetch(API_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (response) => {
        const text = await response.text();
        let payload = null;
        if (text !== '') {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = null;
          }
        }
        if (payload === null) throw new Error('HTTP ' + String(response.status));
        return payload;
      });
    }

    function localDayStart(ms) {
      return Math.floor((ms + LEDGER_OFFSET) / LEDGER_DAY) * LEDGER_DAY - LEDGER_OFFSET;
    }

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    function clockLabel(ms) {
      const local = new Date(ms + LEDGER_OFFSET);
      return pad2(local.getUTCHours()) + ':' + pad2(local.getUTCMinutes());
    }

    function dayLabel(ms) {
      const local = new Date(ms + LEDGER_OFFSET);
      return pad2(local.getUTCMonth() + 1) + '-' + pad2(local.getUTCDate());
    }

    /**
     * The four bill windows. Buckets are uniform so a row's column is one
     * division, and the day boundary is Beijing midnight, the same boundary the
     * peak/off-peak price list uses.
     */
    function windowSpec(key, now) {
      if (key === 'hour') {
        const from = now - 3600000;
        const buckets = [];
        for (let index = 0; index < 12; index += 1) {
          const start = from + index * 300000;
          buckets.push({ from: start, to: start + 300000, label: clockLabel(start) });
        }
        return { key, from, to: now, buckets, unit: 'hour' };
      }
      if (key === 'today') {
        const from = localDayStart(now);
        const buckets = [];
        for (let hour = 0; hour < 24; hour += 1) {
          const start = from + hour * 3600000;
          buckets.push({ from: start, to: start + 3600000, label: pad2(hour) + ':00' });
        }
        return { key, from, to: now, buckets, unit: 'today' };
      }
      const days = key === 'week' ? 7 : 30;
      const from = localDayStart(now) - (days - 1) * LEDGER_DAY;
      const buckets = [];
      for (let index = 0; index < days; index += 1) {
        const start = from + index * LEDGER_DAY;
        buckets.push({ from: start, to: start + LEDGER_DAY, label: dayLabel(start) });
      }
      return { key, from, to: now, buckets, unit: key === 'week' ? 'week' : 'month' };
    }

    /**
     * The window for one session: its own span, bucketed by hour when it fits in
     * two days and by day beyond that, so a long session still draws a trend.
     */
    function sessionSpec(facts, sessionId, now) {
      const sessions = facts !== null && facts !== undefined && Array.isArray(facts.sessions) ? facts.sessions : [];
      const rows = facts !== null && facts !== undefined && Array.isArray(facts.rows) ? facts.rows : [];
      const index = sessions.findIndex((session) => session !== null && session !== undefined && session.id === sessionId);
      let first = now;
      if (index >= 0) {
        for (const row of rows) {
          if (row[1] === index && row[0] < first) first = row[0];
        }
      }
      const hourly = now - first <= 2 * LEDGER_DAY;
      const width = hourly ? 3600000 : LEDGER_DAY;
      const start = hourly ? Math.floor(first / width) * width : localDayStart(first);
      const buckets = [];
      for (let at = start; at <= now && buckets.length < 80; at += width) {
        buckets.push({ from: at, to: at + width, label: hourly ? clockLabel(at) : dayLabel(at) });
      }
      if (buckets.length === 0) buckets.push({ from: now - width, to: now, label: hourly ? clockLabel(now) : dayLabel(now) });
      return { key: 'session', unit: hourly ? 'today' : 'month', from: buckets[0].from, to: now, buckets, sessionId };
    }

    /** The session with the latest fact — the best guess when the UI names none. */
    function newestSessionId(facts) {
      const sessions = facts !== null && facts !== undefined && Array.isArray(facts.sessions) ? facts.sessions : [];
      const rows = facts !== null && facts !== undefined && Array.isArray(facts.rows) ? facts.rows : [];
      let best = '';
      let bestAt = 0;
      for (const row of rows) {
        if (Array.isArray(row) !== true || row.length < 2) continue;
        if (typeof row[0] !== 'number' || row[0] <= bestAt) continue;
        const session = sessions[row[1]];
        if (session === null || session === undefined || typeof session.id !== 'string') continue;
        bestAt = row[0];
        best = session.id;
      }
      return best;
    }

    /**
     * The local/cloud verdict for one request. A model exception is the most
     * specific statement a user can make, so it wins; then an explicit provider
     * rule; then the built-in heuristic.
     */
    function classifyRoute(provider, model, rules) {
      const source = rules !== null && rules !== undefined ? rules : DEFAULT_RULES;
      const models = source.models !== null && typeof source.models === 'object' ? source.models : {};
      const providers = source.providers !== null && typeof source.providers === 'object' ? source.providers : {};
      const raw = typeof model === 'string' ? model.trim() : '';
      if (raw !== '') {
        const canonical = canonicalModelId(raw);
        const verdict = models[raw.toLowerCase()] ?? models[canonical];
        if (verdict === 'local' || verdict === 'cloud') return verdict;
      }
      const forced = providers[provider];
      if (forced === 'local' || forced === 'cloud') return forced;
      return isLocalProvider(provider) ? 'local' : 'cloud';
    }

    function bucketOf(spec, time) {
      if (spec.buckets.length === 0) return null;
      const width = spec.buckets[0].to - spec.buckets[0].from;
      const index = Math.floor((time - spec.buckets[0].from) / width);
      return spec.buckets[Math.min(spec.buckets.length - 1, Math.max(0, index))];
    }

    /**
     * Fold fact rows into one window's bill: money per route, a token scale,
     * one column per bucket and one row per model.
     *
     * Money is recomputed here, from the facts, on every render — which is the
     * whole point of keeping the ledger price-free.
     */
    /**
     * Price one fact row. The bill, the session drill-down and the CSV export
     * all call this, so one request can never be counted two ways on one screen.
     */
    function rowCost(row, rules) {
      const provider = typeof row[3] === 'string' ? row[3] : '';
      const model = typeof row[4] === 'string' ? row[4] : '';
      const usage = { miss: row[5], hit: row[6], write: row[7], out: row[8] };
      const tokens = totalOf(usage);
      const route = classifyRoute(provider, model, rules);
      const price = resolvePrice(model);
      let amount = null;
      let approximate = false;
      if (canPrice(price)) {
        amount = sumCost(toCnyBuckets(costBuckets(usage, price, factorAt(price, new Date(row[0]))), price.currency));
        if (price.assume === true && isExactModel(price, model) !== true) approximate = true;
      }
      return { provider, model, usage, tokens, route, amount, approximate, price };
    }

    function buildBill(facts, spec, rules) {
      const sessions = facts !== null && facts !== undefined && Array.isArray(facts.sessions) ? facts.sessions : [];
      const rows = facts !== null && facts !== undefined && Array.isArray(facts.rows) ? facts.rows : [];
      const columns = spec.buckets.map((bucket) => ({ from: bucket.from, to: bucket.to, label: bucket.label, saved: 0, spent: 0, tokens: 0 }));
      const byModel = new Map();
      const totals = {
        saved: 0,
        spent: 0,
        calls: 0,
        localCalls: 0,
        cloudCalls: 0,
        localTokens: 0,
        cloudTokens: 0,
        unpricedTokens: 0,
        models: 0,
      };
      let approximate = false;
      const width = spec.buckets.length > 0 ? spec.buckets[0].to - spec.buckets[0].from : 1;
      const origin = spec.buckets.length > 0 ? spec.buckets[0].from : 0;

      for (const row of rows) {
        if (Array.isArray(row) !== true || row.length < 9) continue;
        const time = row[0];
        if (typeof time !== 'number' || time < spec.from || time > spec.to) continue;
        const session = sessions[row[1]];
        if (spec.sessionId !== undefined && session !== undefined && session !== null && session.id !== spec.sessionId) continue;
        if (rules !== null && rules !== undefined && rules.includeSubagents === false && session !== undefined && session !== null && session.origin === 'subagent') continue;
        const cost = rowCost(row, rules);
        const provider = cost.provider;
        const model = cost.model;
        const usage = cost.usage;
        const tokens = cost.tokens;
        if (tokens === 0) continue;
        const route = cost.route;
        const amount = cost.amount;
        if (cost.approximate === true) approximate = true;

        const key = provider + '\u0000' + model;
        let entry = byModel.get(key);
        if (entry === undefined) {
          entry = { provider, model, route, tokens: 0, calls: 0, saved: 0, spent: 0, amount: 0, priced: false, unpricedTokens: 0, miss: 0, hit: 0, write: 0, out: 0 };
          byModel.set(key, entry);
          totals.models += 1;
        }
        entry.tokens += tokens;
        entry.calls += 1;
        entry.miss += usage.miss;
        entry.hit += usage.hit;
        entry.write += usage.write;
        entry.out += usage.out;
        if (amount === null) {
          entry.unpricedTokens += tokens;
          totals.unpricedTokens += tokens;
        } else {
          entry.priced = true;
          entry.amount += amount;
          if (route === 'local') {
            entry.saved += amount;
            totals.saved += amount;
          } else {
            entry.spent += amount;
            totals.spent += amount;
          }
        }

        if (route === 'local') {
          totals.localTokens += tokens;
          totals.localCalls += 1;
        } else {
          totals.cloudTokens += tokens;
          totals.cloudCalls += 1;
        }
        totals.calls += 1;

        if (columns.length > 0) {
          const index = Math.floor((time - origin) / width);
          const column = columns[Math.min(columns.length - 1, Math.max(0, index))];
          column.tokens += tokens;
          if (amount !== null) {
            if (route === 'local') column.saved += amount;
            else column.spent += amount;
          }
        }
      }

      const entries = [...byModel.values()];
      const savedList = entries
        .filter((entry) => entry.route === 'local' && entry.priced === true && entry.saved > 0)
        .sort((left, right) => right.saved - left.saved)
        .slice(0, 5);
      const spentList = entries
        .filter((entry) => entry.route === 'cloud' && entry.priced === true && entry.spent > 0)
        .sort((left, right) => right.spent - left.spent)
        .slice(0, 5);
      let maxColumn = 0;
      for (const column of columns) {
        const total = column.saved + column.spent;
        if (total > maxColumn) maxColumn = total;
      }
      let unpricedModels = 0;
      for (const entry of entries) {
        if (entry.priced !== true) unpricedModels += 1;
      }

      entries.sort((left, right) => right.amount - left.amount);
      return { spec, columns, totals, entries, savedList, spentList, maxColumn, approximate, unpricedModels };
    }

    /**
     * The equal-length stretch immediately before a window. "Today" shifts by a
     * whole day rather than by its elapsed span, so this morning is compared
     * with yesterday morning instead of with last night.
     */
    function previousRange(spec) {
      const shift = spec.key === 'today' ? LEDGER_DAY : spec.to - spec.from;
      return { key: spec.key, unit: spec.unit, from: spec.from - shift, to: spec.to - shift, buckets: [] };
    }

    /**
     * One change-versus-last-period chip. `goodWhenUp` decides the colour, not
     * the arrow: saving more is good, spending more is not.
     */
    function deltaOf(current, previous, goodWhenUp) {
      if (!(previous > 0)) return current > 0 ? { kind: 'new' } : null;
      const ratio = (current - previous) / previous;
      if (Number.isFinite(ratio) !== true) return null;
      const up = ratio >= 0;
      return { kind: 'pct', text: (up ? '↑' : '↓') + String(Math.round(Math.abs(ratio) * 100)) + '%', good: up === goodWhenUp };
    }

    /**
     * One model's contribution per session, for the drill-down under a model
     * row: who produced these tokens, when, and what each session is worth.
     */
    function sessionDrill(facts, spec, rules, provider, model) {
      const sessions = facts !== null && facts !== undefined && Array.isArray(facts.sessions) ? facts.sessions : [];
      const rows = facts !== null && facts !== undefined && Array.isArray(facts.rows) ? facts.rows : [];
      const map = new Map();
      for (const row of rows) {
        if (Array.isArray(row) !== true || row.length < 9) continue;
        if (typeof row[0] !== 'number' || row[0] < spec.from || row[0] > spec.to) continue;
        if (row[3] !== provider || row[4] !== model) continue;
        const session = sessions[row[1]];
        if (spec.sessionId !== undefined && session !== undefined && session !== null && session.id !== spec.sessionId) continue;
        if (rules !== null && rules !== undefined && rules.includeSubagents === false && session !== undefined && session !== null && session.origin === 'subagent') continue;
        const cost = rowCost(row, rules);
        let entry = map.get(row[1]);
        if (entry === undefined) {
          entry = { session, calls: 0, tokens: 0, amount: 0, priced: false, last: 0 };
          map.set(row[1], entry);
        }
        entry.calls += 1;
        entry.tokens += cost.tokens;
        if (row[0] > entry.last) entry.last = row[0];
        if (cost.amount !== null) {
          entry.amount += cost.amount;
          entry.priced = true;
        }
      }
      const entries = [...map.values()].sort((left, right) => (right.amount - left.amount) || (right.tokens - left.tokens));
      return { entries };
    }

    /** A readable name for one session row: title, else folder, else id. */
    function sessionName(session) {
      if (session === null || session === undefined) return '';
      const title = typeof session.title === 'string' ? session.title.trim() : '';
      if (title !== '') return title;
      const cwd = typeof session.cwd === 'string' ? session.cwd.split('/').filter((part) => part !== '').pop() : '';
      if (typeof cwd === 'string' && cwd !== '') return cwd;
      const id = typeof session.id === 'string' ? session.id : '';
      return id.length > 14 ? id.slice(0, 14) + '…' : id;
    }

    /** Provider volumes across every retained fact, for the rules tab. */
    function providerVolumes(facts) {
      const rows = facts !== null && facts !== undefined && Array.isArray(facts.rows) ? facts.rows : [];
      const map = new Map();
      for (const row of rows) {
        if (Array.isArray(row) !== true || row.length < 9) continue;
        const provider = typeof row[3] === 'string' ? row[3] : '';
        const tokens = row[5] + row[6] + row[7] + row[8];
        if (tokens === 0) continue;
        const entry = map.get(provider);
        if (entry === undefined) map.set(provider, { provider, tokens, calls: 1, models: new Set([row[4]]) });
        else {
          entry.tokens += tokens;
          entry.calls += 1;
          entry.models.add(row[4]);
        }
      }
      return [...map.values()]
        .map((entry) => ({ provider: entry.provider, tokens: entry.tokens, calls: entry.calls, models: entry.models.size }))
        .sort((left, right) => right.tokens - left.tokens);
    }

    /* ------------------------------------------------------------------ */
    /* Page styles                                                         */
    /* ------------------------------------------------------------------ */

    const PAGE_CSS = [
      '.dsh-ls{box-sizing:border-box;display:flex;flex-direction:column;align-self:stretch;width:100%;max-width:100%;min-width:0;height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 clamp(16px,3vw,32px) 28px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;font-variant-numeric:tabular-nums}',
      '.dsh-ls-head{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:24px 0 6px}',
      '.dsh-ls-headtext{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dsh-ls-title{margin:0;font-size:20px;font-weight:500;line-height:28px;letter-spacing:-.01em}',
      '.dsh-ls-sub{margin:0;max-width:62ch;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px}',
      '.dsh-ls-tabs{flex:none;display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}',
      '.dsh-ls-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;padding:4px 12px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap}',
      '.dsh-ls-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft)}',
      '.dsh-ls-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dsh-ls-toolbar{flex:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0 14px}',
      '.dsh-ls-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}',
      '.dsh-ls-segbtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;padding:4px 10px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap}',
      '.dsh-ls-segbtn[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft)}',
      '.dsh-ls-segbtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dsh-ls-segbtn:disabled{opacity:.5;cursor:default}',
      '.dsh-ls-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.dsh-ls-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-ls-btn:disabled{opacity:.55;cursor:default}',
      '.dsh-ls-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dsh-ls-btn[data-variant="quiet"]{border-color:transparent}',
      '.dsh-ls-grow{flex:1;min-width:0}',
      '.dsh-ls-status{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsh-ls-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-ls-progress{flex:none;height:2px;margin:0 0 12px;border-radius:1px;background:var(--dsw-alias-border-l1);overflow:hidden}',
      '.dsh-ls-progressfill{height:100%;background:var(--dsw-alias-state-business-primary);transition:width 220ms ease}',
      '.dsh-ls-card{box-sizing:border-box;min-width:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:14px 16px}',
      '.dsh-ls-hero{flex:none;display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr);gap:1px;min-width:0;background:var(--dsw-alias-border-l2);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);overflow:hidden}',
      '.dsh-ls-heromain{display:flex;flex-direction:column;justify-content:center;gap:3px;min-width:0;padding:16px 20px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-ls-herolabel{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px}',
      '.dsh-ls-herovalue{display:flex;align-items:baseline;gap:1px;font-size:32px;line-height:40px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsh-ls-herocur{font-size:18px;font-weight:500;opacity:.7}',
      '.dsh-ls-herometa{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px}',
      '.dsh-ls-heromain[data-tone="saved"] .dsh-ls-herovalue{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-ls-heromain[data-tone="spent"] .dsh-ls-herovalue{color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-ls-stat{display:flex;flex-direction:column;justify-content:center;gap:2px;min-width:0;padding:16px 20px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-ls-stathead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}',
      '.dsh-ls-statlabel{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ls-statvalue{font-size:19px;line-height:26px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ls-statmeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ls-stat[data-tone="saved"] .dsh-ls-statvalue{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-ls-stat[data-tone="spent"] .dsh-ls-statvalue{color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-ls-kpidelta{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-ls-kpidelta[data-tone="good"]{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-ls-kpidelta[data-tone="bad"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-ls-path{margin:-4px 0 10px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;word-break:break-all}',
      '.dsh-ls-skel{border-radius:4px;background:linear-gradient(90deg,var(--dsw-alias-bg-module-platform) 0%,var(--dsw-alias-bg-layer-2) 50%,var(--dsw-alias-bg-module-platform) 100%);background-size:200% 100%;animation:dsh-ls-shimmer 1.4s ease-in-out infinite}',
      '@keyframes dsh-ls-shimmer{from{background-position:100% 0}to{background-position:-100% 0}}',
      '.dsh-ls-skel-label{width:44px;height:8px;margin-bottom:10px}',
      '.dsh-ls-skel-value{width:88px;height:20px;margin-bottom:10px}',
      '.dsh-ls-skel-herovalue{width:132px;height:30px;margin-bottom:8px}',
      '.dsh-ls-skel-statvalue{width:72px;height:18px;margin-bottom:6px}',
      '.dsh-ls-skel-meta{width:120px;height:6px}',
      '.dsh-ls-skel-chart{height:120px}',
      '.dsh-ls-path[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',

      '.dsh-ls-section{flex:none;margin-top:12px}',
      '.dsh-ls-sectionhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px}',
      '.dsh-ls-sectiontitle{margin:0;font-size:13px;font-weight:500;line-height:20px}',
      '.dsh-ls-sectionnote{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}',
      '.dsh-ls-chartwrap{position:relative;min-width:0}',
      '.dsh-ls-tip{position:absolute;top:2px;z-index:2;pointer-events:none;box-sizing:border-box;min-width:132px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}',
      '.dsh-ls-tip-center{transform:translateX(-50%)}',
      '.dsh-ls-tip-start{transform:translateX(0)}',
      '.dsh-ls-tip-end{transform:translateX(-100%)}',
      '.dsh-ls-tiplabel{margin-bottom:3px;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-ls-tiprow{display:flex;align-items:center;gap:6px;white-space:nowrap}',
      '.dsh-ls-tipdot{flex:none;width:6px;height:6px;border-radius:50%}',
      '.dsh-ls-tipdot[data-tone="saved"]{background:var(--dsw-alias-state-business-primary)}',
      '.dsh-ls-tipdot[data-tone="spent"]{background:var(--dsw-alias-state-warn-primary)}',
      '.dsh-ls-tipkey{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-ls-tipval{flex:none;color:var(--dsw-alias-label-primary)}',
      '.dsh-ls-chartmax{position:absolute;top:-2px;right:0;color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:14px;font-variant-numeric:tabular-nums}',
      '.dsh-ls-gridline{position:absolute;left:0;right:0;height:0;border-top:1px dashed var(--dsw-alias-border-l1);pointer-events:none}',
      '.dsh-ls-chart{position:relative;display:flex;align-items:flex-end;gap:2px;height:126px;padding-top:8px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dsh-ls-col{flex:1 1 0;min-width:0;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:1px;border-radius:2px 2px 0 0}',
      '.dsh-ls-savedbar,.dsh-ls-spentbar{width:100%;max-width:34px}',
      '.dsh-ls-col:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-ls-col:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:-1px;background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-ls-savedbar{background:var(--dsw-alias-state-business-primary);border-radius:2px 2px 0 0}',
      '.dsh-ls-spentbar{background:var(--dsw-alias-state-warn-primary);border-radius:0 0 2px 2px}',
      '.dsh-ls-axis{display:flex;gap:2px;padding-top:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dsh-ls-axisslot{flex:1 1 0;min-width:0;text-align:center;white-space:nowrap;overflow:visible}',
      '.dsh-ls-legend{display:flex;align-items:center;gap:14px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}',
      '.dsh-ls-legenditem{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
      '.dsh-ls-swatch{width:8px;height:8px;border-radius:2px;flex:none}',
      '.dsh-ls-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}',
      '.dsh-ls-mrow{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);min-width:0}',
      '.dsh-ls-mrow:last-child{border-bottom:0}',
      '.dsh-ls-mname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ls-mprovider{flex:0 1 auto;max-width:38%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dsh-ls-mwrap{min-width:0}',
      '.dsh-ls-mrowbtn{appearance:none;width:100%;box-sizing:border-box;border:0;background:transparent;font:inherit;color:inherit;text-align:left;cursor:pointer;border-radius:var(--dsw-radius-sm);padding-left:4px;padding-right:4px}',
      '.dsh-ls-mrowbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-ls-mrowbtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:-1px}',
      '.dsh-ls-mrowbtn[aria-expanded="true"]{background:var(--dsw-alias-bg-module-platform)}',
      '.dsh-ls-chev{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform 120ms ease}',
      '.dsh-ls-chev[data-open="true"]{transform:rotate(90deg)}',
      '.dsh-ls-drill{margin:2px 0 8px;padding:0 4px 6px;border-left:2px solid var(--dsw-alias-border-l2)}',
      '.dsh-ls-drillhead{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;padding:4px 0 2px}',
      '.dsh-ls-drow{display:flex;align-items:flex-start;gap:10px;padding:5px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dsh-ls-dmain{flex:1;min-width:0}',
      '.dsh-ls-dnameline{display:flex;align-items:center;gap:6px;min-width:0}',
      '.dsh-ls-dname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ls-dmeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ls-dmoney{flex:none;min-width:66px;text-align:right}',
      '.dsh-ls-drowbtn{appearance:none;width:100%;box-sizing:border-box;border:0;border-top:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;font:inherit;color:inherit;text-align:left;cursor:pointer;padding-left:4px;padding-right:4px}',
      '.dsh-ls-drowbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-ls-drowbtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:-1px}',
      '.dsh-ls-inlinebtn{appearance:none;border:0;background:none;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:11.5px;line-height:16px;padding:0 4px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
      '.dsh-ls-mmeta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
      '.dsh-ls-mmoney{flex:none;min-width:74px;text-align:right}',
      '.dsh-ls-badge{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1}',
      '.dsh-ls-badge[data-route="local"]{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-ls-badge[data-route="cloud"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-ls-empty{padding:26px 0;text-align:center}',
      '.dsh-ls-emptytitle{font-size:13px;line-height:20px}',
      '.dsh-ls-emptyhint{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsh-ls-footer{flex:none;margin-top:16px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;display:flex;flex-wrap:wrap;gap:4px 14px}',
      '.dsh-ls-rulerow{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);min-width:0}',
      '.dsh-ls-rulerow:last-child{border-bottom:0}',
      '.dsh-ls-rulename{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ls-rulemeta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
      '.dsh-ls-rulehint{margin:0 0 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsh-ls-input{flex:1 1 180px;min-width:120px;box-sizing:border-box;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none}',
      '.dsh-ls-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-ls-input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}',
      '.dsh-ls-check{display:inline-flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;cursor:pointer}',
      '.dsh-ls-check input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}',
      // Narrow windows: the answer stays on its own row, its two parts share the next,
      // the provider column drops out and controls wrap instead of overflowing.
      '@media (max-width:760px){',
      '.dsh-ls-head{flex-direction:column;align-items:stretch;gap:10px}',
      '.dsh-ls-tabs{width:max-content;align-self:flex-start}',
      '.dsh-ls-hero{grid-template-columns:1fr 1fr}',
      '.dsh-ls-heromain{grid-column:1/-1;padding:14px 16px}',
      '.dsh-ls-herovalue{font-size:28px;line-height:36px}',
      '.dsh-ls-stat{padding:12px 16px}',
      '.dsh-ls-sectionhead{flex-wrap:wrap;gap:4px 10px}',
      '.dsh-ls-mprovider{display:none}',
      '.dsh-ls-mmoney{min-width:58px}',
      '.dsh-ls-rulerow{flex-wrap:wrap}',
      '.dsh-ls-rulerow .dsh-ls-seg{margin-left:auto}',
      '.dsh-ls-cols{grid-template-columns:1fr}',
      '}',
      '@media (max-width:520px){',
      '.dsh-ls-hero{grid-template-columns:1fr}',
      '.dsh-ls-chart{height:96px}',
      '.dsh-ls-axisslot{font-size:10px}',
      '.dsh-ls-toolbar{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center}',
      '.dsh-ls-toolbar .dsh-ls-seg{grid-column:1/-1;justify-self:start}',
      '.dsh-ls-toolbar .dsh-ls-grow{display:none}',
      '.dsh-ls-toolbar .dsh-ls-status{grid-column:1;min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '}',
      '@media (prefers-reduced-motion:reduce){.dsh-ls-progressfill{transition:none}.dsh-ls-skel{animation:none}}',
    ].join('\n');

    /* ------------------------------------------------------------------ */
    /* Page building blocks                                                */
    /* ------------------------------------------------------------------ */

    function Segmented(props) {
      const options = props.options;
      const buttons = [];
      for (const option of options) {
        buttons.push(h('button', {
          key: option.value,
          type: 'button',
          className: 'dsh-ls-segbtn',
          'aria-pressed': props.value === option.value,
          title: option.title,
          disabled: props.disabled === true,
          onClick: () => props.onChange(option.value),
        }, option.label));
      }
      return h('div', { className: 'dsh-ls-seg', role: 'group', 'aria-label': props.label }, buttons);
    }

    /** One change-versus-last-period chip; the tone is decided by `good`. */
    function DeltaChip(props) {
      const delta = props.delta;
      if (delta === null || delta === undefined) return null;
      if (delta.kind === 'new') {
        return h('span', { className: 'dsh-ls-kpidelta', title: props.title }, props.deltaNew);
      }
      return h('span', {
        className: 'dsh-ls-kpidelta',
        'data-tone': delta.good === true ? 'good' : 'bad',
        title: props.title,
      }, delta.text);
    }

    /**
     * A sparkline of the window: one column per bucket, spent below saved.
     * Hovering or focusing a column opens a readout with that bucket's two
     * amounts; the readout hugs the edge columns instead of spilling out.
     */
    function TrendChart(props) {
      const bill = props.bill;
      const t = props.t;
      const max = bill.maxColumn;
      const hoverState = React.useState(null);
      const hovered = hoverState[0];
      const setHovered = hoverState[1];
      const columns = bill.columns.map((column, index) => {
        const total = column.saved + column.spent;
        const savedShare = max > 0 ? (column.saved / max) * 100 : 0;
        const spentShare = max > 0 ? (column.spent / max) * 100 : 0;
        const bars = [];
        if (total > 0 && savedShare > 0) {
          bars.push(h('div', { key: 'saved', className: 'dsh-ls-savedbar', style: { height: Math.max(1.5, savedShare) + '%' } }));
        }
        if (total > 0 && spentShare > 0) {
          bars.push(h('div', { key: 'spent', className: 'dsh-ls-spentbar', style: { height: Math.max(1.5, spentShare) + '%' } }));
        }
        const label = column.label + ' · ' + t('saved') + ' ' + money(column.saved) + ' · ' + t('spent') + ' ' + money(column.spent);
        return h('div', {
          key: 'col-' + String(index),
          className: 'dsh-ls-col',
          tabIndex: 0,
          'aria-label': label,
          onMouseEnter: () => setHovered(index),
          onMouseLeave: () => setHovered(null),
          onFocus: () => setHovered(index),
          onBlur: () => setHovered(null),
          onKeyDown: (event) => {
            if (event.key === 'Escape') setHovered(null);
          },
        }, bars);
      });

      const step = Math.max(1, Math.ceil(bill.columns.length / 7));
      const labels = bill.columns.map((column, index) => h('span', {
        key: 'axis-' + String(index),
        className: 'dsh-ls-axisslot',
      }, index % step === 0 ? column.label : ''));

      const unitKey = 'unit' + bill.spec.unit.charAt(0).toUpperCase() + bill.spec.unit.slice(1);
      let tip = null;
      if (hovered !== null && hovered >= 0 && hovered < bill.columns.length) {
        const column = bill.columns[hovered];
        const ratio = (hovered + 0.5) / bill.columns.length;
        const align = ratio < 0.15 ? 'start' : ratio > 0.85 ? 'end' : 'center';
        tip = h('div', {
          className: 'dsh-ls-tip dsh-ls-tip-' + align,
          style: { left: align === 'start' ? '0%' : align === 'end' ? '100%' : (ratio * 100).toFixed(3) + '%' },
          role: 'status',
          'aria-live': 'polite',
        },
          h('div', { className: 'dsh-ls-tiplabel' }, column.label),
          h('div', { className: 'dsh-ls-tiprow' },
            h('span', { className: 'dsh-ls-tipdot', 'data-tone': 'saved' }),
            h('span', { className: 'dsh-ls-tipkey' }, t('saved')),
            h('span', { className: 'dsh-ls-tipval' }, money(column.saved)),
          ),
          h('div', { className: 'dsh-ls-tiprow' },
            h('span', { className: 'dsh-ls-tipdot', 'data-tone': 'spent' }),
            h('span', { className: 'dsh-ls-tipkey' }, t('spent')),
            h('span', { className: 'dsh-ls-tipval' }, money(column.spent)),
          ),
        );
      }

      return h('div', { className: 'dsh-ls-chartwrap' },
        max > 0 ? h('span', { className: 'dsh-ls-chartmax' }, money(max)) : null,
        h('div', {
          className: 'dsh-ls-chart',
          'aria-label': t('trendTitle', { unit: t(unitKey) }),
        },
          h('div', { key: 'grid', className: 'dsh-ls-gridline', style: { bottom: '50%' } }),
          columns,
          tip,
        ),
        h('div', { className: 'dsh-ls-axis' }, labels),
      );
    }

    function Chevron(props) {
      return h('svg', {
        width: 12,
        height: 12,
        viewBox: '0 0 12 12',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        className: 'dsh-ls-chev',
        'data-open': props.open === true,
      }, h('path', { d: 'M4.5 2.5 8 6l-3.5 3.5' }));
    }

    /** Who produced this model's tokens in the window. */
    function SessionDrill(props) {
      const t = props.t;
      const drill = sessionDrill(props.facts, props.spec, props.rules, props.provider, props.model);
      if (drill.entries.length === 0) {
        return h('div', { className: 'dsh-ls-drill' }, h('div', { className: 'dsh-ls-rulehint' }, t('drillEmpty')));
      }
      const shown = drill.entries.slice(0, 8);
      const rows = shown.map((entry, index) => {
        const session = entry.session;
        const name = sessionName(session);
        const isSub = session !== undefined && session !== null && session.origin === 'subagent';
        const id = session !== undefined && session !== null && typeof session.id === 'string' ? session.id : '';
        const active = id !== '' && id === props.activeSessionId;
        const meta = [
          t('drillCalls', { count: entry.calls }),
          tokenText(entry.tokens) + ' tok',
          t('drillLast', { time: timeLabel(entry.last) }),
        ].join(' · ');
        const body = [
          h('div', { key: 'main', className: 'dsh-ls-dmain' },
            h('div', { className: 'dsh-ls-dnameline' },
              h('span', { className: 'dsh-ls-dname', title: name }, name === '' ? t('noTitle') : name),
              isSub ? h('span', { className: 'dsh-ls-badge' }, t('subagent')) : null,
            ),
            h('div', { className: 'dsh-ls-dmeta' }, meta),
          ),
          h('span', { key: 'money', className: 'dsh-ls-dmoney' }, entry.priced === true ? money(entry.amount) : '—'),
        ];
        if (id === '' || active || typeof props.onPickSession !== 'function') {
          return h('div', { key: 'drill-' + String(index), className: 'dsh-ls-drow' }, body);
        }
        return h('button', {
          key: 'drill-' + String(index),
          type: 'button',
          className: 'dsh-ls-drow dsh-ls-drowbtn',
          title: t('openSession'),
          onClick: () => props.onPickSession(id),
        }, body);
      });
      return h('div', { className: 'dsh-ls-drill', role: 'group', 'aria-label': t('drillHint') },
        h('div', { className: 'dsh-ls-drillhead' }, t('drillTitle', { count: drill.entries.length })),
        rows,
        drill.entries.length > shown.length
          ? h('div', { className: 'dsh-ls-rulehint', style: { marginTop: '6px' } }, t('drillMore', { count: drill.entries.length - shown.length }))
          : null,
      );
    }

    /**
     * One model per row, sorted by money. The row opens the session breakdown;
     * the badge is the route verdict, so a mixed window reads at a glance.
     */
    function ModelRows(props) {
      const t = props.t;
      if (props.rows.length === 0) {
        return h('div', { className: 'dsh-ls-empty' },
          h('div', { className: 'dsh-ls-emptyhint' }, props.emptyNote === undefined ? '' : props.emptyNote),
        );
      }
      return h('div', { className: 'dsh-ls-mtable' }, props.rows.map((entry) => {
        const key = entry.provider + '\u0000' + entry.model;
        const open = props.expanded === key;
        return h('div', { key: 'wrap-' + entry.provider + '/' + entry.model, className: 'dsh-ls-mwrap' },
          h('button', {
            type: 'button',
            className: 'dsh-ls-mrow dsh-ls-mrowbtn',
            'aria-expanded': open,
            title: t('drillHint'),
            onClick: () => props.onToggle(open ? '' : key),
          },
            h('span', { className: 'dsh-ls-badge', 'data-route': entry.route }, entry.route === 'local' ? t('local') : t('cloud')),
            h('span', { className: 'dsh-ls-mname', title: entry.provider + ' / ' + entry.model }, entry.model === '' ? t('modelUnknown') : entry.model),
            h('span', { className: 'dsh-ls-mprovider', title: entry.provider }, entry.provider === '' ? t('noProvider') : entry.provider),
            h('span', { className: 'dsh-ls-mmeta' }, tokenText(entry.tokens) + ' tok'),
            h('span', { className: 'dsh-ls-mmoney' }, entry.amount > 0 ? money(entry.route === 'local' ? entry.saved : entry.spent) : '—'),
            h(Chevron, { open: open }),
          ),
          open
            ? h(SessionDrill, {
              facts: props.facts,
              spec: props.spec,
              rules: props.rules,
              provider: entry.provider,
              model: entry.model,
              activeSessionId: props.activeSessionId,
              onPickSession: props.onPickSession,
              t: t,
            })
            : null,
        );
      }));
    }

    /** Clock for today's rows, date for older ones. */
    function timeLabel(ms) {
      return Date.now() - ms < LEDGER_DAY ? clockLabel(ms) : dayLabel(ms);
    }

    /**
     * One window's bill: the net answer first, its two parts beside it, then the
     * trend and the models that produced those numbers.
     */
    function BillView(props) {
      const t = props.t;
      const bill = props.bill;
      const facts = props.facts;
      const stats = facts !== null && facts !== undefined ? facts.stats : null;
      const previous = props.previous;
      const net = bill.totals.saved - bill.totals.spent;
      const netCovered = bill.totals.spent > 0 ? Math.min(1, bill.totals.saved / bill.totals.spent) : 0;
      const unpricedShare = bill.totals.unpricedTokens / Math.max(1, bill.totals.localTokens + bill.totals.cloudTokens);
      const previousNet = previous === null ? 0 : previous.totals.saved - previous.totals.spent;
      const deltaTitle = t('deltaTitle');

      const stat = (tone, label, value, meta, delta) => h('div', { className: 'dsh-ls-stat', 'data-tone': tone },
        h('div', { className: 'dsh-ls-stathead' },
          h('span', { className: 'dsh-ls-statlabel' }, label),
          h(DeltaChip, { delta: delta, deltaNew: t('deltaNew'), title: deltaTitle }),
        ),
        h('div', { className: 'dsh-ls-statvalue' }, value),
        h('div', { className: 'dsh-ls-statmeta' }, meta),
      );

      const hero = h('div', { className: 'dsh-ls-hero' },
        h('div', { className: 'dsh-ls-heromain', 'data-tone': net < 0 ? 'spent' : 'saved' },
          h('div', { className: 'dsh-ls-herolabel' },
            h('span', null, net < 0 ? t('netSpent') : t('netSaved')),
            h(DeltaChip, {
              delta: net > 0 && previousNet > 0 ? deltaOf(net, previousNet, true) : null,
              deltaNew: t('deltaNew'),
              title: deltaTitle,
            }),
          ),
          h('div', { className: 'dsh-ls-herovalue' },
            h('span', { className: 'dsh-ls-herocur' }, '¥'),
            h('span', null, shortMoney(Math.abs(net)).replace('¥', '')),
          ),
          h('div', { className: 'dsh-ls-herometa' },
            bill.totals.spent > 0 && bill.totals.saved > 0
              ? t('netAgainstSpend', { pct: percentText(netCovered) })
              : t('netMeta', { date: PRICE_AS_OF }),
          ),
        ),
        stat('saved', t('saved'), shortMoney(bill.totals.saved), t('savedMeta', { tokens: tokenText(bill.totals.localTokens), calls: bill.totals.localCalls }), previous === null ? null : deltaOf(bill.totals.saved, previous.totals.saved, true)),
        stat('spent', t('spent'), shortMoney(bill.totals.spent), t('spentMeta', { tokens: tokenText(bill.totals.cloudTokens), calls: bill.totals.cloudCalls }), previous === null ? null : deltaOf(bill.totals.spent, previous.totals.spent, false)),
      );

      const unitKey = 'unit' + bill.spec.unit.charAt(0).toUpperCase() + bill.spec.unit.slice(1);
      const chartCard = h('div', { className: 'dsh-ls-card dsh-ls-section' },
        h('div', { className: 'dsh-ls-sectionhead' },
          h('h2', { className: 'dsh-ls-sectiontitle' }, t('trendTitle', { unit: t(unitKey) })),
          h('div', { className: 'dsh-ls-legend' },
            h('span', { className: 'dsh-ls-legenditem' }, h('span', { className: 'dsh-ls-swatch', style: { background: 'var(--dsw-alias-state-business-primary)' } }), t('legendSaved')),
            h('span', { className: 'dsh-ls-legenditem' }, h('span', { className: 'dsh-ls-swatch', style: { background: 'var(--dsw-alias-state-warn-primary)' } }), t('legendSpent')),
          ),
        ),
        bill.totals.calls === 0
          ? h('div', { className: 'dsh-ls-empty' },
            h('div', { className: 'dsh-ls-emptytitle' }, t('noRows')),
            h('div', { className: 'dsh-ls-emptyhint' }, t('noRowsHint')),
          )
          : h(TrendChart, { bill: bill, t: t }),
      );

      const models = bill.savedList.concat(bill.spentList)
        .filter((entry, index, all) => all.findIndex((other) => other.provider === entry.provider && other.model === entry.model) === index)
        .sort((left, right) => (right.amount - left.amount) || (right.tokens - left.tokens));

      const modelsCard = bill.totals.calls === 0 ? null : h('div', { className: 'dsh-ls-card dsh-ls-section' },
        h('div', { className: 'dsh-ls-sectionhead' },
          h('h2', { className: 'dsh-ls-sectiontitle' }, t('modelsCard')),
          h('span', { className: 'dsh-ls-sectionnote' }, t('modelsHint')),
        ),
        h(ModelRows, {
          rows: models,
          emptyNote: t('noModels'),
          t: t,
          facts: facts,
          spec: bill.spec,
          rules: props.rules,
          expanded: props.expanded,
          onToggle: props.onToggle,
          activeSessionId: props.activeSessionId,
          onPickSession: props.onPickSession,
        }),
      );

      const notes = [];
      if (bill.approximate) notes.push(t('approximate'));
      if (unpricedShare > 0.0005) notes.push(t('unpriced', { pct: percentText(unpricedShare) }));
      if (stats !== null && stats.errors !== null && stats.errors !== undefined && stats.errors.length > 0) {
        notes.push(t('errors', { count: stats.errors.length }));
      }

      return h('div', null,
        hero,
        chartCard,
        modelsCard,
        notes.length === 0 ? null : h('div', { className: 'dsh-ls-rulehint', style: { marginTop: '10px' } }, notes.join(' · ')),
      );
    }

    /** The route rules: provider verdicts, model exceptions, sub-agent switch. */
    function RulesView(props) {
      const t = props.t;
      const rules = props.rules;
      const facts = props.facts;
      const providers = providerVolumes(facts);
      const state = React.useState({ model: '', verdict: 'local' });
      const draft = state[0];
      const setDraft = state[1];

      const providerRows = providers.map((entry) => {
        const id = entry.provider;
        const stored = rules.providers !== null && rules.providers !== undefined ? rules.providers[id] : undefined;
        const value = stored === 'local' || stored === 'cloud' ? stored : 'auto';
        const resolved = classifyRoute(id, '', rules);
        return h('div', { key: 'provider-' + id, className: 'dsh-ls-rulerow' },
          h('span', { className: 'dsh-ls-rulename', title: id === '' ? t('noProvider') : id }, id === '' ? t('noProvider') : id),
          h('span', { className: 'dsh-ls-rulemeta' }, tokenText(entry.tokens) + ' tok · ' + String(entry.models) + '×'),
          h('span', { className: 'dsh-ls-badge', 'data-route': resolved }, resolved === 'local' ? t('local') : t('cloud')),
          h(Segmented, {
            value,
            label: id,
            options: [
              { value: 'auto', label: t('auto') },
              { value: 'local', label: t('local') },
              { value: 'cloud', label: t('cloud') },
            ],
            onChange: (next) => {
              const providers2 = { ...(rules.providers || {}) };
              if (next === 'auto') delete providers2[id];
              else providers2[id] = next;
              props.onRules({ ...rules, providers: providers2 });
            },
          }),
        );
      });

      const modelEntries = Object.keys(rules.models || {}).sort();
      const modelRows = modelEntries.length === 0
        ? null
        : h('div', null, modelEntries.map((key) => h('div', { key: 'model-' + key, className: 'dsh-ls-rulerow' },
          h('span', { className: 'dsh-ls-rulename' }, key),
          h('span', { className: 'dsh-ls-badge', 'data-route': rules.models[key] }, rules.models[key] === 'local' ? t('local') : t('cloud')),
          h('button', {
            type: 'button',
            className: 'dsh-ls-btn',
            'data-variant': 'quiet',
            onClick: () => {
              const models = { ...(rules.models || {}) };
              delete models[key];
              props.onRules({ ...rules, models });
            },
          }, t('remove')),
        )));

      return h('div', null,
        h('div', { className: 'dsh-ls-card' },
          h('p', { className: 'dsh-ls-rulehint' }, t('rulesIntro')),
          h('div', { className: 'dsh-ls-rulerow' },
            h('label', { className: 'dsh-ls-check' },
              h('input', {
                type: 'checkbox',
                checked: rules.includeSubagents !== false,
                onChange: (event) => props.onRules({ ...rules, includeSubagents: event.target.checked === true }),
              }),
              h('span', null, t('includeSubagents')),
            ),
            h('span', { className: 'dsh-ls-grow' }),
            h('span', { className: 'dsh-ls-rulemeta' }, t('includeSubagentsHint')),
          ),
        ),
        h('div', { className: 'dsh-ls-section' },
          h('div', { className: 'dsh-ls-sectionhead' }, h('h2', { className: 'dsh-ls-sectiontitle' }, t('providersTitle'))),
          h('p', { className: 'dsh-ls-rulehint' }, t('providersHint')),
          h('div', { className: 'dsh-ls-card' }, providerRows.length === 0 ? h('div', { className: 'dsh-ls-rulehint' }, '—') : providerRows),
        ),
        h('div', { className: 'dsh-ls-section' },
          h('div', { className: 'dsh-ls-sectionhead' }, h('h2', { className: 'dsh-ls-sectiontitle' }, t('modelsTitle'))),
          h('p', { className: 'dsh-ls-rulehint' }, t('rulesModelsHint')),
          h('div', { className: 'dsh-ls-card' },
            h('div', { className: 'dsh-ls-rulerow' },
              h('input', {
                type: 'text',
                className: 'dsh-ls-input',
                placeholder: t('modelPlaceholder'),
                value: draft.model,
                onChange: (event) => setDraft({ ...draft, model: event.target.value }),
              }),
              h(Segmented, {
                value: draft.verdict,
                label: t('modelsTitle'),
                options: [
                  { value: 'local', label: t('local') },
                  { value: 'cloud', label: t('cloud') },
                ],
                onChange: (next) => setDraft({ ...draft, verdict: next }),
              }),
              h('button', {
                type: 'button',
                className: 'dsh-ls-btn',
                disabled: draft.model.trim() === '',
                onClick: () => {
                  const key = draft.model.trim();
                  if (key === '') return;
                  const models = { ...(rules.models || {}) };
                  models[key.toLowerCase()] = draft.verdict;
                  props.onRules({ ...rules, models });
                  setDraft({ ...draft, model: '' });
                },
              }, t('add')),
            ),
            modelRows,
          ),
        ),
        props.note !== undefined && props.note !== '' ? h('div', { className: 'dsh-ls-path', style: { marginTop: '10px' } }, t('rulesSourceNote', { reason: props.note })) : null,
      );
    }

    /* ------------------------------------------------------------------ */
    /* Page component                                                      */
    /* ------------------------------------------------------------------ */

    function makePage() {
      return function CostPage(props) {
        const lang = preferredLanguage();
        const dict = pageDict(lang);
        const t = (key, values) => format(dict[key] !== undefined ? dict[key] : PAGE_DICTS.en[key], values || {});

        const state = React.useState({ phase: 'loading', facts: null, rules: DEFAULT_RULES, rulesSource: '', saveNote: '', error: '', busy: false, saving: 'idle', saveError: '', exportPath: '', exportError: '' });
        const info = state[0];
        const setInfo = state[1];
        const windowState = React.useState('today');
        const windowKey = windowState[0];
        const setWindowKey = windowState[1];
        const tabState = React.useState('bill');
        const tab = tabState[0];
        const setTab = tabState[1];
        const expandedState = React.useState('');
        const expanded = expandedState[0];
        const setExpanded = expandedState[1];
        const pickedState = React.useState('');
        const picked = pickedState[0];
        const setPicked = pickedState[1];

        // The page is root-scoped, so the session it should summarise comes from
        // the session store: the one the conversation retains, else the most
        // recently updated one.
        let retainedSession = '';
        try {
          if (typeof props.useSessions === 'function') {
            retainedSession = props.useSessions((state) => {
              if (state === null || state === undefined || state.byId === undefined) return '';
              let newest = '';
              let newestAt = -1;
              for (const session of Object.values(state.byId)) {
                if (session === null || session === undefined || typeof session.id !== 'string') continue;
                if (session.retainedBy !== undefined && session.retainedBy !== null && (session.retainedBy.mainView ?? 0) > 0) return session.id;
                const at = typeof session.updatedAt === 'number' ? session.updatedAt : 0;
                if (at > newestAt) {
                  newestAt = at;
                  newest = session.id;
                }
              }
              return newest;
            }) || '';
          }
        } catch (error) {
          retainedSession = '';
        }

        const alive = React.useRef(true);
        const timer = React.useRef(null);
        const seq = React.useRef(0);
        const infoRef = React.useRef(null);
        infoRef.current = info;

        const load = async (mode) => {
          const ticket = ++seq.current;
          setInfo((previous) => ({ ...previous, busy: true, error: mode === 'initial' ? '' : previous.error }));
          try {
            // Always ask for the cheap header first: when nothing was rescanned,
            // the current rows are still exact and the payload never crosses the wire.
            let answer = await readJson(API_PATH + '?op=facts&rows=0');
            if (alive.current !== true || ticket !== seq.current) return;
            if (answer.ok !== true) throw new Error(typeof answer.reason === 'string' ? answer.reason : t('loadFailed'));
            const scanning = answer.stats !== null && answer.stats !== undefined && answer.stats.scanning === true;
            if (scanning === true) {
              setInfo((previous) => ({
                ...previous,
                busy: false,
                phase: previous.facts === null ? 'loading' : 'ready',
                facts: previous.facts === null ? null : { ...previous.facts, stats: answer.stats },
              }));
              if (timer.current !== null) clearTimeout(timer.current);
              timer.current = setTimeout(() => {
                void load('progress');
              }, 800);
              return;
            }
            const unchanged = mode !== 'initial' && answer.stats !== null && answer.stats !== undefined && answer.stats.changed === false;
            if (unchanged === true && infoRef.current !== null) {
              setInfo((previous) => ({
                ...previous,
                phase: 'ready',
                busy: false,
                error: '',
                facts: previous.facts === null ? null : { ...previous.facts, stats: answer.stats },
              }));
              return;
            }
            answer = await readJson(API_PATH + '?op=facts');
            if (alive.current !== true || ticket !== seq.current) return;
            if (answer.ok !== true) throw new Error(typeof answer.reason === 'string' ? answer.reason : t('loadFailed'));
            setInfo((previous) => ({ ...previous, phase: 'ready', busy: false, error: '', facts: answer }));
          } catch (error) {
            if (alive.current !== true || ticket !== seq.current) return;
            setInfo((previous) => ({ ...previous, busy: false, phase: previous.facts === null ? 'error' : 'ready', error: errorText(error) }));
          }
        };

        React.useEffect(() => {
          alive.current = true;
          void load('initial');
          readJson(API_PATH + '?op=rules')
            .then((answer) => {
              if (alive.current !== true || answer.ok !== true || answer.rules === undefined) return;
              setInfo((previous) => ({
                ...previous,
                rules: { ...DEFAULT_RULES, ...answer.rules },
                rulesSource: typeof answer.source === 'string' ? answer.source : '',
              }));
            })
            .catch(() => {});
          return () => {
            alive.current = false;
            if (timer.current !== null) clearTimeout(timer.current);
          };
        }, []);

        // A bill page that is open should not need a manual refresh. The probe
        // above is cheap, so this runs every 15 s — and only while the page is
        // actually in front of the user.
        React.useEffect(() => {
          const id = setInterval(() => {
            if (alive.current !== true) return;
            if (typeof document !== 'undefined' && document !== null && document.visibilityState === 'hidden') return;
            void load('refresh');
          }, 15000);
          return () => clearInterval(id);
        }, []);

        const saveRules = (next) => {
          setInfo((previous) => ({ ...previous, rules: next, saving: 'saving', saveError: '', saveNote: '' }));
          postJson({ op: 'rules', rules: next })
            .then((answer) => {
              if (alive.current !== true) return;
              if (answer.ok !== true) throw new Error(typeof answer.reason === 'string' ? answer.reason : 'rules');
              setInfo((previous) => ({
                ...previous,
                rules: { ...DEFAULT_RULES, ...answer.rules },
                rulesSource: typeof answer.source === 'string' ? answer.source : previous.rulesSource,
                saving: 'saved',
                saveError: '',
                saveNote: typeof answer.note === 'string' ? answer.note : '',
              }));
            })
            .catch(async (error) => {
              if (alive.current !== true) return;
              // A config save restarts the plugin, so the response can be lost
              // after the write landed. Re-read once before calling it a failure.
              try {
                const reread = await readJson(API_PATH + '?op=rules');
                if (alive.current === true && reread.ok === true && rulesEqual(reread.rules, next)) {
                  setInfo((previous) => ({
                    ...previous,
                    rules: { ...DEFAULT_RULES, ...reread.rules },
                    rulesSource: typeof reread.source === 'string' ? reread.source : previous.rulesSource,
                    saving: 'saved',
                    saveError: '',
                    saveNote: '',
                  }));
                  return;
                }
              } catch {
                /* fall through to the error */
              }
              if (alive.current !== true) return;
              setInfo((previous) => ({ ...previous, saving: 'error', saveError: errorText(error) }));
            });
        };

        const facts = info.facts;
        const rules = info.rules !== null && info.rules !== undefined ? info.rules : DEFAULT_RULES;
        const now = Date.now();
        const knownSession = (id) => id !== '' && facts !== null && facts !== undefined && Array.isArray(facts.sessions)
          && facts.sessions.some((session) => session !== null && session !== undefined && session.id === id);
        const sessionId = knownSession(picked)
          ? picked
          : knownSession(retainedSession)
            ? retainedSession
            : newestSessionId(facts);
        const isSessionWindow = windowKey === 'session';
        const spec = isSessionWindow ? sessionSpec(facts, sessionId, now) : windowSpec(windowKey, now);
        const bill = buildBill(facts, spec, rules);
        const previous = isSessionWindow ? null : buildBill(facts, previousRange(spec), rules);
        const sessionInfo = facts !== null && facts !== undefined && Array.isArray(facts.sessions)
          ? facts.sessions.find((session) => session !== null && session !== undefined && session.id === sessionId)
          : undefined;

        const exportCsv = () => {
          const label = windowKey === 'session'
            ? t('current')
            : t(windowKey === 'hour' ? 'hour' : windowKey === 'today' ? 'today' : windowKey === 'week' ? 'week' : 'month');
          const cell = (value) => {
            const text = value === null || value === undefined ? '' : String(value);
            return text.indexOf(',') >= 0 || text.indexOf('"') >= 0 || text.indexOf('\n') >= 0
              ? '"' + text.split('"').join('""') + '"'
              : text;
          };
          const lines = [];
          lines.push(['模型', 'Provider', '线路', '请求数', '未缓存输入', '缓存读取', '缓存写入', '输出', '合计token', '金额CNY'].join(','));
          for (const entry of bill.entries) {
            lines.push([
              cell(entry.model),
              cell(entry.provider),
              cell(entry.route === 'local' ? t('local') : t('cloud')),
              String(entry.calls),
              String(entry.miss),
              String(entry.hit),
              String(entry.write),
              String(entry.out),
              String(entry.tokens),
              entry.priced === true ? entry.amount.toFixed(4) : '',
            ].join(','));
          }
          lines.push([
            t('totalRow'), '', '', String(bill.totals.calls),
            String(bill.entries.reduce((sum, entry) => sum + entry.miss, 0)),
            String(bill.entries.reduce((sum, entry) => sum + entry.hit, 0)),
            String(bill.entries.reduce((sum, entry) => sum + entry.write, 0)),
            String(bill.entries.reduce((sum, entry) => sum + entry.out, 0)),
            String(bill.totals.localTokens + bill.totals.cloudTokens),
            (bill.totals.saved + bill.totals.spent).toFixed(4),
          ].join(','));
          const head = [
            '# 省流中台 / CostOps Hub',
            '# window, ' + cell(label) + ', ' + new Date(spec.from).toISOString() + ' -> ' + new Date(spec.to).toISOString(),
            '# saved, ' + bill.totals.saved.toFixed(4) + ', spent, ' + bill.totals.spent.toFixed(4) + ', net, ' + (bill.totals.saved - bill.totals.spent).toFixed(4),
            '# price table as of, ' + PRICE_AS_OF,
          ];
          setInfo((prev) => ({ ...prev, exportPath: '', exportError: '' }));
          postJson({ op: 'export', name: 'costops-' + windowKey, csv: '\ufeff' + head.concat(lines).join('\n') + '\n' })
            .then((answer) => {
              if (alive.current !== true) return;
              if (answer.ok !== true) throw new Error(typeof answer.reason === 'string' ? answer.reason : 'export');
              setInfo((prev) => ({ ...prev, exportPath: typeof answer.path === 'string' ? answer.path : '', exportError: '' }));
            })
            .catch((error) => {
              if (alive.current !== true) return;
              setInfo((prev) => ({ ...prev, exportError: errorText(error), exportPath: '' }));
            });
        };
        const stats = facts !== null && facts !== undefined ? facts.stats : null;
        const scanning = stats !== null && stats !== undefined && stats.scanning === true;
        const coveredShare = stats !== null && stats !== undefined && stats.sessions > 0 ? stats.covered / stats.sessions : 1;

        const windowTabs = [
          { value: 'session', label: t('current') },
          { value: 'hour', label: t('hour') },
          { value: 'today', label: t('today') },
          { value: 'week', label: t('week') },
          { value: 'month', label: t('month') },
        ];

        const header = h('div', { className: 'dsh-ls-head' },
          h('div', { className: 'dsh-ls-headtext' },
            h('h1', { className: 'dsh-ls-title' }, t('title')),
            h('p', { className: 'dsh-ls-sub', title: t('subtitleFull') }, t('subtitle')),
          ),
          h('div', {
            className: 'dsh-ls-tabs',
            role: 'tablist',
            'aria-label': t('title'),
            onKeyDown: (event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              setTab(tab === 'bill' ? 'rules' : 'bill');
            },
          },
            h('button', { type: 'button', role: 'tab', className: 'dsh-ls-tab', 'aria-selected': tab === 'bill', onClick: () => setTab('bill') }, t('tabBill')),
            h('button', { type: 'button', role: 'tab', className: 'dsh-ls-tab', 'aria-selected': tab === 'rules', onClick: () => setTab('rules') }, t('tabRules')),
          ),
        );

        const toolbar = h('div', { className: 'dsh-ls-toolbar' },
          tab === 'bill' ? h(Segmented, {
            value: windowKey,
            label: t('tabBill'),
            options: windowTabs,
            onChange: (next) => setWindowKey(next),
          }) : h('span', { className: 'dsh-ls-sectionnote' },
            info.rulesSource === 'config' ? t('rulesSourceConfig') : info.rulesSource === 'file' ? t('rulesSourceFile') : t('rulesSourceUnknown')),
          h('span', { className: 'dsh-ls-grow' }),
          h('span', { className: 'dsh-ls-status', role: 'status', 'aria-live': 'polite' },
            info.saving === 'saving' ? t('saving') : info.saving === 'saved' ? t('savedNote') : '',
          ),
          info.saving === 'error' ? h('span', { className: 'dsh-ls-status', 'data-tone': 'error', role: 'alert' }, t('saveFailed', { reason: info.saveError })) : null,
          tab === 'bill' && bill.totals.calls > 0
            ? h('button', { type: 'button', className: 'dsh-ls-btn', onClick: exportCsv, title: t('exportHint') }, t('exportCsv'))
            : null,
          h('button', {
            type: 'button',
            className: 'dsh-ls-btn',
            disabled: info.busy === true,
            onClick: () => {
              void load('refresh');
            },
          }, info.busy === true ? t('refreshing') : t('refresh')),
        );

        const pickSession = (id) => {
          setPicked(id);
          setWindowKey('session');
          setExpanded('');
        };
        const sessionLine = isSessionWindow
          ? h('div', { className: 'dsh-ls-path' },
            t('sessionWindow', { name: sessionName(sessionInfo) }),
            picked !== ''
              ? h('button', {
                type: 'button',
                className: 'dsh-ls-inlinebtn',
                onClick: () => {
                  setPicked('');
                },
              }, t('backToCurrent'))
              : null,
          )
          : null;
        const exportLine = info.exportError !== ''
          ? h('div', { className: 'dsh-ls-path', 'data-tone': 'error', role: 'alert' }, t('exportFailed', { reason: info.exportError }))
          : info.exportPath !== ''
            ? h('div', { className: 'dsh-ls-path', role: 'status', 'aria-live': 'polite' }, t('exported', { path: info.exportPath }))
            : null;

        let body;
        if (info.phase === 'error') {
          body = h('div', { className: 'dsh-ls-card' },
            h('div', { className: 'dsh-ls-emptytitle' }, t('loadFailed')),
            h('div', { className: 'dsh-ls-emptyhint' }, info.error),
            h('div', { className: 'dsh-ls-rulehint', style: { marginTop: '8px' } }, t('routeHint', { route: API_PATH })),
            h('button', { type: 'button', className: 'dsh-ls-btn', style: { marginTop: '10px' }, onClick: () => void load('initial') }, t('retry')),
          );
        } else if (facts === null) {
          const statSkeleton = (index) => h('div', { key: 'skel-' + String(index), className: 'dsh-ls-stat' },
            h('div', { className: 'dsh-ls-skel dsh-ls-skel-label' }),
            h('div', { className: 'dsh-ls-skel dsh-ls-skel-statvalue' }),
            h('div', { className: 'dsh-ls-skel dsh-ls-skel-meta' }),
          );
          body = h('div', { 'aria-busy': true },
            h('div', { className: 'dsh-ls-hero' },
              h('div', { className: 'dsh-ls-heromain' },
                h('div', { className: 'dsh-ls-skel dsh-ls-skel-label' }),
                h('div', { className: 'dsh-ls-skel dsh-ls-skel-herovalue' }),
                h('div', { className: 'dsh-ls-skel dsh-ls-skel-meta' }),
              ),
              h('div', { className: 'dsh-ls-stat' },
                h('div', { className: 'dsh-ls-skel dsh-ls-skel-label' }),
                h('div', { className: 'dsh-ls-skel dsh-ls-skel-statvalue' }),
                h('div', { className: 'dsh-ls-skel dsh-ls-skel-meta' }),
              ),
              h('div', { className: 'dsh-ls-stat' },
                h('div', { className: 'dsh-ls-skel dsh-ls-skel-label' }),
                h('div', { className: 'dsh-ls-skel dsh-ls-skel-statvalue' }),
                h('div', { className: 'dsh-ls-skel dsh-ls-skel-meta' }),
              ),
            ),
            h('div', { className: 'dsh-ls-card', style: { marginTop: '12px' } },
              h('div', { className: 'dsh-ls-skel dsh-ls-skel-chart' }),
            ),
            h('div', { className: 'dsh-ls-rulehint', style: { marginTop: '8px' } },
              t('refreshing'),
              scanning === true && stats !== null && stats !== undefined
                ? ' · ' + t('scanning', { covered: stats.covered, total: stats.sessions })
                : '',
            ),
          );
        } else if (tab === 'rules') {
          body = h(RulesView, { rules: rules, facts: facts, t: t, onRules: saveRules, source: info.rulesSource, note: info.saveNote });
        } else if (bill.totals.calls === 0 && (stats === null || stats !== undefined && stats.covered === 0)) {
          body = h('div', { className: 'dsh-ls-card' },
            h('div', { className: 'dsh-ls-emptytitle' }, t('empty')),
            h('div', { className: 'dsh-ls-emptyhint' }, t('emptyHint')),
          );
        } else {
          body = h(BillView, {
            bill: bill,
            previous: previous,
            facts: facts,
            rules: rules,
            expanded: expanded,
            onToggle: setExpanded,
            activeSessionId: sessionId,
            onPickSession: pickSession,
            t: t,
          });
        }

        const footerParts = [];
        if (stats !== null && stats !== undefined) {
          footerParts.push(t('scanned', { sessions: stats.covered, subagents: stats.subagents }));
        }
        if (stats !== null && stats !== undefined && typeof stats.updatedAt === 'number' && stats.updatedAt > 0) {
          footerParts.push(t('updatedAt', { time: clockLabel(stats.updatedAt) }));
        }
        footerParts.push(t('netMeta', { date: PRICE_AS_OF }));
        if (bill.totals.localTokens > 0) footerParts.push(t('excludesPower'));
        const footer = h('div', { className: 'dsh-ls-footer' }, footerParts.map((text, index) => h('span', { key: 'foot-' + String(index) }, text)));

        const progress = scanning === true
          ? h('div', null,
            h('div', { className: 'dsh-ls-status', style: { paddingBottom: '4px' } }, t('scanning', { covered: stats.covered, total: stats.sessions })),
            h('div', { className: 'dsh-ls-progress' }, h('div', { className: 'dsh-ls-progressfill', style: { width: Math.round(Math.max(0.02, Math.min(1, coveredShare)) * 100) + '%' } })),
          )
          : null;

        return h('div', { className: 'dsh-ls', 'data-plugin': 'local-savings-page' },
          header,
          toolbar,
          sessionLine,
          exportLine,
          progress,
          body,
          footer,
        );
      };
    }

    /** Sidebar entry mark: the same coin as the dock pill, at rail size. */
    function PageIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' && props.size > 0 ? props.size : 16;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      },
        h('circle', { cx: 8, cy: 8, r: 6 }),
        h('path', { d: 'M5.6 5.2 8 8.4l2.4-3.2' }),
        h('path', { d: 'M8 8.4v4.4' }),
        h('path', { d: 'M5.9 9.8h4.2' }),
        h('path', { d: 'M5.9 11.6h4.2' }),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Stylesheet — hover, focus and motion the shipped pill also has      */
    /* ------------------------------------------------------------------ */

    const CSS = [
      '.dsh-local-savings-pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;max-width:100%;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;text-align:left;transition:background-color .12s ease,color .12s ease}',
      '@media (hover:hover){.dsh-local-savings-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}',
      '.dsh-local-savings-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dsh-local-savings-pill:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dsh-local-savings-pillLabel{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-local-savings-root{position:relative;display:inline-flex;min-width:0}',
      '.dsh-local-savings-panel{position:absolute;right:0;bottom:100%;z-index:30;width:280px;max-width:calc(100vw - 32px);margin-bottom:6px;padding:12px 14px 10px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:1.55;font-variant-numeric:tabular-nums;text-align:left;animation:dsh-local-savings-in .12s ease-out}',
      '@keyframes dsh-local-savings-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion:reduce){.dsh-local-savings-panel{animation:none}}',
      '.dsh-local-savings-headline{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:22px;letter-spacing:0}',
      '.dsh-local-savings-caption{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-local-savings-bar{display:flex;height:4px;border-radius:2px;overflow:hidden;gap:1px;margin:10px 0 4px;background:var(--dsw-alias-border-l2)}',
      '.dsh-local-savings-seg{background:var(--dsw-alias-label-primary)}',
      '.dsh-local-savings-row{display:flex;align-items:center;gap:7px;line-height:22px;min-width:0}',
      '.dsh-local-savings-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-primary)}',
      '.dsh-local-savings-label{color:var(--dsw-alias-label-tertiary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-local-savings-money{color:var(--dsw-alias-label-primary);white-space:nowrap;flex:none}',
      '.dsh-local-savings-divider{height:1px;background:var(--dsw-alias-border-l2);margin:8px 0 6px}',
      '.dsh-local-savings-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:4px}',
      '.dsh-local-savings-footer{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
    ].join('\n');

    function ensureStyle() {
      if (typeof document === 'undefined' || document === null) return;
      if (typeof document.getElementById !== 'function') return;
      const parent = document.head !== null && document.head !== undefined ? document.head : document.body;
      if (parent === null || parent === undefined) return;
      let style = document.getElementById(STYLE_ID);
      if (style === null) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        parent.appendChild(style);
      }
      // Always rewrite: a client-module hot reload must not keep a stale sheet.
      style.textContent = CSS + '\n' + PAGE_CSS;
    }

    /* ------------------------------------------------------------------ */
    /* Build the component                                                 */
    /* ------------------------------------------------------------------ */

    /**
     * 14 px optical mark: a coin. The ring is what separates the brand mark from
     * the currency symbol inside the amount beside it.
     */
    function CostIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true, focusable: false, style: { flex: 'none' } },
        h('circle', { cx: 7, cy: 7, r: 5.15, stroke: 'currentColor', strokeWidth: 1.15 }),
        h('path', { d: 'M4.9 4.5 7 7.2l2.1-2.7', stroke: 'currentColor', strokeWidth: 1.05, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M7 7.2v3.9', stroke: 'currentColor', strokeWidth: 1.05, strokeLinecap: 'round' }),
        h('path', { d: 'M5.2 8.4h3.6', stroke: 'currentColor', strokeWidth: 1.05, strokeLinecap: 'round' }),
        h('path', { d: 'M5.2 10h3.6', stroke: 'currentColor', strokeWidth: 1.05, strokeLinecap: 'round' }),
      );
    }

    const SEGMENT_OPACITY = [0.82, 0.5, 0.28, 0.16];

    function makeWidget() {
      return function LocalSavingsPill(props) {
        const lang = preferredLanguage();
        const dict = dictFor(lang);
        const t = (key, values) => {
          const template = dict[key] !== undefined ? dict[key] : DICTS.en[key];
          return format(template, values || {});
        };

        const state = React.useState(false);
        const open = state[0];
        const setOpen = state[1];
        const rootRef = React.useRef(null);

        React.useEffect(() => {
          if (!open || typeof document === 'undefined' || document === null) return undefined;
          const onPointerDown = (event) => {
            const root = rootRef.current;
            if (root !== null && root !== undefined && !root.contains(event.target)) setOpen(false);
          };
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false);
          };
          document.addEventListener('mousedown', onPointerDown, true);
          document.addEventListener('keydown', onKeyDown, true);
          return () => {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
          };
        }, [open]);

        const useProjection = typeof props.useProjection === 'function' ? props.useProjection : undefined;
        const usage = useProjection === undefined ? undefined : useProjection('tokenUsage');
        const selection = useProjection === undefined ? undefined : useProjection('modelSelection');

        let requests;
        try {
          requests = typeof props.useTrajectory === 'function'
            ? props.useTrajectory((snapshot) => (snapshot === null || snapshot === undefined ? undefined : snapshot.requests))
            : undefined;
        } catch {
          requests = undefined;
        }

        const totals = normalizeUsage(usage);
        if (totals === null) return null;

        const view = buildView(totals, selection, requests);
        if (view.tokens === 0) return null;

        const amountLabel = view.savedCny > 0 && view.spentCny > 0
          ? t('saved') + ' ' + shortMoney(view.savedCny) + ' · ' + t('spent') + ' ' + shortMoney(view.spentCny)
          : view.savedCny > 0
            ? t('saved') + ' ' + shortMoney(view.savedCny)
            : view.spentCny > 0
              ? t('spent') + ' ' + shortMoney(view.spentCny)
              : null;
        const tokensLabel = tokenText(view.tokens) + ' ' + t('tokensTok');
        const pillLabel = amountLabel === null ? tokensLabel : amountLabel;

        const pill = h('button', {
          type: 'button',
          className: 'dsh-local-savings-pill',
          'aria-expanded': open,
          'aria-haspopup': 'dialog',
          'aria-label': pillLabel + ' · ' + t('ariaHint'),
          onClick: () => setOpen(!open),
        },
          h(CostIcon, null),
          h('span', { className: 'dsh-local-savings-pillLabel' }, pillLabel),
        );

        if (!open) {
          return h('div', { ref: rootRef, className: 'dsh-local-savings-root', 'data-composer-stat': 'local-savings' }, pill);
        }

        const body = [];

        body.push(h('div', { key: 'headline', className: 'dsh-local-savings-headline' },
          amountLabel === null ? tokensLabel : amountLabel));

        const onlyRow = view.rows.length === 1 ? view.rows[0] : null;
        const modelName = onlyRow !== null && onlyRow.model !== '' ? onlyRow.model : t('modelCount', { count: view.rows.length });
        body.push(h('div', { key: 'caption', className: 'dsh-local-savings-caption' },
          modelName + ' · ' + tokensLabel));

        if (onlyRow !== null && onlyRow.priced) {
          const parts = [];
          const price = onlyRow.price;
          if (price !== null) {
            parts.push(t('official', { vendor: price.vendor }));
            const window = windowLabel(onlyRow, t);
            if (window !== '') parts.push(window);
          }
          if (parts.length > 0) {
            body.push(h('div', { key: 'subcaption', className: 'dsh-local-savings-caption' }, parts.join(' · ')));
          }
        } else if (view.pricedCount > 0) {
          body.push(h('div', { key: 'subcaption', className: 'dsh-local-savings-caption' }, t('officialGeneric')));
        } else {
          body.push(h('div', { key: 'subcaption', className: 'dsh-local-savings-caption' }, t('noPublishedPrice')));
        }

        if (view.composition.length > 0) {
          const total = view.composition.reduce((sum, entry) => sum + entry.amount, 0);
          const segments = [];
          const rows = [];
          for (let index = 0; index < view.composition.length; index += 1) {
            const entry = view.composition[index];
            const opacity = SEGMENT_OPACITY[Math.min(index, SEGMENT_OPACITY.length - 1)];
            segments.push(h('div', {
              key: 'seg-' + entry.key,
              className: 'dsh-local-savings-seg',
              style: { flexGrow: Math.max(entry.amount, total * 0.002), opacity },
            }));
            rows.push(h('div', { key: 'row-' + entry.key, className: 'dsh-local-savings-row' },
              h('span', { className: 'dsh-local-savings-dot', style: { opacity } }),
              h('span', { className: 'dsh-local-savings-label' }, t(entry.key)),
              h('span', { className: 'dsh-local-savings-money' }, money(entry.amount)),
            ));
          }
          body.push(h('div', { key: 'bar', className: 'dsh-local-savings-bar' }, segments));
          for (const row of rows) body.push(row);
        }

        if (view.approximate) {
          const tier = onlyRow !== null && onlyRow.price !== null ? onlyRow.price.label : '';
          body.push(h('div', { key: 'approximate', className: 'dsh-local-savings-note' },
            tier === '' ? t('approximateGeneric') : t('approximate', { tier })));
        }

        if (view.residualShare > 0.005) {
          body.push(h('div', { key: 'residual', className: 'dsh-local-savings-note' },
            t('residual', { pct: percentText(view.residualShare) })));
        }
        if (view.unpricedTokens > 0 && view.pricedCount > 0) {
          const share = view.unpricedTokens / Math.max(1, view.tokens);
          body.push(h('div', { key: 'unpriced', className: 'dsh-local-savings-note' },
            t('unpricedShare', { pct: percentText(share) })));
        }

        if (view.rows.length > 1) {
          body.push(h('div', { key: 'models-divider', className: 'dsh-local-savings-divider' }));
          const shown = view.rows.slice(0, 3);
          for (let index = 0; index < shown.length; index += 1) {
            const row = shown[index];
            body.push(h('div', { key: 'model-row-' + String(index), className: 'dsh-local-savings-row' },
              h('span', { className: 'dsh-local-savings-label' }, row.model === '' ? '—' : row.model),
              h('span', { className: 'dsh-local-savings-money' }, row.amount === null ? '—' : money(row.amount)),
            ));
          }
          if (view.rows.length > shown.length) {
            body.push(h('div', { key: 'model-rest', className: 'dsh-local-savings-note' },
              t('otherModels', { count: view.rows.length - shown.length })));
          }
        }

        const route = view.hasLocal && view.hasCloud
          ? t('routeMixed')
          : view.hasLocal
            ? t('routeLocal')
            : t('routeCloud');
        const footer = [t('priceAsOf', { date: PRICE_AS_OF })];
        if (view.hasLocal) footer.push(t('excludesPower'));
        if (view.converted) footer.push(t('fxNote', { rate: FX_CNY_PER_USD }));

        body.push(h('div', { key: 'footer-divider', className: 'dsh-local-savings-divider' }));
        body.push(h('div', { key: 'route', className: 'dsh-local-savings-footer' }, route));
        body.push(h('div', { key: 'price-note', className: 'dsh-local-savings-footer' }, footer.join(' · ')));

        return h('div', { ref: rootRef, className: 'dsh-local-savings-root', 'data-composer-stat': 'local-savings' },
          h('div', { className: 'dsh-local-savings-panel', role: 'dialog', 'aria-label': t('panelLabel') }, body),
          pill,
        );
      };
    }

    /* ------------------------------------------------------------------ */
    /* Error boundary                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * A render failure must not blank the dock: the message stays visible,
     * which is the only feedback a plain-JS plugin can count on there.
     */
    function withBoundary(Inner) {
      class Guard extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }

        static getDerivedStateFromError(error) {
          return { error };
        }

        render() {
          const state = this.state === null || this.state === undefined ? {} : this.state;
          if (state.error !== null && state.error !== undefined) {
            const message = typeof state.error.message === 'string' ? state.error.message : String(state.error);
            return h(
              'span',
              {
                className: 'dsh-local-savings-pill',
                style: { cursor: 'default', color: 'var(--dsw-alias-state-error-primary)' },
                title: message,
              },
              'local-savings: ' + message,
            );
          }
          return h(Inner, this.props);
        }
      }
      return Guard;
    }

    /* ------------------------------------------------------------------ */
    /* Plugin                                                              */
    /* ------------------------------------------------------------------ */

    const PANEL_ID = 'local-savings';

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle();

        const Widget = withBoundary(makeWidget());
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'local-savings', order: 2 },
            Widget,
          ),
        );

        const Page = withBoundary(makePage());
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, Page),
        );

        ctx.slots.inject('sidebar.panellist', () => {
          const label = () => {
            const dict = pageDict(preferredLanguage());
            return dict.title !== undefined ? dict.title : 'CostOps Hub';
          };
          return ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 21, label }, PageIcon);
        });
      },
    };
  },
});
