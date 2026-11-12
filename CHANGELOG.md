# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-11-12

### Added
- Chart readout: hover or focus any bucket to see that period's saved and spent amounts;
  edge buckets anchor the card inward, `Esc` closes it, every bucket is keyboard focusable
  with its amounts in the accessible name.

## [1.2.0] - 2026-11-12

### Added
- Narrow layouts: at ≤760 px the summary bar puts the net on its own row, hides the provider
  column and stacks the header; at ≤520 px all three cells stack and the toolbar wraps.

### Fixed
- Axis labels were clipped inside their bucket slots at narrow widths.
- The bills/rules tab strip stretched to the full page width once the header stacked.

## [1.1.0] - 2026-11-12

### Changed
- Redesigned the bill page: a three-cell summary bar leads with the net, the two model lists
  became one money-sorted table, the chart gained a peak label, a mid gridline and capped bars.
- The header description is one line; the long explanation moved to a tooltip.

### Fixed
- A duplicated dictionary key made the models card show the rules hint.
- The rules tab no longer opens with an empty toolbar strip.

## [1.0.0] - 2026-11-12

### Added
- Skeleton first paint instead of a blank "reading…" card.
- Cheap refresh protocol: the page asks for a 300-byte header first and only downloads the
  fact payload when the ledger moved; polling runs every 15 s and pauses while hidden.
- Keyboard support on the bills/rules tabs and `aria-live` status regions.

## [0.9.0] - 2026-11-12

### Added
- Session rows in the drill-down open that session's bill, with a link back to the current one.

## [0.8.0] - 2026-11-12

### Added
- Plugin Manager detail document with a 640×300 text-free illustration, in English and Chinese.
- `tools/detail-check.mjs` mirroring the Host's detail-resource rules.

## [0.7.0] - 2026-11-12

### Changed
- Route rules moved from a side file into the plugin's own configuration, written through the
  profile config editor. Headless profiles fall back to `rules.v1.json`, and the page states
  which source is in use.

## [0.6.0] - 2026-11-12

### Added
- "This session" window: the same three numbers for the conversation in front of you, with an
  honest note about how it relates to the live pill.

## [0.5.0] - 2026-11-12

### Added
- Per-session drill-down under each model, with session titles folded from the log while scanning.

## [0.4.0] - 2026-11-12

### Added
- Period-over-period comparison chips, CSV export of the current window, and a one-minute
  auto-refresh with a freshness line in the footer.

## [0.3.0] - 2026-11-12

### Added
- Cross-session ledger over session logs (facts only, budgeted backfill, fork de-duplication).
- Bill page: last hour / today / 7 days / 30 days, summary bar, trend, model lists, drill-down.
- Route rules tab: per-provider verdicts, model exceptions, sub-agent switch.
- Host HTTP route `/plugins/local-savings/api` with `facts`, `rules`, `export`, `reset`.

## [0.2.0] - 2026-11-12

### Changed
- Rebuilt the composer pill around a single claim, priced each request at the list price that
  applied when it ran, and reported both saved and spent amounts instead of hiding one.
- Renamed the bundle in the UI to 省流中台 / CostOps Hub.

## [0.1.0] - 2026-11-11

### Added
- First working pill: session tokens priced at official list prices, with a breakdown panel.
