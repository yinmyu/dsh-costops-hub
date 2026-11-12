# DSH Client plugin API findings — `conversation.composer.dock`

Research target: how a browser-side (Client half) plugin rendering into the ambient list slot
`conversation.composer.dock` can reactively read (1) the active model/provider, (2) cumulative
session token usage, and (3) whether the provider is local/self-hosted.

Environment probed: DeepSeek Harness Desktop, packages version `0.2.2-rc.1`, profile `desktop`,
GUI `http://127.0.0.1:51767`.

---

## 0. Method note (important for anyone re-reading this)

**The shipped asar contains no `.d.ts` files.** I verified this by parsing the asar header and
enumerating all 22,105 entries: zero entries end in `.d.ts`. So type information had to be
recovered from three shipped sources that *do* carry declarations verbatim:

1. **Typert declaration registry** — `dsh-api-session-controller/lib/typert.host.js` embeds every
   Host/Client FaceModel type as an `export interface ...` string (and the zod wire schemas with the
   same JSDoc). This is the authoritative source for projection and model-selection types.
2. **Slot catalog** — `dsh-cordis-client-runner/lib/client.js` embeds `CLIENT_SLOT_API`, the exact
   data the Client `Slots` inspect provider serves: per-slot `kind`, `scope`, `registerOptions`,
   `standardProps`, `occupants`, `declaredBy`, `example`, `source` file/line.
3. **Shipped JS with JSDoc** — e.g. `dsh-token-meter/lib/types/usage-projection.js`,
   `dsh-api-session-controller/lib/types/client/sessions/projection-store.js`.

`bash`/`glob`/`grep` cannot read inside `app.asar`. Workaround used: a ~20-line Python reader that
parses the asar header (`16`-byte prefix + JSON directory) and extracts chosen entries to
`/tmp/dsh-asar/...`; then grep/sed work normally. The `read` tool also works directly on asar paths.
The two Client inspect providers (`Slots.listSubTree`, `Theme.listTokens`) **timed out on every
attempt** (page not connected), so the slot catalog and theme tokens below come from the shipped
bundles instead — which turned out to be strictly more informative.

---

## 1. Exact component registration code

Slot facts from the catalog (`CLIENT_SLOT_API`, entry `conversation.composer.dock`):

- `kind: "list"`, `scope: "session"`
- `registerOptions`: `id` (**required**, string), `order` (optional number, ascending, default 0),
  `label` (optional `string | (() => string)`)
- `replaceRisk: "none"` — a fresh `id` is *added beside* the shipped entries; reusing a shipped id
  (`activity`, `usage`) replaces that occupant.
- `declaredBy`: an entry in `conversation.composer.bar` (client-ui-conversation)
- `occupants`: `client-ui-chat ActivityPill id 'activity'`, `client-ui-chat UsagePill id 'usage'`
- Source of truth in the app: `packages/client/ui-conversation/src/client/contract/slots.ts:306`

The dock is only rendered when a real session composer exists — from
`dsh-client-ui-conversation/lib/client.js:22220`:

```js
variant === "composer" && input !== void 0 && sessionId !== void 0
  ? renderSlot("conversation.composer.dock", {})
  : null
```

### 1.1 Minimal, working client module (plain JS, `window.__ModuleLoader__`)

This is the shipped template form (`templates/decoration/client.js`) verbatim in structure —
`inject: ['slots']` **is required** (the harness injects the `slots` service before calling `apply`;
without it `ctx.slots` is undefined):

```js
window.__ModuleLoader__.load({
  id: '@local/local-token-savings',            // must equal the package name
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    function TokenPill(props) {
      const { useProjection } = props;
      const usage = useProjection('tokenUsage');
      const selection = useProjection('modelSelection');
      if (usage === undefined) return null;
      const model = selection?.lastUsed?.model ?? selection?.next?.model ?? '?';
      const total = usage.uncachedInputTokens + usage.cacheReadTokens
        + usage.cacheWriteTokens + usage.outputTokens;
      return h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
        model + ' · ' + total.toLocaleString() + ' tok');
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'local-token-savings',   // your own id: added beside activity(0)/usage(1)
          order: 2,                    // activity=0, usage=1 shipped; use >= 2
        }, TokenPill));
      },
    };
  },
});
```

Notes:

- `inject: ['slots']` is the *plugin-level* inject (array of service names) and `apply(ctx)` is the
  entry point. This matches the shipped `export` shape too: ui-chat's
  `lib/client.js:15267` has `const inject = ["slots", "sessions", "uiWorkspace", ...]` and
  `exports.inject = inject; exports.apply = apply;`. A dock-only plugin needs just `"slots"`.
- Ship this file as the package's `./client` export and declare it under `package.json`
  `"dsh": { "client": { "platform": "web", "inject": [...] } }`.
- `ctx.slots.inject(slotKey, factory)` only registers while the slot exists; the shipped code also
  uses a generator form when several registrations must be disposed together
  (`dsh-client-ui-chat/lib/client.js:15561`):

```js
ctx.slots.inject("conversation.composer.dock", function* () {
  yield ctx.slots.register({ name: "conversation.composer.dock", id: "activity", order: 0, locale: NS, inject: statPillInject }, ActivityPill);
  yield ctx.slots.register({ name: "conversation.composer.dock", id: "usage",    order: 1, locale: NS, inject: statPillInject }, UsagePill);
});
```

- `register` also accepts `locale` (a registered locale namespace → gives the component a `t`) and
  `inject` (a per-entry factory whose `hooks` become `use<Name>` props — see §4). A third-party
  plugin can ignore both and rely on the standard props.

### 1.2 Adding a control vs. replacing a shipped one

The owner's README states the replacement contract verbatim
(`dsh-client-ui-chat/README.md:78`):

> The composer statistics are two `conversation.composer.dock` list entries: `activity` (order 0,
> turn and step counts and output speed, with LLM time, tool time, and TTFT) and `usage` (order 1,
> token total and cache hit). … Another plugin replaces one control by registering the same id and
> the same `order`; the dock orders rows by `order`, while a lower `priority` picks the replacement:
> a dynamic plugin receives one automatically, and a statically composed plugin passes it explicitly.
> A new id adds a control. Each control carries its id in `data-composer-stat`.

So:

- **Add** a control: fresh `id` (`new id adds a control`), any `order` ≥ 2 to sit after the shipped
  pair. This is what the snippet above does.
- **Replace** `usage`: reuse `id: 'usage'` **and** `order: 1`, and rely on the automatic lower
  `priority` a dynamic plugin receives (no explicit `priority` needed for a
  `window.__ModuleLoader__` plugin).
- `data-composer-stat` is the attribute the shipped pills carry on their anchor `<span>`; reusing it
  is optional but keeps selector/consistent behavior.

Fixed overlays must portal to `document.body` — the composer is the containing block for
fixed-position descendants (`dsh-client-ui-conversation/README.md:108`):
"contributions to `conversation.composer`, `conversation.composer.bar`,
`conversation.composer.dock`, … must portal fixed overlays to the document body, for example with
`Tooltip` or `Menu` `portal` or `createPortal`".

---

## 2. Datum 1 — active model + provider

### 2.1 Hook and exact return type

Standard prop on this slot: **`useProjection`** (declared as `useProjection: UseProjection` in the
catalog for `conversation.composer.dock`). Call it with the projection key `"modelSelection"`.

Verbatim declaration (`dsh-api-session-controller/lib/typert.host.js:3388`):

```ts
export interface ModelSelectionProjection {
    readonly lastUsed: ModelSelection | null;
    readonly next: ModelSelection | null;
}
```

Verbatim `ModelSelection` (same registry, `:3380`):

```ts
export interface ModelSelection {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
```

Verbatim wire-schema JSDoc describing the two fields
(`dsh-api-session-controller/lib/typert.host.js:69-77`) — this is the only shipped prose on semantics:

```
'modelSelection': { lastUsed: { provider, model, reasoningEffort? } | null, next: ... | null }
  lastUsed : "Selection used by the latest recorded model request."
  next     : "Selection the next model step uses; null while the Agent's initial options supply the route."
  provider : "Registered provider route."
  model    : "Provider-owned model id."
  reasoningEffort : "Adapter-owned reasoning effort, or provider/default behavior when absent."
```

So for provider `local` / model `DeepSeek-V4.1-Flash-1017` you read
`useProjection('modelSelection').next` (what the composer would use next) or `.lastUsed`
(what was actually used); both are plain strings, no provider metadata attached.

The model-selection UI itself resolves the "current" selection as
`projected?.next ?? catalog.value?.default`
(`dsh-client-ui-model-selection/lib/client.js:951,968`), i.e. `next` is the composer's selection and
falls back to the catalog default when `next === null`.

```jsx
function ModelLine({ useProjection }) {
  const sel = useProjection('modelSelection');
  const provider = sel?.next?.provider ?? sel?.lastUsed?.provider;
  const model = sel?.next?.model ?? sel?.lastUsed?.model;
  if (provider === undefined) return null;
  return <span>{provider} / {model}</span>;
}
```

### 2.2 Reactivity

Yes. `useProjection` is a *keyed observable hook* materialized from the session-scope contribution
`dsh-client-ui-session/lib/client.js:752-765`:

```js
const BUILTIN_SOURCE = {
  hooks: ["session"],
  keyedHooks: ["projection"],
  props: ["sessionId"],
  resolve: (binding) => ({
    hooks: { session: binding.session },
    keyedHooks: { projection: (key) => binding.session.projections.faceOf(key) },
    props: { sessionId: binding.sessionId },
  }),
};
```

`faceOf(key)` returns an identity-stable `{ getSnapshot, subscribe }` face backed by
`ProjectionValueStore` (`dsh-api-session-controller/lib/types/client/sessions/projection-store.js`),
which notifies on every accepted Host frame. The renderer binds it with
`observableHook(...)`/`useSyncExternalStore`, so a new pushed value re-renders your component.
The value updates when a model request is recorded or a selection is made.

### 2.3 "Is this provider local/self-hosted?" — **NOT directly exposed**

This is the one datum with no shipped field. What exists:

- `ModelSelectionProjection` → provider id string only (no URL, no kind).
- `ModelCatalog` / `ModelCatalogModel` (catalog fetched by
  `ctx.remote.session.modelCatalog()`, see `dsh-client-ui-model-selection/lib/client.js:753`):

```ts
export interface ModelCatalog {
    readonly default: ModelSelection;
    readonly routableProviders: readonly string[];
    readonly groups: readonly ModelProviderGroup[];
    readonly failures: readonly ModelCatalogFailure[];
}
export interface ModelProviderGroup {
    readonly id: string;
    readonly name: string;
    readonly models: readonly ModelCatalogModel[];
}
export interface ModelCatalogModel {
    readonly id: string; readonly name: string; readonly description?: string;
    readonly reasoning?: ModelReasoning; readonly badge?: LlmModelBadge;
}
```

  No `baseURL`, no `kind` — only `id` (provider route) and `name`.
- Host-side `LlmProviderInfo` is only `{ id, name }` too.
- The only place a URL exists is `LlmConfigurableProvider`
  (Host Service `llm.listConfigurableProviders()`, `@Remote`):
  `{ provider, displayName, settingsNs, settingsPath, declared?, defaultBaseURL?, baseURLEnv?, nativeAuth?, error? }`
  — note `defaultBaseURL`, not the actually-configured endpoint.

**But the browser can call the `llm` remote namespace.** Confirmed: `dsh-client-ui-settings-models`
does exactly this (`lib/client.js:1471-1472`, with the comment "`llm/listProviders` joined with
`llm/listConfigurableProviders`"):

```js
const [registered, declared] = await Promise.all([
  this.ctx.remote.llm.listProviders(),
  this.ctx.remote.llm.listConfigurableProviders(),
  this.describeFace.ensure(),
]);
```

and it reads configured values (the real `baseURL`) out of the settings document via
`ctx.remote.settings` (same file, `:3295` comment and `:3309
ctx.remote.settings.mutate(...)`). Both namespaces must be declared in the plugin's
`dsh.client.inject`.

Practical options, in ascending cost:

1. **Heuristic (recommended for a pill).** Your `local` provider is a plain user-configured route
   (profile patch `id: llm-pi-ai`, `providers.local.baseURL: http://192.168.20.113:8080/v1`,
   `displayName: local`). Treat a provider as local when the catalog group name/id matches
   `/^(local|localhost|ollama|lm-?studio|vllm|llama)/i` or the id is not one of the known cloud
   routes (`deepseek-account`, `deepseek-official`, …). Zero extra wiring, no network.
2. **`ctx.remote.llm.listConfigurableProviders()`** → find `provider === sel.next.provider`, read
   `defaultBaseURL`/`baseURLEnv`; classify the URL (localhost / RFC1918 / not public). Caveat: it is
   the provider's *declared default*, not the configured instance value.
3. **Host half** reading `ctx.llm` / the provider config and publishing the answer (e.g. as its own
   session projection or a chat row). This is the only exact answer; see §7.

---

## 3. Datum 2 — cumulative session token usage

### 3.1 Hook and exact return type

Standard prop **`useProjection`**, key `"tokenUsage"`.

Verbatim declaration (`dsh-api-session-controller/lib/typert.host.js:4012`):

```ts
export interface TokenUsageProjection {
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
```

Verbatim wire description (`typert.host.js:157-162`):
`"Provider-reported usage accumulated across the complete durable log."`

The producing projection unit (`dsh-token-meter/lib/types/usage-projection.js`) confirms semantics:

- `key: 'tokenUsage'`, `stateVersion: 2`
- state = `{ totals: {uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}, last: {turn, step, buckets} | null }`
- `wire: { viewSchema: projectionSchema, view: state => state.totals }` — **the value you read is the
  session-wide cumulative total**
- folds `assistant/message` and `assistant/attempt` events with a `usage` sample; a retry
  (`llm/retry-started`) removes the replaced attempt's contribution (`addReplacing`), so retries do
  not double-count.
- `init: () => ({ totals: zeroBuckets(), last: null })`

Derivation helpers used by the shipped pill (`dsh-client-ui-chat/lib/client.js:9535`):

```js
function billedInputTokens(usage) {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}
// total = billedInputTokens(usage) + usage.outputTokens
// cacheHit% = cacheReadTokens / billedInputTokens (see cacheHitPercent)
```

Minimal component usage:

```jsx
function UsageLine({ useProjection }) {
  const usage = useProjection('tokenUsage');       // undefined until the first provider usage sample
  if (usage === undefined) return null;
  const billedInput = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const total = billedInput + usage.outputTokens;
  return (
    <span>
      in {usage.uncachedInputTokens} · cacheR {usage.cacheReadTokens} · cacheW {usage.cacheWriteTokens}
      {' · '}out {usage.outputTokens} · total {total}
    </span>
  );
}
```

### 3.2 Reactivity

Yes, for the same mechanism as §2.2: the Host pushes a new `tokenUsage` view whenever the fold
changes, the `ProjectionValueStore` row updates and notifies, and the bound
`useSyncExternalStore` face re-renders your component. Expect a re-render per provider usage sample
(i.e. per assistant settlement), not per streamed token.

Note: the store may also seed from a *cached* persisted value
(`applyCached`/`seed` in `projection-store.js`), so a freshly opened session can show a total before
the live stream arrives.

### 3.3 Per-model breakdown — **not available from any projection**

`TokenUsageProjection` has no model dimension, and `TokenUsage` itself
(`{ inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`)
carries no provider/model either. The usage samples that feed it do not persist a model key.

If per-model attribution is required, the only shipped client-visible source is the trajectory
inspection, which *does* keep provider/model next to usage per request. Standard prop
**`useTrajectory`** (declared on this slot) returns the trajectory snapshot; its
`.requests` rows are built like this (`dsh-client-ui-trajectory/lib/client.js:9208-9250`):

```js
const provider = request?.providerMetadata?.provider ?? node?.providerMetadata?.provider;
const model = request?.providerMetadata?.model ?? node?.providerMetadata?.model;
...
numbered.push({
  seq, turn, step, group, number, status,
  ...{ startedAt, completedAt, error, errorCode, resultSeq, retry, maxRetries, retryDelayMs },
  ...provider === undefined ? {} : { provider },
  ...model === undefined ? {} : { model },
  ...usage === undefined ? {} : { usage },                 // {input?, cacheRead?, cacheWrite?, output?, reasoning?}
  ...cumulativeUsage === void 0 ? {} : { cumulativeUsage } // running fold, same bucket names
});
```

with `requestUsage` mapping `inputTokens→input, cacheReadTokens→cacheRead, cacheWriteTokens→cacheWrite,
outputTokens→output, reasoningTokens→reasoning` (`:9112`). The snapshot also has `eventNodes`,
`eventLocations`, `runningCalls`, `callSchemas`.
So: `useTrajectory((s) => s.requests)` then group by `provider + '/' + model` and sum `usage`. Caveats:
this is a heavier surface, it is request-grained (a session that switched models mid-way is
attributable), and the snapshot is only populated while the trajectory source is live. Also note
trajectory rows exclude `purpose === "compaction"` requests from the numbered assistant list (the
compaction rows are pushed separately), so a sum over assistant rows will not necessarily equal
`tokenUsage` totals.

---

## 4. The shipped `usage` occupant — exact implementation

**Owner:** `@deepseek-ai/dsh-client-ui-chat` (not token-meter, not session-stats — those are Host
projection units). Registering code, `dsh-client-ui-chat/lib/client.js:15560-15575`:

```js
const statPillInject = () => ({ hooks: { performanceUsage } });

ctx.slots.inject("conversation.composer.dock", function* () {
  yield ctx.slots.register({
    name: "conversation.composer.dock", id: "activity", order: 0,
    locale: NS, inject: statPillInject,
  }, ActivityPill);
  yield ctx.slots.register({
    name: "conversation.composer.dock", id: "usage", order: 1,
    locale: NS, inject: statPillInject,
  }, UsagePill);
});
```

`performanceUsage` is a chat-settings preference — values `PERFORMANCE_USAGE_MODES = ["compact", "detailed"]`,
`DEFAULT_PERFORMANCE_USAGE = "detailed"` (`dsh-client-ui-chat/lib/index.js:41,43`, registered as a
volatile setting at `lib/index.js:51`) — exposed to the entry as the hook `usePerformanceUsage` (the
framework turns `hooks: { x }` into the prop `useX`). `"compact"` renders only the cache-hit reading;
`"detailed"` renders the token total plus a portaled dialog.

**`UsagePill` reads exactly one datum** — the `tokenUsage` projection — plus that display preference
(`:9690`):

```js
const UsagePill = memo(function UsagePill({ useProjection, usePerformanceUsage, t }) {
  const mode = usePerformanceUsage((value) => value);
  const usage = useProjection("tokenUsage");
  if (usage === void 0 || billedInputTokens(usage) === 0 && usage.outputTokens === 0) return null;
  const cacheHit = cacheHitPercent(usage);
  ...
  const total = billedInputTokens(usage) + usage.outputTokens;   // headline number
  // dialog rows: cacheHit%, "input" → usage.uncachedInputTokens,
  //              "cacheRead" → usage.cacheReadTokens,
  //              "cacheWrite" → usage.cacheWriteTokens (row hidden when 0),
  //              "output" → usage.outputTokens
});
```

`ActivityPill` (`:9652`) is the sibling at order 0 and reads a *different* projection,
`useProjection("sessionStats")` (turns/steps/llmMs/toolMs/ttft), falling back to
`deriveStats(useChat((s) => s.legacy.nodes))`.

So the built-in example is exactly the pattern you want: standard prop `useProjection` + key
`"tokenUsage"`, no service injection, no network, reactive.

---

## 5. Styling: theme tokens vs inline styles

Plain inline styles are acceptable and are the low-risk default; the shipped primitive chrome uses
CSS variables, so matching the surrounding UI is just a matter of referencing the same variables in
`style` (e.g. `style={{ color: 'var(--dsw-alias-label-tertiary)' }}`). No stylesheet registration is
required — the dock slot allocates flow space and the composer does not clip inline content, but any
*fixed* overlay must portal to `document.body` (catalog doc for this slot says so explicitly).

Verbatim CSS of the shipped dock pill, for visual parity
(`dsh-client-ui-chat/lib/client.js:9436`, class prefix `TQ0rwa_`):

```css
.TQ0rwa_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}
.TQ0rwa_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.TQ0rwa_pill svg{flex:none;width:14px;height:14px}
button.TQ0rwa_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
button.TQ0rwa_pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.TQ0rwa_label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.TQ0rwa_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}
```

Tokens confirmed present in the shipped theme package
(`dsh-client-ui-theme/lib/client.js`; the Client `Theme.listTokens` provider could not be reached):

| Purpose | Token |
|---|---|
| Primary text | `--dsw-alias-label-primary` |
| Secondary text | `--dsw-alias-label-secondary` |
| Tertiary/dimmed text (what the pills use) | `--dsw-alias-label-tertiary` |
| Caption / dimmed | `--dsw-alias-label-caption`, `--dsw-alias-label-dimmed` |
| Border (level 1..4) | `--dsw-alias-border-l1`, `--dsw-alias-border-l2`, `--dsw-alias-border-l3`, `--dsw-alias-border-l4` |
| Separator | `--dsw-alias-separator-primary` |
| Background surface | `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1/-2/-3`, `--dsw-alias-bg-module-platform`, `--dsw-alias-bg-overlay` |
| Hover / interactive background | `--dsw-alias-interactive-bg-hover`, `--dsw-alias-interactive-bg-active` |
| Radius | `--dsw-radius-xs`, `--dsw-radius-sm`, `--dsw-radius-md`, `--dsw-radius-lg`, `--dsw-radius-xl`, `--dsw-radius-panel` |
| Font family | `--dsw-font-family`, `--dsw-font-family-brand` |
| Font sizes | `--dsw-font-xxxs-11-font-size`, `--dsw-font-xxs-12-font-size`, `--dsw-font-xs-13-font-size`, `--dsw-font-s-14-font-size`, `--dsw-font-base-16-font-size`, `--dsw-font-m-18-font-size`, `--dsw-font-l-20-font-size`, `--dsw-font-xl-24-font-size` |
| State colors | `--dsw-alias-state-error-primary`, `--dsw-alias-state-warn-label`, `--dsw-alias-state-business-primary` |
| Elevation | `--dsw-elevation-soft`, `--dsw-elevation-panel`, `--dsw-elevation-prominent`, `--dsw-elevation-stroke-color` |
| Focus ring | `--dsw-focus-ring-color` |
| Content font knobs used by the pill | `--dsh-content-font-size-secondary`, `--dsh-content-font-delta-secondary` |

The theme is light/dark switchable, so hardcoded hex colors will not follow the app theme; the
variables above are the supported path.

---

## 6. Full standard-prop surface for this slot (verified)

From the slot catalog entry for `conversation.composer.dock` (`standardProps`, verbatim strings):

```
useRemoteAccess: (action: RemoteEndpoint) => boolean
useResource: UseResource
useContextMenu: UseContextMenu
useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
usePanelInfo: UsePanelInfo
useSessions: UseSessions
useSessionStatus: UseSessionStatus
useSessionRetainInfo: UseSessionRetainInfo
useSessionAccess: (sessionId: SessionId, action: RemoteEndpoint) => boolean
useWorkspaceAccess: (workspaceId: WorkspaceId, action: RemoteEndpoint) => boolean
useChat: UseChat
useConversation: UseConversation
useInput: SnapshotSelectorHook<InputState>
inputActions: InputActions
useSession: SessionSnapshotSelector
sessionId: SessionId
useProjection: UseProjection
useAccess: (action: RemoteEndpoint) => boolean
useTrajectory: UseTrajectory
```

These are handed to **every** occupant of the slot regardless of registrant (the renderer
materializes them from the root + session scope bindings —
`dsh-client-ui-renderer/lib/client.js:681-712`, `standardProps()`/`materializeStandardBinding()`), so
a third-party plugin does not need to inject any service to get `useProjection`, `useSession`,
`useTrajectory`, `sessionId`.

`useSession` snapshot contents (for completeness — it has **no** model or usage field). Recovered
from the live snapshot builder `dsh-api-session-controller/lib/types/client/sessions/session.js:846`
(the `.d.ts` for it is type-only/erased):

```js
buildSnapshot() {
  return {
    sessionId, pendingSubmissions, running, subagent, removed,
    openState, openError, hasMore, loadingOlder, promptError,
    blank, lastAgentError, promptAttempted, awaitingFirstTurn,
  };
}
```

So model and usage must come from `useProjection`, not `useSession`.

---

## 7. Risks / unknowns (not confirmable from shipped artifacts)

1. **No shipped `.d.ts`.** All types above are reconstructed from the typert registry strings, the
   slot catalog, and JSDoc in built JS. `UseProjection`, `UseTrajectory`, `SessionSnapshotSelector`,
   `UseChat` are *named* in the catalog but their declarations are not present anywhere in the asar
   (grep for `UseProjection` finds only the catalog strings). Their behaviour was established by
   reading the implementations instead. A signature-strict consumer should not rely on the alias
   names as types.
2. **`useProjection` overloads.** It is a *keyed* hook: `useProjection(key)` returns the value for
   that key and is not typed against a key→type map in the browser bundle. Passing an unknown key
   silently returns `undefined` rather than throwing.
3. **Per-model attribution needs `useTrajectory`**, which is a heavier snapshot and excludes
   compaction-purpose requests from its numbered rows; a per-model sum will not necessarily
   reconcile with `tokenUsage` totals. `tokenUsage` itself is model-agnostic by construction.
4. **Local-ness is not modelled.** No client-visible field says "local". Available signals:
   provider id/name strings, `ctx.remote.llm.listConfigurableProviders()` (declared
   `defaultBaseURL`/`baseURLEnv`, not the configured endpoint), and the settings document through
   `ctx.remote.settings`. The exact answer requires a Host half reading `ctx.llm`/provider config.
   `ctx.remote.llm` reachability is inferred from `dsh-client-ui-settings-models` calling it, not
   from a Client Service inspect response (the page was unreachable).
5. **Client inspect providers unavailable during research.** `Slots.listSubTree` and
   `Theme.listTokens` returned `Client inspect query ... timed out after 10000ms` on every attempt
   ("Open or reconnect the Harness page"). The catalog/standardProps and theme token lists above
   were recovered from the shipped bundles instead; a live re-check is advisable if the page
   reconnects (`cordis_inspect_query` platform `client`, provider `Slots`/`Theme`).
6. **`order` collisions**: shipped occupants are `activity` (order 0) and `usage` (order 1). Pick a
   fresh `id` and `order >= 2`; reusing an id replaces that occupant (`replaceRisk: none` for new
   ids but "shadows-shipped-ui" semantics apply when an id collides).
7. **`usePerformanceUsage` is not a standard prop** — it only exists because ui-chat's own
   registration injects it. A third-party plugin cannot read that preference unless it injects the
   same hook source or its own config; don't count on it.
8. **Compaction/context**: `contextPressure` and `contextBreakdown` projections exist and are
   readable (`contextWindow`, `pressureTokens`, `projectedTokens`) if the pill ever needs a
   context-window meter; not required for token totals.

---

## 8. Exact paths read (caller can re-read; use the `read` tool — bash cannot read inside asar)

Root: `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/`

| Path | Why |
|---|---|
| `dsh-cordis-client-runner/lib/client.js` (`:2607` `CLIENT_SLOT_API`, `:3306-3355` the composer-dock entry) | slot catalog: kind/scope/registerOptions/standardProps/occupants/example/source |
| `dsh-client-ui-chat/lib/client.js` (`:15560-15580` registration, `:9690` `UsagePill`, `:9652` `ActivityPill`, `:9436` pill CSS, `:9535` `billedInputTokens`, `:15267` inject list) | the built-in `usage` occupant |
| `dsh-client-ui-conversation/lib/client.js` (`:22941` `registerComposerBar` + `:22996` dock child decl, `:22220` renderSlot, `:22900-23095` composer-bar inject) | who declares the slot and when it renders |
| `dsh-api-session-controller/lib/typert.host.js` (`:69-77` modelSelection wire, `:157-162` tokenUsage wire, `:3380-3392` ModelSelection/Projection, `:3352-3362` ModelCatalog*, `:4012` TokenUsageProjection, `:3713` SessionProjectionMap) | verbatim type declarations + JSDoc |
| `dsh-api-session-controller/lib/types/client/sessions/projection-store.js` | `faceOf/get/subscribe`, reactivity and cached-baseline semantics |
| `dsh-api-session-controller/lib/types/client/sessions/session.js` (`:846` `buildSnapshot`) | `useSession` snapshot fields |
| `dsh-token-meter/lib/types/usage-projection.js` | `tokenUsage` fold, `wire.view = totals`, retry replacement |
| `dsh-token-meter/lib/types/index.js`, `dsh-token-meter/lib/index.js` (`:395`) | projection registration |
| `dsh-client-ui-session/lib/client.js` (`:752-765` `BUILTIN_SOURCE`) | `useSession`/`useProjection`/`sessionId` binding |
| `dsh-client-ui-renderer/lib/client.js` (`:681-712` `standardProps`, `:720-760` `standardKit`) | how standard props reach occupants |
| `dsh-client-ui-model-selection/lib/client.js` (`:753` catalog load, `:951-975` next/lastUsed usage) | model catalog source and selection semantics |
| `dsh-client-ui-trajectory/lib/client.js` (`:9112` `requestUsage`, `:9208-9250` per-request provider/model/usage rows, `:9583` `trajectory` hook source) | per-model breakdown source |
| `dsh-client-ui-settings-models/lib/client.js` (`:1471` `remote.llm.listProviders/listConfigurableProviders`, `:3295`, `:5398` inject) | proof the `llm` remote namespace is browser-callable |
| `dsh-client-ui-theme/lib/client.js` | theme token names |
| `dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js` | canonical `window.__ModuleLoader__` registration template |
| `dsh-agent-preset/skills/cordis-plugin-development/references/ui-plugin.md` | plugin authoring rules for this slot |

Working copies extracted for grep during research: `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai/...`
(regenerable; extract with a small Python asar reader — 16-byte header, JSON directory, offsets).

Profile config showing the `local` provider (plain YAML, readable with bash):
`/Users/ivanyin/.dsh/profiles/desktop/cordis.patch.yml` — `id: llm-pi-ai`,
`providers.local: { displayName: local, api: openai-completions, baseURL: http://192.168.20.113:8080/v1 }`,
and `agent-default-model: { provider: local, model: DeepSeek-V4.1-Flash-1017, reasoningEffort: max }`.
---

## 9. Live verification, 2026-11-12 (DSH Desktop 0.2.x, profile `desktop`)

A temporary probe was rendered inside the dock pill itself (the client module hot-reloads within a
few seconds) to read the real trajectory shape. Findings that differ from §3.3 above:

```jsonc
// useTrajectory(s => s.requests) — one row, observed keys:
{
  "purpose": "assistant",              // every row in the sampled session
  "startSeq": 1234, "turn": 2, "step": 1,
  "startedAt": 1794392133805,          // epoch ms — usable for historical pricing
  "completedAt": 1794392278757,        // epoch ms
  "status": "…", "resultSeq": 41,
  "providerMetadata": { "provider": "local", "model": "DeepSeek-V4.1-Flash-1017" },
  "usage": { "inputTokens": 306720, "outputTokens": 4337, "totalTokens": 311057 }
  // later rows also carry "cacheReadTokens"; the aggregate tokenUsage buckets
  // (uncachedInputTokens / cacheReadTokens / cacheWriteTokens / outputTokens)
  // are what the session fold reports, not what every single row carries.
}
```

- **`provider`/`model` are not top-level fields in this build** — they live in
  `providerMetadata`, which matches how ui-chat itself reads it
  (`request?.providerMetadata?.provider ?? node?.providerMetadata?.provider`). A plugin that reads
  `request.provider` directly sees nothing and silently falls back to the selection projection.
- 87 of 88 sampled rows carried `providerMetadata`; 85 carried `cacheReadTokens`.
- `startedAt` is epoch **milliseconds**, so a contribution can be priced in the window it ran in
  instead of at "now". This is what makes the savings figure stable across a peak boundary.
- Summing request rows does **not** always equal the `tokenUsage` totals (compaction, retries,
  not-yet-loaded history). Any residual has to be priced separately and declared.
- Client-module edits are picked up by the running window without a reload when the profile links the
  bundle directory. An injected `<style>` element is *not* replaced by that mechanism, so a plugin
  that styles itself should rewrite its stylesheet text on every `apply`.

## 10. The bill page surfaces (2026-11-12, same build)

The cross-session page needed three APIs the pill never touched. All three were
verified against the installed build before use.

### 10.1 `ctx.sessionQuery` — reading history without touching zstd

`@deepseek-ai/dsh-session-query` is mounted through the SQLite backend row
(`session-query-sqlite`) and provides Host service `sessionQuery`:

```js
const corpus = await ctx.sessionQuery.listSessions()   // [{ header, live, persisted, formatStatus? }]
const snap = await ctx.sessionQuery.readSession(id)     // { session, inheritedEventCount, events }
```

- `listSessions()` merges live and persisted sessions, newest first; the
  session header is `{version, id, createdAt, cwd?, parentSession?, isSeeded,
  origin?, delegationDepth?, agentPreset?}`. There is **no** `updatedAt`; file
  `mtime` from `sessionPersistence.list().location.path` is the activity signal.
- `readSession()` returns the complete, replay-validated raw log and prefers a
  live snapshot, so the open session reads as current without flushing.
- `inheritedEventCount` is the fork prefix: `events.slice(inheritedEventCount)`
  is the set this session owns. Without that slice a forked session bills its
  source's usage twice.
- Decoding (multi-frame zstd), format migration (v3→v4) and replay validation
  are inside the service. A plugin that unzips logs itself re-implements all
  three and breaks on the next format bump.

### 10.2 Where the usage attribution lives in a raw event

The one fact that decides the whole ledger — provider and model per settled
request — is on the event, not on any projection:

```jsonc
{
  "type": "assistant/message", "seq": 42, "time": 1794446408097,
  "data": {
    "usage": { "inputTokens": 2655, "outputTokens": 203,
               "cacheReadTokens": 49024, "cacheWriteTokens": 0, "totalTokens": 51882 },
    "message": { "role": "assistant",
                 "source": { "kind": "model", "provider": "local",
                             "model": "DeepSeek-V4.1-Flash-1017", "replayState": { … } } }
  }
}
```

- `usage.inputTokens` is **uncached** input: the four buckets sum exactly to
  `totalTokens` in every sampled row.
- `message.source` is `{kind: "model", provider, model}` for a normal assistant
  message; other kinds exist, so a reader must check `kind`.
- `request/header` is **not** per step (6 headers for 135 assistant messages in
  one sampled session), which is why pairing headers to messages is the wrong
  algorithm; `model/selection` is per change, not per request either.

### 10.3 Adding a full page: `sidebar.panellist` + `main`

One registration pair is enough, and it needs no session binding:

```js
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'local-savings' }, Page))
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register({ name: 'sidebar.panellist', id: 'local-savings', order: 21, label }, Icon))
```

- `main` is keyed and root-scoped; `keyDomain` says only `conversation` is
  taken, so a fresh key is safe. `sidebar.panellist` addresses `main` by the
  same `id`, and `label` may be a thunk so a locale change re-projects without
  re-registering.
- Session-scoped data (`useProjection`, `useTrajectory`, `useSessions`) is
  available on `main` too, but this page needs none of it.
- The slot renders the component as-is: no iframe, theme tokens and locale
  apply, and `withBoundary` around the component keeps a render failure from
  blanking the panel.

### 10.4 Transport: a same-origin route

`ctx.webServer.register({ kind: 'exact', path, handler })` plus
`fetch(path, { credentials: 'same-origin' })` is the sanctioned transport for a
plain-JS bundle client (no `host.call` RPC on that path). Notes that cost time:

- Requests pass the connection fence: `connection.requestRejection(req)`
  returns `403` for a foreign Host/Origin and `401` without the browser cookie,
  so a bare `curl` against the route **always** answers 401. Verification has to
  go through the page, not through curl.
- The handler must not block the event loop: decompressing tens of megabytes of
  logs in one turn freezes the app window. The ledger yields (`setImmediate`)
  between sessions and stops at a wall-clock budget, answering with progress.
- `ctx.effect(() => ctx.webServer.register(...))` removes the route on unload;
  a duplicate path throws, so the route path is a composition-level contract.

### 10.5 Client-module reload vs Host-half reload

`client.js` is watched (`dsh-client-hmr`, 500 ms) and re-executed in the open
window; `index.js` is loaded once by the Cordis loader. A Host change needs the
plugin row reloaded (Plugins page, disable/enable) or a window reload, and every
client-module reload remounts the UI, which resets the selected main panel back
to the conversation.

### 10.6 Two client-side facts worth keeping

- **The panel resets on every client-module reload.** `dsh-client-hmr` re-executes
  the bundle and remounts the plugin, so the root-scoped `main` selection falls
  back to the conversation. While a session is streaming, the app also follows
  that session back to its conversation. A screenshot of a plugin page has to be
  taken within a second or two of opening it; that is a verification constraint,
  not a bug in the page.
- **`ctx.webServer` requests can be replayed from a script** by minting the same
  v1 cookie the browser holds: `secret` from
  `<DSH_HOME>/.credentials.yaml` → `records['client-connection/browser-session'].payload.secret`,
  payload `{version, authority: "host:port", issuedAt, expiresAt}`, signature
  `base64url(HMAC-SHA256(secretBytes, base64url(payload)))`, cookie name
  `dsh-auth-` + `base64url(SHA-256(authority))`. That is how the export op and
  the rules round-trip were verified without driving the UI.

### 10.7 Session titles come from the log, not from the header

The session header has no title; a `session/title` event carries it:

```jsonc
{ "type": "session/title", "seq": 12, "time": 1794444962430,
  "data": { "title": "省钱计算token插件打磨", "messageSeqs": [12], "source": { "kind": "provider", … } } }
```

The latest such event wins, so a title-following plugin shows up as a later event
without any extra call. Folding it while scanning a log costs nothing; asking the
Host (`sessionQuery.readTitle`) would re-read the same log again.

### 10.8 The client session store (`useSessions`)

`main` is root-scoped, so it has no `sessionId`; the session to summarise comes
from the session store:

```js
useSessions((state) => {
  // state.byId[id] = { id, title?, cwd?, updatedAt, blank, running, retainedBy: { mainView: n, … } }
  const retained = Object.values(state.byId).find((s) => (s.retainedBy.mainView ?? 0) > 0);
  return retained?.id ?? …most recent updatedAt…;
});
```

`retainedBy.mainView > 0` is the session the conversation panel holds; the
browser-title code in `client-ui-layout` uses the same predicate. It can be empty
while a global panel is open (the conversation unmounted), so the page falls back
to the newest `updatedAt` — and, in the ledger, to the session with the latest
fact row.

## 11. Moving rules into the plugin's own configuration

The route rules used to live in a side file (`rules.v1.json`). They now live in
the plugin row's `config`, which the profile patch owns.

### 11.1 Reading it

`apply(ctx, config)` receives the row config after the Loader validates it (with
no `Config` export, it is passed through unchanged). Fields are read as plain
values, but the row can also be edited by hand in
`~/.dsh/profiles/<name>/cordis.patch.yml`:

```yaml
- id: local-savings
  name: "@local/dsh-local-savings"
  config:
    version: 1
    includeSubagents: true
    providers: {}
    models: {}
```

### 11.2 Writing it

```js
const entry = ctx.fiber.entry
const editor = ctx.get('configEditor')
await editor.edit(entry, (current) => ({ ...current, providers, models }))
```

The editor validates the candidate (`fiber.resolveConfig`), serialises with other
profile writes and rewrites the profile patch. An ordinary field has Loader's
normal lifecycle: **the plugin restarts**. Measured live: the route answered in
50 ms with `source: "config"` and the restarted plugin then read the same rules
back from its row — so the HTTP response survives the restart. The page still
re-reads the rules once on a lost response before reporting failure.

### 11.3 Why there is no `Config` schema (and no Settings form)

A bundle installed by link resolves its bare imports from its own directory, not
from the profile or the dsh installation:

```
$ node -e "import('@deepseek-ai/schemastery')"   # inside the bundle dir
ERR_MODULE_NOT_FOUND … imported from /Users/ivanyin/dsh-plugins/local-token-savings
```

`export const Config` is read at module load, so a failed import would make the
whole plugin fail to load — no fallback is possible. Declaring a schema also
buys the volatile-field protocol (`~standard`, `meta.volatile`, cosmokit
references), which is exactly what the Settings page's auto-generated forms and
the no-restart path require. Hence this bundle keeps its rules in plain row
config, edits them through the config editor, and renders its own form in the
bill page. A bundle installed *inside* the profile (or one that ships a copy of
the schema library) could add the schema later without changing the wire
contract.

### 11.4 Fallback

A profile without `configEditor` or without a Loader entry (headless runs) keeps
writing `rules.v1.json`; `GET/POST ?op=rules` report `source: "config" | "file"`
so the page can say where the rules actually are. On the first successful config
write the legacy file is renamed to `rules.v1.json.migrated`.

### 10.9 What a linked bundle cannot import (and what that costs)

Two separate features were blocked by the same fact: a bundle installed by link
resolves bare imports from its own directory, not from the profile or the dsh
installation, and the plugin's module is imported by realpath.

```
$ node -e "import('@deepseek-ai/schemastery')"     # inside the bundle dir
ERR_MODULE_NOT_FOUND … imported from /Users/ivanyin/dsh-plugins/local-token-savings
```

Consequences measured here:

- `export const Config` (schemastery + volatile) is impossible without vendoring
  the library, because the export is evaluated at module load and a failed
  import fails the whole plugin. Rules therefore live in plain row config.
- `ctx.storageDomain` + `defineDomain(...)` + `domainTable(...)` are equally out
  of reach, so the ledger keeps its own atomic JSON file under
  `<DSH_HOME>/storages/local-savings/` instead of the storage service.

A bundle installed *inside* the profile (a real directory, not a link) has the
profile's `node_modules` on its resolution path and can adopt both.

### 10.10 A cheap refresh protocol between the page and its route

The page polls while it is visible. Re-sending half a megabyte of fact rows every
15 seconds for a ledger that did not move is wasteful, so the route reports
whether the last refresh wrote anything:

```jsonc
// stats of GET /plugins/local-savings/api?op=facts&rows=0
{ "sessions": 78, "covered": 78, "pending": 0, "changed": true, "scanning": false, … }
```

The page asks for `rows=0` first (≈300 bytes), and fetches the full payload only
when `changed` is true (or on the very first load). Measured on the live host:
probe 296 B, full payload 454 KB. The same call is skipped entirely while
`document.visibilityState === 'hidden'`, so a background tab costs nothing.
