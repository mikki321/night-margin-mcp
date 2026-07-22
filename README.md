# night-margin-mcp — Margin Engine

An MCP server that shows every pricing decision for a short-term rental portfolio **net of turnover costs**. Wheelhouse optimizes gross revenue (ADR, RevPAR) — this tool tells you what it costs to *produce* a night. The key metric: **net per available night**.

## Quick start

```bash
claude mcp add margin -- npx -y night-margin-mcp
```

That's it — **works with zero config on synthetic demo data**. Open Claude and ask:

> Where is my portfolio leaking money?

You'll get the leak figure, the net-per-night metric, and your best and worst properties in under a minute. When you're ready to run the analysis against *your own* Wheelhouse portfolio, see [Wheelhouse API key](#wheelhouse-api-key) below.

## Example prompts

The server provides seven tools: three read-only analysis tools and a four-tool decision loop (see [The decision loop](#the-decision-loop)). No dates needed — `analyze_portfolio` and `compare_strategies` default to the last 30 + next 90 days (recent turnovers + your booking horizon), `propose_decisions` to the next 30 days; pass `from`/`to` to change. Try these directly in Claude:

1. **`analyze_portfolio`** — where is the money leaking?
   > Where is my portfolio leaking money?

2. **`compare_strategies`** — gross vs. net in the same picture:
   > Compare two strategies for June 2026: (A) fill gap nights at a 40% discount and (B) raise the minimum stay to three nights with a 10% price increase. Which one delivers the better net per night?

3. **`gap_night_check`** — is a single gap night worth filling?
   > Property demo-1br-01 has a gap night on 2026-06-23. What's the floor price, and is the night worth filling?

4. **`propose_decisions`** — which upcoming nights are at risk of selling below cost?
   > Which gap nights are about to sell below my cost floor?

5. **`apply_decision`** — act on a proposal:
   > Apply decision d3

   Without explicit confirmation this is a **dry run**: it prints the exact rate payload that *would* be written and changes nothing. Prices change only when you confirm the write, and every applied decision can be undone with `revert_decision`.

The core message of the demo: **filling gaps at a discount can grow revenue while shrinking profit — a 2-night and a 7-night booking consume the same cleaning.**

## The decision loop

New in 0.3.0 — analysis turns into safe, reversible action:

1. **`propose_decisions`** finds upcoming gap nights (next 30 days by default) where the current price recommendation sits below your cost floor (turnover + travel + `MIN_MARGIN`) and proposes fixing those nights at the floor so they can't sell below cost. Proposals go into a local decision log — proposing never touches prices.
2. **`apply_decision`** writes one proposal to Wheelhouse as fixed custom rates — but only with explicit `confirm: true`. The default is a **dry run** showing the exact payload without writing anything. Before the first real write, the prior custom rates are snapshotted to the decision log, so **`revert_decision`** can always delete what was written and restore what was there before.
3. **`set_target`** stores a monthly gross revenue target per property; `analyze_portfolio` then reports progress toward any targets whose month overlaps the analysis window.

The safety model in one line: the analysis tools (`analyze_portfolio`, `compare_strategies`, `gap_night_check`) and `propose_decisions` never change any prices; writes happen only through `apply_decision`/`revert_decision` with an explicit `confirm: true`, always target the listing's own channel, and every write is revertible. Without a `WHEELHOUSE_API_KEY` you can run the whole loop up to the dry run on demo data — real writes require the key and a fresh propose against your own portfolio. The decision log and targets live locally in `NM_STATE_DIR` (default `~/.night-margin`).

## Configuration (env)

Every setting is optional — without them, the server runs the manual cost model on synthetic demo data. Environment variables are passed via `claude mcp add`'s `-e` flags:

```bash
claude mcp add margin -e WHEELHOUSE_API_KEY=xxx -e COST_SOURCE=csv -e CSV_PATH=/path/to/costs.csv -- npx -y night-margin-mcp
```

| Variable | Default | Description |
|---|---|---|
| `WHEELHOUSE_API_KEY` | – | Your own Wheelhouse integration key. When set, bookings are fetched from the Wheelhouse RM API; without it, synthetic demo data is used. |
| `WHEELHOUSE_CHANNEL` | – | Optional override for the `channel` parameter on Wheelhouse *read* calls (reservations, price recommendations). By default each listing's own `channel` field is used, which the API accepts. Writes (`apply_decision`) always go to the listing's own channel — this override never affects writes. |
| `COST_SOURCE` | `manual` | Source of turnover costs: `manual` \| `csv` \| `cleanhub`. |
| `AVG_TURNOVER_COST` | `70` | Manual mode: € per turnover (cleaning). Also serves as the fallback in CSV mode when a booking has no cost row. |
| `COST_TIERS` | – | Optional tiering, e.g. `1br:55,2br:70,3br:95` — matched against the property's `property_id` by substring; everything else gets `AVG_TURNOVER_COST`. |
| `CSV_PATH` | – | CSV mode: path to the cost CSV (required when `COST_SOURCE=csv`). See [CSV mode](#csv-mode). |
| `CLEANHUB_API_URL` / `CLEANHUB_TOKEN` | – | CleanHub mode: actual turnover costs from the CleanHub field-operations platform over HTTP (both required when `COST_SOURCE=cleanhub`). |
| `MIN_MARGIN` | `25` | Minimum margin € for the gap-night floor: floor = turnover + travel + `MIN_MARGIN`. Used in `gap_night_check`'s fill/skip verdict and in `propose_decisions`' floor proposals. |
| `NM_STATE_DIR` | `~/.night-margin` | Local state directory for the decision log and monthly targets (used by `propose_decisions`, `apply_decision`, `revert_decision`, `set_target`). Nothing is ever stored in the package directory. |

## CSV mode

If you know your actual turnover costs per booking, a CSV gives you the most accurate analysis. Schema (header row required):

```
reservation_id,property_id,checkin,checkout,nights,gross_revenue,cleaning_cost,travel_cost,laundry_cost,turnover_date,is_sunday_or_holiday
demo-1br-01-r1,demo-1br-01,2026-06-03,2026-06-10,7,571,56,16,9,2026-06-10,false
```

A synthetic sample file (887 rows, covering the full 2026 calendar year of the demo data) ships with the package at `examples/sample-costs.csv`, and can be downloaded directly:

```
https://raw.githubusercontent.com/mikki321/night-margin-mcp/main/examples/sample-costs.csv
```

Usage:

```bash
curl -o costs.csv "https://raw.githubusercontent.com/mikki321/night-margin-mcp/main/examples/sample-costs.csv"
claude mcp add margin -e COST_SOURCE=csv -e CSV_PATH="$PWD/costs.csv" -- npx -y night-margin-mcp
```

Cost rows are matched to bookings primarily by `reservation_id`, and secondarily by the composite key `property_id|checkin|checkout`. The tool response reports the attribution quality — e.g. "Cost attribution: 289/289 bookings matched by reservation_id", or with mixed sources "Cost attribution: 41 by reservation_id, 6 by composite key, 3 by average fallback (50 total)". If a row is missing and no `AVG_TURNOVER_COST` fallback is set, you get a clear error listing the affected bookings.

## Wheelhouse API key

Without a key, the server runs on synthetic demo data (and says so in every response). With a key, you get **your real bookings** from the Wheelhouse RM API: the server fetches your listings and reservations, and every metric is computed from your own portfolio.

- The key is your own Wheelhouse integration key (the API's `X-Integration-Api-Key` header). Get it from your Wheelhouse account's integration settings or from Wheelhouse support — API documentation: <https://api.usewheelhouse.com/wheelhouse_rm_api>.
- Pass it as an environment variable: `claude mcp add margin -e WHEELHOUSE_API_KEY=xxx -- npx -y night-margin-mcp`.
- **Never commit the key to git** — not in a `.env` file in the repo, not in README examples, not in commits. The key travels only as an environment variable.

If the key is invalid or the network flakes, the server returns a clear error with instructions — it does **not** silently fall back to demo data, so you'll never mistake mock numbers for your own.

## For developers

Local development:

```bash
npm install
npm test
npm run build
claude mcp add margin -- node "<repo path>/dist/index.js"
```

If the npm package doesn't work for any reason, the same server installs directly from GitHub:

```bash
claude mcp add margin -- npx -y github:mikki321/night-margin-mcp
```

### Exploring the Wheelhouse API with curl

Use these commands to verify auth and inspect response shapes (redact guest names/emails before sharing; field names and formats are preserved):

```bash
# 1) Listings — confirms auth + provides listing_id and channel
curl -s -H "X-Integration-Api-Key: $WHEELHOUSE_API_KEY" \
  "https://api.usewheelhouse.com/ss_api/v1/listings?per_page=5&page=1" | head -c 4000

# 2) Reservations — THE blocking one (full JSON for 2–3 reservations)
curl -s -H "X-Integration-Api-Key: $WHEELHOUSE_API_KEY" \
  "https://api.usewheelhouse.com/ss_api/v1/listings/<LISTING_ID>/reservations?channel=<CHANNEL>" | head -c 6000

# 3) Price recommendations — for gap_night_check, lower priority
curl -s -H "X-Integration-Api-Key: $WHEELHOUSE_API_KEY" \
  "https://api.usewheelhouse.com/ss_api/v1/listings/<LISTING_ID>/price_recommendations?channel=<CHANNEL>" | head -c 4000
```

The rate limit is 60 requests/min — the server runs requests serially and backs off on 429 responses (2 s / 4 s / 8 s).

## Core math

```
net_per_night  = (gross − cleaning − laundry − travel) / available nights
available      = booked nights + gap nights in the analysis window
gap_floor      = turnover cost + travel + MIN_MARGIN
leak           = Σ(€ of net-negative bookings) and % of booked nights
```

All data shipped with the repo and the package is synthetic — no real customer or property data is included.
