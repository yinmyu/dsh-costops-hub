# LLM API list-price research for a "money saved by running locally" calculator

- **Retrieval date (all tables): 2026-11-11** (Asia/Shanghai)
- **Method:** official vendor pricing pages only. Every price below is copied from the URL in its row; nothing is taken from aggregators, resellers or model-comparison sites.
- **Units:** all prices are **per 1,000,000 tokens** (per MTok), as published by the vendors.
- **Purpose:** map a locally served open-weight model id (provider id `local`, `http://192.168.20.113:8080/v1`) to the official API list price of its nearest commercial counterpart, so the app can show `tokens_used × list_price` as "money saved".

---

## 0. Currency and exchange rate — read this first

| Item | Value |
| --- | --- |
| DeepSeek official currency | **CNY** on the Chinese pricing page (`api-docs.deepseek.com/zh-cn/...`), **USD** on the English page (`api-docs.deepseek.com/quick_start/pricing`). Both are official and both are reproduced below. |
| Zhipu / BigModel official currency | **CNY** ("元/百万 Tokens"). No USD list price could be fetched from `z.ai` (the host refused the connection on 2026-11-11); `z.ai/pricing` is a client-rendered SPA that returns no text. |
| Qwen (Alibaba Cloud Model Studio) official currency | **USD** on the international doc set used here; the China-mainland Bailian plan publishes CNY and differs. |
| Moonshot / Kimi official currency | **USD** on `platform.kimi.ai`, **CNY** on `platform.kimi.com`. |
| **USD→CNY rate used for the derived USD columns below** | **6.67 CNY per USD** |
| Rate source & date | European Central Bank euro foreign-exchange reference rates, `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`, publication date **2026-11-10**: EUR/USD 1.1214, EUR/CNY 7.4801 ⇒ **USD/CNY = 7.4801 / 1.1214 = 6.6703**. Rounded to 6.67. |

Cross-check on that rate: DeepSeek publishes the *same* Flash tier in both currencies, and the Flash column implies exactly **6.6667 CNY/USD** (2 CNY ↔ $0.30; 1 ↔ $0.15; 0.04 ↔ $0.006; 0.02 ↔ $0.003; 4 ↔ $0.60; 8 ↔ $1.20), i.e. within 0.05 % of the ECB cross. **Caveat:** DeepSeek's *V4-Pro* column is internally inconsistent with its own Flash column — it implies **6.818 CNY/USD** (9 CNY ↔ $1.32, 27 ↔ $3.96). Treat each vendor column as authoritative in its own currency; do not assume one global FX rate inside a vendor's own table.

---

## 1. DeepSeek

Official source (CNY): <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
Official source (USD, same tables): <https://api-docs.deepseek.com/quick_start/pricing>
Retrieved: **2026-11-11**.

Current API model names are `deepseek-flash` and `deepseek-v4-pro` only. `deepseek-chat` and `deepseek-reasoner` were retired on **2026-07-24** (change log, <https://api-docs.deepseek.com/updates>).

### 1a. CNY list prices (official, as published)

| Model id (official) | Model version served | Input — cache **miss** | Input — cache **hit** | Output | Currency | Source URL | Retrieved |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `deepseek-flash` — **peak** | DeepSeek-V4.1-Flash-1017 | 2 元 | 0.04 元 | 8 元 | CNY | <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/> | 2026-11-11 |
| `deepseek-flash` — **off-peak** | DeepSeek-V4.1-Flash-1017 | 1 元 | 0.02 元 | 4 元 | CNY | <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/> | 2026-11-11 |
| `deepseek-v4-pro` — **peak** | DeepSeek-V4-Pro-0813 | 9.0 元 | 0.30 元 | 27.0 元 | CNY | <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/> | 2026-11-11 |
| `deepseek-v4-pro` — **off-peak** | DeepSeek-V4-Pro-0813 | 4.5 元 | 0.15 元 | 13.5 元 | CNY | <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/> | 2026-11-11 |
| `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` (legacy, still accepted) | routed to DeepSeek-V4.1-Flash-1017 | billed at the Flash price above | same | same | CNY | <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/> (footnote 1) | 2026-11-11 |

### 1b. USD list prices (official, as published)

| Model id (official) | Input — cache **miss** | Input — cache **hit** | Output | Currency | Source URL | Retrieved |
| --- | --- | --- | --- | --- | --- | --- |
| `deepseek-flash` — peak | $0.30 | $0.006 | $1.20 | USD | <https://api-docs.deepseek.com/quick_start/pricing> | 2026-11-11 |
| `deepseek-flash` — off-peak | $0.15 | $0.003 | $0.60 | USD | <https://api-docs.deepseek.com/quick_start/pricing> | 2026-11-11 |
| `deepseek-v4-pro` — peak | $1.32 | $0.044 | $3.96 | USD | <https://api-docs.deepseek.com/quick_start/pricing> | 2026-11-11 |
| `deepseek-v4-pro` — off-peak | $0.66 | $0.022 | $1.98 | USD | <https://api-docs.deepseek.com/quick_start/pricing> | 2026-11-11 |

### 1c. Timing rules, effective dates, announced changes

- **Peak/off-peak scheme is live and is the only discount.** Peak = 01:00–04:00 and 06:00–10:00 **UTC**, Monday–Friday, excluding Chinese public holidays (Beijing time 09:00–12:00 and 14:00–18:00). Everything else, including all weekends and Chinese public holidays, is off-peak and is billed at **exactly half** the peak rate. Sources: footnote (2) on both pricing pages, and change log 2026-08-13 ("new prices will take effect at 16:00 (UTC) on August 16, 2026").
- **No announced future price change.** The most recent pricing-relevant notice is change log 2026-10-17: "The API calling method and **pricing remain unchanged**" with the DeepSeek-V4.1-Flash-1017 upgrade (<https://api-docs.deepseek.com/updates>). The 2026-09-10 entry announced a *reduction* that is already reflected in the table above.
- Concurrency ceilings (not prices, but they affect what "official" service you are comparing against): 2500 for Flash, 500 for V4-Pro.
- DeepSeek reserves the right to change prices; the page carries no future-dated price announcement as of 2026-11-11.

---

## 2. Zhipu / GLM (智谱 BigModel)

Official source: <https://docs.bigmodel.cn/cn/guide/start/pricing> (machine-readable Markdown mirror: `https://docs.bigmodel.cn/cn/guide/start/pricing.md`)
Retrieved: **2026-11-11**. All figures below are the official **CNY** list prices ("元/百万 Tokens"); the USD column is **derived at 6.67**, not published by Zhipu.

| Model id (official) | Context / tier | Input — **miss** | Input — **hit** | Output | Currency | USD equivalent @6.67 | Source URL | Retrieved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GLM-5.3` | 1M, flat | 8 元 | 2 元 | 28 元 | CNY | $1.20 / $0.30 / $4.20 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-5.3-Flash` | 1M, multimodal | 0.8 元 | 0.23 元 | 2.8 元 | CNY | $0.12 / $0.034 / $0.42 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-5.3-FlashX` | 1M | 2 元 | 0.57 元 | 7 元 | CNY | $0.30 / $0.085 / $1.05 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-5.3-FlashX-Legal` | 1M | 2 元 | 0.57 元 | 7 元 | CNY | $0.30 / $0.085 / $1.05 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-5.2` | 1M | 8 元 | 2 元 | 28 元 | CNY | $1.20 / $0.30 / $4.20 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-5.1` | input [0,32K) | 6 元 | 1.3 元 | 24 元 | CNY | $0.90 / $0.195 / $3.60 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-5.1` | input ≥32K | 8 元 | 2 元 | 28 元 | CNY | $1.20 / $0.30 / $4.20 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-5-Turbo`, `GLM-5V-Turbo` | input [0,32K) | 5 元 | 1.2 元 | 22 元 | CNY | $0.75 / $0.18 / $3.30 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-5-Turbo`, `GLM-5V-Turbo` | input ≥32K | 7 元 | 1.8 元 | 26 元 | CNY | $1.05 / $0.27 / $3.90 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-5` | input [0,32K) | 4 元 | 1 元 | 18 元 | CNY | $0.60 / $0.15 / $2.70 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-5` | input ≥32K | 6 元 | 1.5 元 | 22 元 | CNY | $0.90 / $0.225 / $3.30 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-4.7` | in [0,32K), out <0.2K | 2 元 | 0.4 元 | 8 元 | CNY | $0.30 / $0.06 / $1.20 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-4.7` | in [0,32K), out ≥0.2K | 3 元 | 0.6 元 | 14 元 | CNY | $0.45 / $0.09 / $2.10 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-4.7` | in [32K,200K) | 4 元 | 0.8 元 | 16 元 | CNY | $0.60 / $0.12 / $2.40 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-4.7-FlashX` | 200K | 0.5 元 | 0.1 元 | 3 元 | CNY | $0.075 / $0.015 / $0.45 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-4.7-Flash` | 200K | 免费 | 免费 | 免费 | — | $0 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-4.5-Air` | in [0,32K), out <0.2K | 0.8 元 | 0.16 元 | 2 元 | CNY | $0.12 / $0.024 / $0.30 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-4.5-Air` | in [32K,128K) | 1.2 元 | 0.24 元 | 8 元 | CNY | $0.18 / $0.036 / $1.20 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |
| `GLM-4.6V` | in [0,32K) | 1 元 | 0.2 元 | 3 元 | CNY | $0.15 / $0.03 / $0.45 | <https://docs.bigmodel.cn/cn/guide/start/pricing> | 2026-11-11 |

Notes that matter for a savings figure:

- **Cache storage is currently free** ("限时免费") across the board; do not model a storage charge.
- **Batch API = 50 % of the standard price** for supported models — ignore unless the app compares against batch, not real-time, prices.
- **GLM-4.6 (text) is no longer on the price list.** Only the vision model `GLM-4.6V` remains priced. There is no official CNY row for text GLM-4.6 on 2026-11-11, so any GLM-4.6 mapping is an assumption (see §6).
- The current top of the stack is GLM-5.3 / 5.3-Flash / 5.3-FlashX; GLM-5.2, 5.1, 5-Turbo and 5 are still listed and priced.

---

## 3. Qwen (Alibaba Cloud Model Studio / 百炼)

Official source: <https://www.alibabacloud.com/help/zh/model-studio/model-pricing> (page states "更新时间：Nov 07, 2026")
Retrieved: **2026-11-11**. Prices are **USD** as printed on that page, for the international/Singapore deployment; the China-mainland plan and the HK/EU/US deployments are priced differently.

| Model id (official) | Tier | Input — **miss** | Input — **hit** | Output | Currency | Source URL | Retrieved |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `qwen3.8-max` | 0<Token≤1M | $2.00 | 10 % of input (§ below) | $6.00 | USD | <https://www.alibabacloud.com/help/zh/model-studio/model-pricing> | 2026-11-11 |
| `qwen3.7-max` | 0<Token≤1M | $2.50 | 10 % of input | $7.50 | USD | <https://www.alibabacloud.com/help/zh/model-studio/model-pricing> | 2026-11-11 |
| `qwen3.8-flash` | 0<Token≤1M | $0.15 | 10 % of input | $0.47 | USD | <https://www.alibabacloud.com/help/zh/model-studio/model-pricing> | 2026-11-11 |
| `qwen3.7-flash` | 0<Token≤32K | $0.030 | 10 % of input | $0.130 | USD | <https://www.alibabacloud.com/help/zh/model-studio/model-pricing> | 2026-11-11 |
| `qwen3.7-flash` | 32K<Token≤256K | $0.100 | 10 % of input | $0.400 | USD | <https://www.alibabacloud.com/help/zh/model-studio/model-pricing> | 2026-11-11 |
| `qwen-max` | China mainland, no tiering | $0.345 | — | $1.377 | USD | <https://www.alibabacloud.com/help/zh/model-studio/model-pricing> | 2026-11-11 |

- No per-model cache-hit **number** is published in that table; the same document states cache hits are billed at **10 % of the standard input price** and explicit-cache creation at 125 %. Derived hit prices are therefore 10 % of the miss price. The JSON records `inputHitPerMTok: null` for Qwen rather than baking in a derived number.
- Current generation on that page is qwen3.8 / 3.7 / 3.6 / 3.5; plain `qwen3`-prefixed ids still resolve to the nearest named tier.

---

## 4. Moonshot / Kimi — **prices could not be confirmed from the official page**

Official source: <https://platform.kimi.ai/docs/pricing/chat> (also `platform.kimi.com` for the CNY/China edition)
Retrieved: **2026-11-11** — **no numbers extracted.**

The official price tables on this page are rendered client-side. Every non-browser variant of the page returns an **empty** `<table></table>` in the exact place the prices belong:

- `https://platform.kimi.ai/docs/pricing/chat` → headings and prose, no table rows
- `https://platform.kimi.ai/docs/pricing/chat.md` → `<table><thead><tr /></thead><tbody /></table>`
- `https://platform.kimi.ai/docs/pricing/batch.md` → same empty table
- `https://platform.kimi.ai/docs/llms-full.txt` → truncated before the pricing section

What the official page **does** state (usable as structure, not as prices):

- K3 series (`kimi-k3.1-pro`, `kimi-k3`, `kimi-k3.1-pro-highspeed`): 1,048,576-token context, **flat** pay-as-you-go pricing with no context-length tiering; billable items are cache **write** (separate 5 min and 1 h TTL tiers), input (separate cache-hit and cache-miss rates) and output.
- `kimi-k3.1-pro` / `kimi-k3` support the Batch API at **60 %** of the standard price.
- K2 series (`kimi-k2.7-code`, `kimi-k2.6`) has 262,144-token context and is being retired at the **end of December 2026**; new registrations were closed 2026-10-31.
- Model list: <https://platform.kimi.ai/docs/models>

**Recommendation:** leave Kimi prices `null` in `pricing-source.json` (they are, as shipped). Do not substitute a third-party aggregator figure into a table that claims official sourcing; fill them in from a browser session on the pricing page, or from the Kimi billing API, when convenient.

---

## 5. Mapping the three configured local model ids

Local provider is `local` / `http://192.168.20.113:8080/v1`. The ids below are matched **case-insensitively** against the `match` arrays in `pricing-source.json`, most specific rule first, and **vendor-scoped** (a DeepSeek rule is only tested against ids that a DeepSeek/vendor detector has already routed to the deepseek family — do not run all rules against all ids, or `flash` will match unrelated models).

| Local model id | Recommended official counterpart | Input miss | Input hit | Output | Basis | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| `DeepSeek-V4.1-Flash-1017` | `deepseek-flash` (model version *DeepSeek-V4.1-Flash-1017*) | 2 元 / $0.30 (peak) · 1 元 / $0.15 (off-peak) | 0.04 元 / $0.006 (peak) · 0.02 元 / $0.003 (off-peak) | 8 元 / $1.20 (peak) · 4 元 / $0.60 (off-peak) | **Exact official match.** The vendor's own "MODEL VERSION" field for `deepseek-flash` is literally `DeepSeek-V4.1-Flash-1017`, and the weights were open-sourced the same day | Certain |
| `GLM-5.3-Flash-EXL3` | `GLM-5.3-Flash` | 0.8 元 ($0.12) | 0.23 元 ($0.034) | 2.8 元 ($0.42) | Tier match on `glm-5.3-flash`; `-EXL3` is an **ExLlamaV3 quantisation tag**, not a Zhipu model | **Fuzzy** — same family/tier, locally quantised |
| `glm-5.3` | `GLM-5.3` | 8 元 ($1.20) | 2 元 ($0.30) | 28 元 ($4.20) | Exact id match (case-insensitive, no suffix) | Certain |

### Concrete matching rules (ordered, lowercased inputs)

```text
# vendor detection first, then in-order rules; first hit wins
deepseek  ->  /deepseek|deepseek[-_ ]?(v4|chat|reasoner|coder|flash|pro)|^ds-/
zhipu     ->  /(^|[-_ ])glm|(^|[-_ ])chatglm|bigmodel/
qwen      ->  /(^|[-_ ])qwen|tongyi|dashscope/
moonshot  ->  /kimi|moonshot/

"DeepSeek-V4.1-Flash-1017".toLowerCase() = "deepseek-v4.1-flash-1017"
  -> deepseek v4.1-flash-1017  ->  row 1  (peak/off-peak split applies)
"GLM-5.3-Flash-EXL3".toLowerCase() = "glm-5.3-flash-exl3"
  -> zhipu "glm-5.3-flash"     ->  row 2  (EXL3 suffix ignored)
"glm-5.3".toLowerCase() = "glm-5.3"
  -> zhipu "glm-5.3"           ->  row 3
```

**Ordering hazards that will silently mis-price if ignored:**

1. `glm-5.3-flash` contains `glm-5.3`. The Flash row **must** be tested before the flagship row, otherwise a local `GLM-5.3-Flash-EXL3` is priced at 28 元/M output instead of 2.8 元/M — a **10×** over-statement of savings.
2. `glm-5.3` contains `glm-5`. All `glm-5.x` rows must precede the bare `glm-5` row, and `glm-4.5-air` must precede `glm-4.5`.
3. `deepseek-v4.1-flash-1017` contains both `deepseek-v4.1` and `flash`; the specific row must win so that a future Flash price change is not silently applied to V4-Pro or vice versa.
4. Quantisation / packaging suffixes that must be stripped or ignored before matching: `-exl3`, `-exl2`, `-awq`, `-gptq`, `-int4`, `-int8`, `-fp8`, `-q4_k_m`, `-gguf`, `-mlx`, `-nf4`, `-bnb`, `-distill`, `-instruct`, `-0613`-style date stamps (keep the date stamp for DeepSeek — `1017` is part of the official version string — and drop it for GLM).
5. Local ids sometimes carry a server prefix (`lmstudio/`, `ollama/`, `local/`). Strip everything up to the last `/` before matching.

---

## 6. Assumptions, fuzzy matches and what is *not* official

| Item | Status |
| --- | --- |
| `DeepSeek-V4.1-Flash-1017` → `deepseek-flash` | **Not an assumption.** Official model-version string, official price. |
| `glm-5.3` → `GLM-5.3` | **Not an assumption.** Id matches the published model id. |
| `GLM-5.3-Flash-EXL3` → `GLM-5.3-Flash` | **Assumption.** Zhipu prices no quantised variants; a self-hosted EXL3 quant is *not* bit-identical to the served API model, and Zhipu's Flash tier is multimodal/faster than a typical local EXL3 deployment. Reasonable, but it is a same-family mapping, not an official price for that exact artifact. |
| Text **GLM-4.6** mapping | **Assumption.** Not on the current price list; mapped to the GLM-4.7 base tier (2 / 0.4 / 8 CNY) as nearest priced successor. `GLM-4.6V` *is* still priced (1 / 0.2 / 3 CNY) and is mapped separately. |
| Non-Air **GLM-4.5** mapping | **Assumption**, mapped to the GLM-4.7 base tier; only `GLM-4.5-Air` and `GLM-4.5V` remain on the list. |
| Generic `deepseek` / `glm` / `qwen` fallbacks | **Assumptions**, deliberately set to the *cheapest* current tier of the family so the calculator under-states rather than over-states savings. |
| Context-length tiering (GLM-5.1/5-Turbo/5, GLM-4.7, qwen-flash) | A token-counter cannot know the per-request input length. The tables above list every bucket; the JSON picks the **cheapest** bucket and says so in `notes`. Long-context sessions will therefore under-state savings. |
| Peak vs off-peak (DeepSeek) | The JSON stores **peak/standard** list prices (the headline list price). Off-peak is exactly half. Because peak is only 09:00–12:00 and 14:00–18:00 Beijing time on weekdays, most real usage is billed off-peak, so a peak-based figure **over-states** savings for typical domestic evening/night use by up to 2×. If you want a single honest headline number, either (a) label the figure "at peak list price", or (b) halve it and label "off-peak list price". |
| Cache hit vs miss | The app cannot generally distinguish cached from uncached local prompt tokens. Default to the **cache-miss** price (higher, i.e. savings over-stated slightly) and only use the hit price when the local server reports a cache/prompt-caching field. |
| Kimi prices | **Not official, because not readable.** See §4. |
| z.ai USD prices for GLM | **Not confirmed** — connection refused 2026-11-11; the BigModel CNY page is the primary official source and is used instead. USD figures for GLM here are *derived*, and flagged as such. |

---

## 7. Implementation notes for the savings calculator

1. **Never hard-code savings as a percentage.** Compute `sum over token types (tokens × price) / 1e6` from the vendor row that matched, so a vendor price change is a one-line JSON edit.
2. **Record the matched rule id** (e.g. `zhipu/glm-5.3-flash`) alongside the figure, and surface it in the UI tooltip ("priced against GLM-5.3-Flash, official list price, retrieved 2026-11-11"). This makes fuzzy mappings auditable rather than magical.
3. **Show the retrieval date and a "list price" caveat** next to the currency symbol. The DeepSeek page itself warns that "product prices may vary and DeepSeek reserves the right to adjust them".
4. **Treat unmatched ids as "no estimate", not zero.** A missing row should render "—", never "$0.00 saved", which reads as "local inference is worthless".
5. **Keep `usdCnyRate` dated.** It is 6.67 @ 2026-11-10 (ECB). Any CNY→USD display should carry the rate and its date, and be refreshed on the same cadence as the price table.
6. **Do not model tax.** Kimi states prices exclude applicable taxes; DeepSeek and Zhipu publish list prices without a tax statement. Adding VAT/GST would make the "saved" figure non-comparable to the vendors' own pages.

---

## Addendum — 2026-11-11, three local models confirmed

The user plans to serve `GLM-5.3`, `GLM-5.3-Flash` and `Qwen3.8-27B` on the same local endpoint. All
three now have an exact official tier in the plugin's table; the numbers below were re-read from the
official pages on 2026-11-11 and replace the earlier "assumption" labels for these ids.

| Local id | Official tier used | Input (cache miss) | Input (cache hit) | Cache write | Output | Currency / 1M |
|---|---|---|---|---|---|---|
| `GLM-5.3` | GLM-5.3 | 8 | 2 | 8 (bills as miss) | 28 | CNY |
| `GLM-5.3-Flash` | GLM-5.3-Flash | 0.8 | 0.23 | 0.8 (bills as miss) | 2.8 | CNY |
| `Qwen3.8-27B` | qwen3.8-27b, 华北2（北京） | 0.424 | 0.085 | 0.53 (explicit cache creation) | 1.696 | USD |

Sources: [bigmodel 定价](https://docs.bigmodel.cn/cn/guide/start/pricing.md) (the `最新模型` table lists
GLM-5.3 at 8 / 28 / 2 and GLM-5.3-Flash at 0.8 / 2.8 / 0.23, cache storage 限时免费) and
[qwen3.8-27b 模型信息](https://www.alibabacloud.com/help/zh/model-studio/qwen3-8-27b) (the Beijing table
also publishes explicit cache creation 0.53 and explicit cache hit 0.042).

Notes that matter for the calculator:

- **Zhipu publishes no per-token cache-write price** — storage is free for now, so cache-write tokens are
  priced as cache-miss input, which is how Zhipu bills cache creation today.
- **Model Studio is region-priced.** The Singapore deployment of qwen3.8-27b is 0.5 / 0.1 / 3 / 0.625,
  roughly 18% higher on input and 77% higher on output. The plugin uses the Beijing figures; switch the
  row's numbers if the local deployment should be compared against the international price list.
- **Artifact suffixes do not change the tier.** `GLM-5.3-Flash-EXL3`, `Qwen3.8-27B-Instruct-AWQ` and
  `GLM-5.3-EXL3` are the same weights as the official service, so the plugin strips `-instruct`,
  `-chat`, `-base`, `-it`, `-awq`, `-gptq`, `-exl2`, `-exl3`, `-gguf`, `-int4/-int8/-fp8/-fp16/-bf16`,
  `-4bit/-8bit` and quantisation tags like `-q4-k-m` before deciding that an id is an exact match. Only a
  genuinely unrecognised id still shows the "closest official tier" notice.
